use super::main_window::run_on_window_thread;
use super::state::AppCore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, watch};
use url::Url;

#[cfg(any(target_os = "macos", windows))]
mod bluetooth;
pub(super) mod box_link;
pub(super) mod chat;
#[cfg(any(target_os = "macos", windows))]
mod classroom;
#[cfg(any(target_os = "macos", windows))]
mod guided;
mod model;
#[cfg(any(target_os = "macos", windows, test))]
mod protocol;
pub(super) mod remote_input;
mod vision;
pub(super) mod voice_input;
mod walk_intent;

const LABEL: &str = "bumi-control";
const PAGE: &str = "bumi-control.html";
#[cfg(not(any(target_os = "macos", windows)))]
const UNSUPPORTED: &str = "Bumi 蓝牙控制需要 macOS 或 Windows 桌面版。";

#[derive(Default)]
pub(super) struct Control {
    window: Mutex<Option<watch::Sender<()>>>,
    box_link: Mutex<box_link::Link>,
    chat: Mutex<chat::Bridge>,
    voice_input: Mutex<voice_input::Sessions>,
    #[cfg(any(target_os = "macos", windows))]
    bluetooth: tokio::sync::Mutex<bluetooth::Bluetooth>,
    #[cfg(any(target_os = "macos", windows))]
    attempts: Mutex<ConnectionAttempts>,
    #[cfg(any(target_os = "macos", windows))]
    remote: Mutex<remote_input::Sessions>,
    #[cfg(any(target_os = "macos", windows))]
    guide: Mutex<guided::Lease>,
    #[cfg(any(target_os = "macos", windows))]
    classroom: Mutex<classroom::Sessions>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ClassroomAction {
    Forward,
    Backward,
    Left,
    Right,
    Handshake,
    Wave,
    Greet,
    AskDoorOrLectern,
    AskWhich,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub(super) enum Request {
    Status,
    Guide {
        #[serde(rename = "captureId")]
        capture_id: u64,
        #[serde(rename = "pressId")]
        press_id: u64,
        direction: Option<GuidedDirection>,
        #[serde(rename = "voiceId", default)]
        voice_id: Option<u64>,
    },
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
    Listen {
        enabled: bool,
    },
    LocateVision(vision::LocateInput),
    InterpretWalk(walk_intent::Input),
    #[serde(rename_all = "camelCase")]
    BeginClassroom {
        task_id: String,
        connection_id: String,
        capture_id: Option<u64>,
        voice_id: Option<u64>,
        pulse_profile: Option<ClassroomPulseProfile>,
    },
    #[serde(rename_all = "camelCase")]
    ClassroomStep {
        task_id: String,
        sequence: u32,
        action: ClassroomAction,
    },
    #[serde(rename_all = "camelCase")]
    ClassroomStop {
        task_id: String,
        sequence: u32,
    },
    #[serde(rename_all = "camelCase")]
    EndClassroom {
        task_id: String,
    },
    Send {
        command: Command,
        #[serde(rename = "remoteCaptureId", default)]
        remote_capture_id: Option<u64>,
        #[serde(rename = "voiceId", default)]
        voice_id: Option<u64>,
    },
}

/// Each profile names a complete, reproducible joystick pulse. Legacy callers
/// omit the field to keep the original single-write calibration unchanged.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ClassroomPulseProfile {
    Gentle,
    Standard,
    Strong,
}

impl Request {
    fn remote_voice_action(&self) -> Result<Option<(u64, u64)>, &'static str> {
        match self {
            Self::Send {
                command:
                    Command::Dance
                    | Command::Wave
                    | Command::Handshake
                    | Command::Cheer
                    | Command::Walk
                    | Command::Run,
                remote_capture_id: Some(id),
                voice_id: Some(voice_id),
            } => Ok(Some((*id, *voice_id))),
            Self::Send {
                voice_id: Some(_), ..
            } => Err("Bumi 语音指令与遥控会话不匹配。"),
            _ => Ok(None),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum GuidedDirection {
    Forward,
    Left,
    Right,
    Backward,
    StrafeLeft,
    StrafeRight,
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
    StartTeach,
    StopTeach,
    SaveTeach {
        name: String,
    },
    TeachList,
    PlayTeach {
        id: u8,
    },
    DeleteTeach {
        id: u8,
    },
    Move {
        vx: i8,
        vyaw: i8,
        #[serde(default)]
        vy: i8,
    },
    Speak {
        text: String,
    },
    Volume {
        percent: u8,
    },
}

#[derive(Clone, Copy)]
pub(super) enum RemoteDirection {
    Up,
    Down,
    Left { strafe: bool },
    Right { strafe: bool },
}

impl RemoteDirection {
    fn key_for_mode(self, strafe_mode: bool) -> Option<&'static str> {
        match self {
            Self::Up => Some("up"),
            Self::Down => Some("down"),
            Self::Left { strafe } if strafe == strafe_mode => Some("left"),
            Self::Right { strafe } if strafe == strafe_mode => Some("right"),
            _ => None,
        }
    }
}

impl Command {
    const STOP: Self = Self::Move {
        vx: 0,
        vyaw: 0,
        vy: 0,
    };
    /// Maximum magnitude of a single remote direction key.
    const REMOTE_AXIS_MAX: i8 = 80;

    fn motion_active(&self) -> Option<bool> {
        match self {
            Self::Move { vx, vyaw, vy } => Some(*vx != 0 || *vyaw != 0 || *vy != 0),
            _ => None,
        }
    }

    fn remote_direction(&self) -> Result<Option<RemoteDirection>, &'static str> {
        let max = Self::REMOTE_AXIS_MAX;
        use RemoteDirection::*;
        match self {
            Self::Move {
                vx: 0,
                vyaw: 0,
                vy: 0,
            } => Ok(None),
            Self::Move { vx, vyaw: 0, vy: 0 } if (1..=max).contains(vx) => Ok(Some(Up)),
            Self::Move { vx, vyaw: 0, vy: 0 } if (-max..=-1).contains(vx) => Ok(Some(Down)),
            Self::Move { vx: 0, vyaw, vy: 0 } if (1..=max).contains(vyaw) => {
                Ok(Some(Left { strafe: false }))
            }
            Self::Move { vx: 0, vyaw, vy: 0 } if (-max..=-1).contains(vyaw) => {
                Ok(Some(Right { strafe: false }))
            }
            Self::Move { vx: 0, vyaw: 0, vy } if (1..=max).contains(vy) => {
                Ok(Some(Left { strafe: true }))
            }
            Self::Move { vx: 0, vyaw: 0, vy } if (-max..=-1).contains(vy) => {
                Ok(Some(Right { strafe: true }))
            }
            _ => Err("方向键仅支持单轴前后移动、转向或平移（幅度 1–80）。"),
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TeachAction {
    pub(super) id: u8,
    pub(super) name: String,
    pub(super) duration: Option<u8>,
    pub(super) time: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    guided_motion_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_motion_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_menu_switch: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_voice_command_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_voice_gestures: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_voice_continue: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_voice_step_directions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vision_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_vision_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_confidence_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    walk_intent_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_walk_path_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    automatic_walk_clearance_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    walk_floor_scale_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_inspection_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_view_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    walk_continue_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    single_frame_route_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    single_frame_estimated_step_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    single_frame_directions_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    single_frame_pulse_directions_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_spoken_choice: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    classroom_pulse_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    teach_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    walk_intent: Option<walk_intent::WalkIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vision_pose: Option<vision::VisionPose>,
    connection_id: Option<String>,
    devices: Vec<Device>,
    connected: Option<Device>,
    battery: Option<u8>,
    status: Option<i8>,
    moving: bool,
    walk_mode: bool,
    locomotion_mode: Option<LocomotionMode>,
    teach_recording: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    teach_actions: Option<Vec<TeachAction>>,
    listening: bool,
}

#[cfg(any(target_os = "macos", windows))]
impl Snapshot {
    fn model_result(
        vision_pose: Option<vision::VisionPose>,
        walk_intent: Option<walk_intent::WalkIntent>,
    ) -> Self {
        Self {
            available: true,
            guided_motion_version: Some(1),
            remote_motion_version: Some(2),
            remote_menu_switch: Some(true),
            remote_voice_command_version: Some(1),
            remote_voice_gestures: Some(true),
            remote_voice_continue: Some(true),
            remote_voice_step_directions: Some(true),
            vision_version: Some(2),
            scene_vision_version: Some(1),
            scene_confidence_version: Some(1),
            scene_walk_path_version: Some(1),
            automatic_walk_clearance_version: Some(1),
            walk_floor_scale_version: Some(1),
            scene_inspection_version: Some(1),
            search_view_version: Some(1),
            walk_continue_version: Some(1),
            single_frame_route_version: Some(1),
            single_frame_estimated_step_version: Some(1),
            single_frame_directions_version: Some(1),
            single_frame_pulse_directions_version: Some(1),
            scene_spoken_choice: Some(true),
            classroom_pulse_version: Some(1),
            teach_version: Some(1),
            walk_intent_version: Some(1),
            walk_intent,
            vision_pose,
            connection_id: None,
            devices: Vec::new(),
            connected: None,
            battery: None,
            status: None,
            moving: false,
            walk_mode: false,
            locomotion_mode: None,
            teach_recording: false,
            teach_actions: None,
            listening: false,
        }
    }
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
            if allowed {
                let window = navigation_owner.0.window.lock().unwrap();
                if window
                    .as_ref()
                    .is_some_and(|current| current.subscribe().same_channel(&navigation_owner.1))
                {
                    navigation_owner.0.box_link.lock().unwrap().reset();
                }
            }
            #[cfg(any(target_os = "macos", windows))]
            if allowed {
                // A reloaded document no longer owns its predecessor's IPC channel.
                *navigation_owner.0.chat.lock().unwrap() = Default::default();
                navigation_owner
                    .0
                    .voice_input
                    .lock()
                    .unwrap()
                    .revoke_window(&navigation_owner.1);
                classroom::end_window(&navigation_owner.0, &navigation_owner.1);
                navigation_owner
                    .0
                    .remote
                    .lock()
                    .unwrap()
                    .revoke_window(&navigation_owner.1);
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
                    classroom::end_window(&control, &closed);
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
            self.box_link.lock().unwrap().reset();
            *self.chat.lock().unwrap() = Default::default();
            self.voice_input.lock().unwrap().revoke_window(closed);
            #[cfg(any(target_os = "macos", windows))]
            {
                *self.classroom.lock().unwrap() = classroom::Sessions::default();
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
            Request::Scan { attempt_id } | Request::Connect { attempt_id, .. } => {
                attempt_id.as_deref()
            }
            Request::CancelConnection { attempt_id } => Some(attempt_id.as_str()),
            _ => None,
        };
        if attempt_id.is_some_and(|id| id.is_empty() || id.len() > 128) {
            return Err("连接尝试 ID 无效。".into());
        }
        let lifetime = {
            let window_owner = control.window.lock().unwrap();
            let lifetime = window_owner
                .as_ref()
                .ok_or("Bumi 控制窗口已关闭。")?
                .subscribe();
            if let Request::CancelConnection { attempt_id } = &request {
                control.attempts.lock().unwrap().cancel(attempt_id);
            }
            lifetime
        };
        match request {
            Request::LocateVision(input) => {
                let pose = vision::locate(window.app_handle(), input, lifetime).await?;
                return Ok(Snapshot::model_result(Some(pose), None));
            }
            Request::InterpretWalk(input) => {
                let intent = walk_intent::interpret(window.app_handle(), input, lifetime).await?;
                return Ok(Snapshot::model_result(None, Some(intent)));
            }
            Request::BeginClassroom {
                task_id,
                connection_id,
                capture_id,
                voice_id,
                pulse_profile,
            } => {
                return classroom::begin(
                    &window,
                    &control,
                    task_id,
                    connection_id,
                    capture_id,
                    voice_id,
                    pulse_profile,
                    &lifetime,
                )
            }
            Request::ClassroomStep {
                task_id,
                sequence,
                action,
            } => {
                return classroom::step(
                    &window,
                    control.inner(),
                    lifetime,
                    task_id,
                    sequence,
                    action,
                )
                .await
            }
            Request::ClassroomStop { task_id, sequence } => {
                return classroom::stop(&window, &control, lifetime, &task_id, sequence).await
            }
            Request::EndClassroom { task_id } => {
                classroom::end(&control, Some(&task_id));
                return Ok(control.bluetooth.lock().await.snapshot());
            }
            Request::Disconnect
            | Request::Guide {
                direction: Some(_), ..
            } => classroom::end(&control, None),
            Request::Send { ref command, .. }
                if !matches!(
                    command,
                    Command::Battery
                        | Command::Status
                        | Command::TeachList
                        | Command::Volume { .. }
                        | Command::Speak { .. }
                ) =>
            {
                classroom::end(&control, None)
            }
            _ => {}
        }
        if let Request::Guide {
            capture_id,
            press_id,
            direction,
            voice_id,
        } = request
        {
            return guided::request(
                &window,
                control.inner(),
                lifetime,
                capture_id,
                press_id,
                direction,
                voice_id,
            )
            .await;
        }
        let mut bluetooth = match &request {
            Request::CancelConnection { .. } => control.bluetooth.lock().await,
            Request::Send { command, .. }
                if command.motion_active() == Some(false)
                    || matches!(command, Command::StopTeach) =>
            {
                control.bluetooth.lock().await
            }
            _ => control
                .bluetooth
                .try_lock()
                .map_err(|_| "蓝牙操作正在进行，请稍后重试。")?,
        };
        let operation_lifetime = match &request {
            Request::Scan {
                attempt_id: Some(id),
            }
            | Request::Connect {
                attempt_id: Some(id),
                ..
            } => {
                let mut attempts = control.attempts.lock().unwrap();
                if lifetime.has_changed().is_err() {
                    return Err("Bumi 控制窗口已关闭。".into());
                }
                attempts.start(id)?
            }
            _ => lifetime.clone(),
        };
        let voice_action = request.remote_voice_action()?;
        let voice_session = voice_action
            .map(|(id, turn)| remote_input::claim_voice(&window, &control, id, turn))
            .transpose()?;
        let direction = match &request {
            Request::Send {
                command,
                remote_capture_id: Some(id),
                ..
            } if voice_action.is_none() => command.remote_direction()?.map(|key| (*id, key)),
            _ => None,
        };
        let verify = || match (direction, voice_action) {
            (Some((id, key)), _) => remote_input::verify_direction(&window, &control, id, key),
            (_, Some((id, voice_id))) => {
                remote_input::verify_guided_voice(&window, &control, id, voice_id, false)
            }
            _ => Ok(()),
        };
        bluetooth
            .request(
                window.app_handle(),
                request,
                lifetime,
                operation_lifetime,
                voice_session,
                verify,
            )
            .await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = control;
        if matches!(request, Request::Status) {
            return Ok(Snapshot {
                available: false,
                guided_motion_version: None,
                remote_motion_version: None,
                remote_menu_switch: None,
                remote_voice_command_version: None,
                remote_voice_gestures: None,
                remote_voice_continue: None,
                remote_voice_step_directions: None,
                vision_version: None,
                scene_vision_version: None,
                scene_confidence_version: None,
                scene_walk_path_version: None,
                automatic_walk_clearance_version: None,
                walk_floor_scale_version: None,
                scene_inspection_version: None,
                search_view_version: None,
                walk_continue_version: None,
                single_frame_route_version: None,
                single_frame_estimated_step_version: None,
                single_frame_directions_version: None,
            single_frame_pulse_directions_version: None,
                scene_spoken_choice: None,
                classroom_pulse_version: None,
                teach_version: None,
                walk_intent_version: None,
                walk_intent: None,
                vision_pose: None,
                connection_id: None,
                devices: Vec::new(),
                connected: None,
                battery: None,
                status: None,
                moving: false,
                walk_mode: false,
                locomotion_mode: None,
                teach_recording: false,
                teach_actions: None,
                listening: false,
            });
        }
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_postures_and_gaits_require_a_capture_and_exclude_other_commands() {
        let request = |command, remote_capture_id| Request::Send {
            command,
            remote_capture_id,
            voice_id: Some(2),
        };
        for command in [
            Command::Dance,
            Command::Wave,
            Command::Handshake,
            Command::Cheer,
            Command::Walk,
            Command::Run,
        ] {
            assert!(request(command.clone(), None)
                .remote_voice_action()
                .is_err());
            assert_eq!(
                request(command, Some(7)).remote_voice_action(),
                Ok(Some((7, 2)))
            );
        }
        for other in [
            Command::StandUp,
            Command::StandToFall,
            Command::StartTeach,
            Command::STOP,
        ] {
            assert!(request(other, Some(7)).remote_voice_action().is_err());
        }
    }

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
            (
                r#"{"operation":"scan","attemptId":"attempt"}"#,
                Some("attempt"),
            ),
            (
                r#"{"operation":"connect","id":"robot","attemptId":"attempt"}"#,
                Some("attempt"),
            ),
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
