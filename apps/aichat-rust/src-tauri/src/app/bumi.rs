use super::main_window::run_on_window_thread;
use super::state::AppCore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, watch};
use url::Url;

#[cfg(any(target_os = "macos", windows))]
mod bluetooth;
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
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(super) enum Request {
    Status,
    Scan,
    Connect { id: String },
    Disconnect,
    Send { command: Command },
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
    Move { vx: i8, vyaw: i8 },
    Speak { text: String },
    Volume { percent: u8 },
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
    devices: Vec<Device>,
    connected: Option<Device>,
    battery: Option<u8>,
    status: Option<i8>,
    moving: bool,
    walk_mode: bool,
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
    let theme = app.state::<Arc<AppCore>>().theme.current();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Bumi 机器人")
        .inner_size(680.0, 660.0)
        .min_inner_size(450.0, 440.0)
        .theme(Some(theme.native()))
        .background_color(theme.background())
        .initialization_script(&theme.document_theme_script())
        .on_navigation(|url| trusted_page(LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match window {
        Ok(window) => {
            window.on_window_event(move |event| {
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
        let lifetime = control
            .window
            .lock()
            .unwrap()
            .as_ref()
            .map(watch::Sender::subscribe)
            .ok_or("Bumi 控制窗口已关闭。")?;
        let mut bluetooth = control
            .bluetooth
            .try_lock()
            .map_err(|_| "蓝牙操作正在进行，请稍后重试。")?;
        bluetooth.request(request, lifetime).await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = control;
        if matches!(request, Request::Status) {
            return Ok(Snapshot {
                available: false,
                devices: Vec::new(),
                connected: None,
                battery: None,
                status: None,
                moving: false,
                walk_mode: false,
            });
        }
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
