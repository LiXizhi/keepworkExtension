use super::main_window::run_on_window_thread;
use super::state::AppCore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, watch};
use url::Url;

#[cfg(any(target_os = "macos", windows))]
mod bluetooth;
pub(super) mod remote_input;
#[cfg(any(target_os = "macos", windows, test))]
mod protocol;

const LABEL: &str = "bumi-control";
const PAGE: &str = "bumi-control.html";
#[cfg(not(any(target_os = "macos", windows)))]
const UNSUPPORTED: &str = "Bumi 蓝牙控制需要 macOS 或 Windows 桌面版。";

#[derive(Default)]
pub(super) struct Control {
    window: Mutex<Option<watch::Sender<()>>>,
    #[cfg(any(target_os = "macos", windows))]
    bluetooth: tokio::sync::Mutex<bluetooth::Bluetooth>,
    #[cfg(any(target_os = "macos", windows))]
    attempts: Mutex<ConnectionAttempts>,
    #[cfg(any(target_os = "macos", windows))]
    remote: Mutex<remote_input::Sessions>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(super) enum Request {
    Status,
    Scan {
        #[serde(rename = "attemptId", default)]
        attempt_id: Option<String>,
    },
    Connect {
        id: String,
        #[serde(rename = "attemptId", default)]
        attempt_id: Option<String>,
    },
    CancelConnection {
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    Disconnect,
    Listen { enabled: bool },
    Send {
        command: Command,
        #[serde(rename = "remoteCaptureId", default)]
        remote_capture_id: Option<u64>,
    },
}

// The BLE mutex serializes work. Cancellation has a separate lock so it can
// interrupt an in-flight scan or GATT setup while that mutex is held.
#[cfg(any(target_os = "macos", windows))]
#[derive(Default)]
struct ConnectionAttempts {
    active: Option<(String, watch::Sender<()>)>,
    cancelled: std::collections::VecDeque<String>,
}

#[cfg(any(target_os = "macos", windows))]
impl ConnectionAttempts {
    fn start(&mut self, id: &str) -> Result<watch::Receiver<()>, String> {
        if self.cancelled.iter().any(|previous| previous == id) {
            return Err("已取消连接。".into());
        }
        let (stop, receiver) = watch::channel(());
        self.active = Some((id.to_owned(), stop));
        Ok(receiver)
    }

    fn cancel(&mut self, id: &str) {
        if self.active.as_ref().is_some_and(|(active, _)| active == id) {
            self.active = None;
        }
        // IPC can deliver cancel before scan/connect, or between those phases.
        if !self.cancelled.iter().any(|previous| previous == id) {
            if self.cancelled.len() == 32 {
                self.cancelled.pop_front();
            }
            self.cancelled.push_back(id.to_owned());
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(super) enum Command {
    Battery,
    Status,
    Dance,
    Wave,
    Handshake,
    Cheer,
    StandUp,
    StandToFall,
    Walk,
    Run,
    Move {
        vx: i8,
        vyaw: i8,
        #[serde(default)]
        vy: i8,
    },
    Speak { text: String },
    Volume { percent: u8 },
}

impl Command {
    const STOP: Self = Self::Move { vx: 0, vyaw: 0, vy: 0 };
    /// Maximum magnitude of a single remote direction key.
    const REMOTE_AXIS_MAX: i8 = 80;

    fn motion_active(&self) -> Option<bool> {
        match self {
            Self::Move { vx, vyaw, vy } => Some(*vx != 0 || *vyaw != 0 || *vy != 0),
            _ => None,
        }
    }

    fn remote_direction(&self) -> Result<Option<&'static str>, &'static str> {
        let max = Self::REMOTE_AXIS_MAX;
        match self {
            Self::Move { vx: 0, vyaw: 0, vy: 0 } => Ok(None),
            Self::Move { vx, vyaw: 0, vy: 0 } if (1..=max).contains(vx) => Ok(Some("up")),
            Self::Move { vx, vyaw: 0, vy: 0 } if (-max..=-1).contains(vx) => Ok(Some("down")),
            Self::Move { vx: 0, vyaw, vy: 0 } if (1..=max).contains(vyaw) => Ok(Some("left")),
            Self::Move { vx: 0, vyaw, vy: 0 } if (-max..=-1).contains(vyaw) => Ok(Some("right")),
            _ => Err("方向键仅支持单轴前后移动或转向（幅度 1–80）。"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum LocomotionMode {
    Walk,
    Run,
}

#[derive(Clone, Serialize)]
struct Device {
    id: String,
    name: String,
    rssi: Option<i16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_motion_version: Option<u8>,
    connection_id: Option<String>,
    devices: Vec<Device>,
    connected: Option<Device>,
    battery: Option<u8>,
    status: Option<i8>,
    moving: bool,
    walk_mode: bool,
    locomotion_mode: Option<LocomotionMode>,
    listening: bool,
}

fn trusted_page(label: &str, url: &Url) -> bool {
    if label != LABEL
        || url.path() != "/bumi-control.html"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http", Some("tauri.localhost"), None)
    ) || (cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1430))
}

pub(super) async fn open(app: &AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (done, result) = oneshot::channel();
    run_on_window_thread(app, move || {
        let _ = done.send(open_on_window_thread(&handle).map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    result.await.map_err(|error| error.to_string())?
}

fn open_on_window_thread(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }

    let control = app.state::<Arc<Control>>().inner().clone();
    let (lifetime, closed) = watch::channel(());
    *control.window.lock().unwrap() = Some(lifetime);
    #[cfg(any(target_os = "macos", windows))]
    let navigation_owner = (Arc::clone(&control), closed.clone());
    let theme = app.state::<Arc<AppCore>>().theme.current();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Bumi 机器人")
        .inner_size(680.0, 660.0)
        .min_inner_size(450.0, 440.0)
        .theme(Some(theme.native()))
        .background_color(theme.background())
        .initialization_script(&theme.document_theme_script())
        .on_navigation(move |url| {
            let allowed = trusted_page(LABEL, url);
            #[cfg(any(target_os = "macos", windows))]
            if allowed {
                // A reloaded document no longer owns its predecessor's IPC channel.
                navigation_owner.0.remote.lock().unwrap().revoke_window(&navigation_owner.1);
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match window {
        Ok(window) => {
            window.on_window_event(move |event| {
                #[cfg(any(target_os = "macos", windows))]
                if matches!(event, WindowEvent::Focused(false)) {
                    control.remote.lock().unwrap().revoke_window(&closed);
                }
                if matches!(event, WindowEvent::Destroyed) {
                    control.close(&closed);
                }
            });
            Ok(())
        }
        Err(error) => {
            control.close(&closed);
            Err(error)
        }
    }
}

impl Control {
    fn close(self: &Arc<Self>, closed: &watch::Receiver<()>) {
        let mut window = self.window.lock().unwrap();
        if window
            .as_ref()
            .is_some_and(|current| current.subscribe().same_channel(closed))
        {
            window.take();
            #[cfg(any(target_os = "macos", windows))]
            {
                *self.attempts.lock().unwrap() = ConnectionAttempts::default();
                self.remote.lock().unwrap().revoke_window(closed);
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let control = Arc::clone(self);
            let closed = closed.clone();
            tauri::async_runtime::spawn(async move {
                control.bluetooth.lock().await.close(&closed).await;
            });
        }
    }
}

#[tauri::command]
pub(super) async fn bumi_control(
    window: WebviewWindow,
    control: tauri::State<'_, Arc<Control>>,
    request: Request,
) -> Result<Snapshot, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口操作机器人。".into());
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let attempt_id = match &request {
            Request::Scan { attempt_id } | Request::Connect { attempt_id, .. } => attempt_id.as_deref(),
            Request::CancelConnection { attempt_id } => Some(attempt_id.as_str()),
            _ => None,
        };
        if attempt_id.is_some_and(|id| id.is_empty() || id.len() > 128) {
            return Err("连接尝试 ID 无效。".into());
        }
        let lifetime = {
            let window_owner = control.window.lock().unwrap();
            let lifetime = window_owner.as_ref().ok_or("Bumi 控制窗口已关闭。")?.subscribe();
            if let Request::CancelConnection { attempt_id } = &request {
                control.attempts.lock().unwrap().cancel(attempt_id);
            }
            lifetime
        };
        let mut bluetooth = match &request {
            Request::CancelConnection { .. } => control.bluetooth.lock().await,
            Request::Send { command, .. } if command.motion_active() == Some(false) => {
                control.bluetooth.lock().await
            }
            _ => control.bluetooth.try_lock().map_err(|_| "蓝牙操作正在进行，请稍后重试。")?,
        };
        let operation_lifetime = match &request {
            Request::Scan { attempt_id: Some(id) } | Request::Connect { attempt_id: Some(id), .. } => {
                let mut attempts = control.attempts.lock().unwrap();
                if lifetime.has_changed().is_err() {
                    return Err("Bumi 控制窗口已关闭。".into());
                }
                attempts.start(id)?
            }
            _ => lifetime.clone(),
        };
        let direction = match &request {
            Request::Send { command, remote_capture_id: Some(id) } => {
                command.remote_direction()?.map(|key| (*id, key))
            }
            _ => None,
        };
        let verify = || match direction {
            Some((id, key)) => remote_input::verify_direction(&window, &control, id, key),
            None => Ok(()),
        };
        verify()?;
        bluetooth
            .request(window.app_handle(), request, lifetime, operation_lifetime, verify)
            .await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = control;
        if matches!(request, Request::Status) {
            return Ok(Snapshot {
                available: false,
                remote_motion_version: None,
                connection_id: None,
                devices: Vec::new(),
                connected: None,
                battery: None,
                status: None,
                moving: false,
                walk_mode: false,
                locomotion_mode: None,
                listening: false,
            });
        }
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn cancelling_interrupts_only_its_attempt_and_rejects_late_ipc() {
        let mut attempts = ConnectionAttempts::default();
        let scanning = attempts.start("first").unwrap();
        attempts.cancel("cancelled-before-start");
        assert!(attempts.start("cancelled-before-start").is_err());
        assert_eq!(scanning.has_changed().ok(), Some(false));
        attempts.cancel("first");
        assert!(scanning.has_changed().is_err());
        assert!(attempts.start("first").is_err());
        let connecting = attempts.start("next").unwrap();
        attempts.cancel("first");
        assert_eq!(connecting.has_changed().ok(), Some(false));
        drop(attempts);
        assert!(connecting.has_changed().is_err());
    }

    #[test]
    fn legacy_bumi_requests_omit_attempt_identity() {
        for (input, id) in [
            (r#"{"operation":"scan"}"#, None),
            (r#"{"operation":"connect","id":"robot"}"#, None),
            (r#"{"operation":"scan","attemptId":"attempt"}"#, Some("attempt")),
            (r#"{"operation":"connect","id":"robot","attemptId":"attempt"}"#, Some("attempt")),
        ] {
            match serde_json::from_str::<Request>(input).unwrap() {
                Request::Scan { attempt_id } | Request::Connect { attempt_id, .. } => {
                    assert_eq!(attempt_id.as_deref(), id);
                }
                _ => panic!("unexpected request"),
            }
        }
    }

    #[test]
    fn commands_are_limited_to_the_local_bumi_document() {
        let url = Url::parse("tauri://localhost/bumi-control.html").unwrap();
        assert!(trusted_page(LABEL, &url));
        assert!(!trusted_page("main", &url));
        for url in [
            "http://tauri.localhost:8080/bumi-control.html",
            "https://keepwork.com/bumi-control.html",
            "http://localhost:1430/bumi-control.html",
            "http://127.0.0.1:1431/bumi-control.html",
            "tauri://user@localhost/bumi-control.html",
            "tauri://localhost/remote-voice.html",
            "tauri://localhost/bumi-control.html?other",
            "tauri://localhost/bumi-control.html#other",
        ] {
            assert!(!trusted_page(LABEL, &Url::parse(url).unwrap()), "{url}");
        }
        assert_eq!(
            trusted_page(
                LABEL,
                &Url::parse("http://127.0.0.1:1430/bumi-control.html").unwrap()
            ),
            cfg!(debug_assertions)
        );
    }
}
