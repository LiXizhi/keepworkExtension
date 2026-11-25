use super::{trusted_page, Control};
#[cfg(any(target_os = "macos", windows))]
use super::RemoteDirection;
use serde::Serialize;
use std::sync::Arc;
#[cfg(any(target_os = "macos", windows))]
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri::{ipc::JavaScriptChannelId, Webview, WebviewWindow};

#[cfg(any(target_os = "macos", windows))]
use crate::remote_voice::buttons::directions::DirectionReader;
#[cfg(any(target_os = "macos", windows))]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(any(target_os = "macos", windows))]
use tokio::sync::watch;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectionEvent {
    keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    strafe: Option<bool>,
    sampled_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice_id: Option<u64>,
}

#[cfg(any(target_os = "macos", windows))]
const STALE: Duration = Duration::from_millis(500);

#[cfg(any(target_os = "macos", windows, test))]
#[derive(Default)]
struct VoiceTurn {
    revision: u64,
    state: VoiceState,
}

#[cfg(any(target_os = "macos", windows, test))]
#[derive(Default, PartialEq)]
enum VoiceState {
    #[default]
    Recording,
    Delivered,
    Consumed,
    Rejected,
}

#[cfg(any(target_os = "macos", windows, test))]
impl VoiceTurn {
    fn begin(&mut self) -> Option<u64> {
        self.revision = self.revision.checked_add(1)?;
        self.state = VoiceState::Recording;
        Some(self.revision)
    }

    fn publish(&mut self, revision: u64) -> bool {
        if self.revision != revision || self.state != VoiceState::Recording {
            return false;
        }
        self.state = VoiceState::Delivered;
        true
    }

    fn consume(&mut self, revision: u64) -> bool {
        if self.revision != revision || self.state != VoiceState::Delivered {
            return false;
        }
        self.state = VoiceState::Consumed;
        true
    }

    fn current_action(&self, revision: u64) -> bool {
        self.revision == revision && self.state == VoiceState::Consumed
    }
}

#[cfg(any(target_os = "macos", windows))]
struct Capture {
    id: u64,
    drive: bool,
    voice_channel: Option<Channel<DirectionEvent>>,
    voice_turn: VoiceTurn,
    armed_at: Instant,
    window: watch::Receiver<()>,
    cancel: watch::Sender<bool>,
    reader: Option<Arc<DirectionReader>>,
    last_sample: Instant,
    delivered_revision: u64,
    issued_motion: bool,
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Default)]
pub(super) struct Sessions {
    active: Option<Capture>,
}

#[cfg(any(target_os = "macos", windows))]
impl Sessions {
    pub(super) fn revoke_window(&mut self, lifetime: &watch::Receiver<()>) {
        if let Some(capture) = &self.active {
            if capture.window.same_channel(lifetime) {
                capture.cancel.send_replace(true);
            }
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn current_capture(core: &Control) -> Option<u64> {
    core.remote.lock().unwrap().active.as_ref().map(|capture| capture.id)
}

#[cfg(any(target_os = "macos", windows))]
fn focused(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
}

#[cfg(any(target_os = "macos", windows))]
impl Capture {
    fn voice_live(&self) -> bool {
        self.drive
            && self.voice_channel.is_some()
            && !*self.cancel.borrow()
            && self.window.has_changed().is_ok()
            && self.last_sample.elapsed() < STALE
    }
}

/// A direction reader already enforces a single, connected RC003 and detects a
/// changed HID source. Retain its exact capture, not a window label, across ASR.
#[cfg(any(target_os = "macos", windows))]
pub(in super::super) fn bind_voice(
    app: &AppHandle,
    pressed: Instant,
    source: &str,
) -> Option<crate::remote_voice::BumiDelivery> {
    let core = app.state::<Arc<Control>>().inner().clone();
    if !core
        .remote
        .lock()
        .unwrap()
        .active
        .as_ref()
        .is_some_and(Capture::voice_live)
    {
        return None;
    }
    let window = app.get_webview_window(super::LABEL)?;
    if !focused(&window) {
        return None;
    }
    let (owner, revision) = {
        let mut sessions = core.remote.lock().unwrap();
        let capture = sessions.active.as_mut()?;
        if !capture.voice_live() || pressed < capture.armed_at || capture.reader.is_none() {
            return None;
        }
        (capture.cancel.subscribe(), capture.voice_turn.begin()?)
    };
    #[cfg(windows)]
    let source = source.to_owned();
    #[cfg(not(windows))]
    let _ = source;
    Some(Arc::new(move |outcome| {
        const EXPIRED: &str = "本次 Bumi 遥控已结束或已有新的录音，请重新按住语音键。";
        if !focused(&window)
            || !window
                .url()
                .is_ok_and(|url| trusted_page(window.label(), &url))
        {
            return Err(EXPIRED.into());
        }
        let mut sessions = core.remote.lock().unwrap();
        let capture = sessions
            .active
            .as_mut()
            .filter(|capture| {
                capture.voice_live() && capture.cancel.subscribe().same_channel(&owner)
            })
            .ok_or(EXPIRED)?;
        // STOP must still reach the controller while a direction is held.
        let reader = capture.reader.as_ref().ok_or(EXPIRED)?;
        reader.state()?;
        #[cfg(windows)]
        let outcome = if reader.matches_voice_source(&source) {
            outcome
        } else {
            Err("无法确认语音与方向键来自同一只 RC003。请检查所选遥控器，再重新按住语音键。")
        };
        if !capture.voice_turn.publish(revision) {
            return Err(EXPIRED.into());
        }
        let mut message = event(Vec::new(), Duration::ZERO, None);
        match outcome {
            Ok(text) => message.voice_command = Some(text.to_owned()),
            Err(reason) => {
                capture.voice_turn.state = VoiceState::Rejected;
                message.voice_error = Some(reason.to_owned());
            }
        }
        message.voice_id = Some(revision);
        let channel = capture.voice_channel.clone().ok_or(EXPIRED)?;
        drop(sessions);
        channel
            .send(message)
            .map_err(|_| "Bumi 控制窗口已关闭。".to_owned())?;
        outcome.map(|_| ()).map_err(str::to_owned)
    }))
}

#[cfg(any(target_os = "macos", windows))]
fn with_idle_voice<T>(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
    action: impl FnOnce(&mut Capture) -> Result<T, String>,
) -> Result<T, String> {
    const BLOCKED: &str = "请松开方向键，并确认 Bumi 窗口仍在遥控。";
    if !focused(window) {
        return Err(BLOCKED.into());
    }
    let mut sessions = control.remote.lock().unwrap();
    let capture = sessions
        .active
        .as_mut()
        .filter(|c| c.id == id && c.voice_live())
        .ok_or(BLOCKED)?;
    let state = capture.reader.as_ref().ok_or(BLOCKED)?.state()?;
    if !state.keys.is_empty() || state.revision != capture.delivered_revision {
        return Err(BLOCKED.into());
    }
    action(capture)
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn verify_voice_idle(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
) -> Result<(), String> {
    with_idle_voice(window, control, id, |_| Ok(()))
}

#[cfg(any(target_os = "macos", windows))]
const EXPIRED_VOICE: &str = "Bumi 语音指令已过期，或已经执行。";

#[cfg(any(target_os = "macos", windows))]
pub(super) fn claim_voice(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
    voice_id: u64,
) -> Result<watch::Receiver<bool>, String> {
    with_idle_voice(window, control, id, |capture| {
        if !capture.voice_turn.consume(voice_id) {
            return Err(EXPIRED_VOICE.into());
        }
        Ok(capture.cancel.subscribe())
    })
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn verify_guided_voice(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
    voice_id: u64,
    first: bool,
) -> Result<(), String> {
    if first {
        return claim_voice(window, control, id, voice_id).map(drop);
    }
    with_idle_voice(window, control, id, |capture| {
        if !capture.voice_turn.current_action(voice_id) {
            return Err(EXPIRED_VOICE.into());
        }
        Ok(())
    })
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn cancel_drive(control: &Control, capture_id: u64) {
    if let Some(capture) = control
        .remote
        .lock()
        .unwrap()
        .active
        .as_ref()
        .filter(|c| c.id == capture_id && c.drive)
    {
        capture.cancel.send_replace(true);
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn verify_direction(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
    direction: RemoteDirection,
) -> Result<(), String> {
    if focused(window) {
        let mut session = control.remote.lock().unwrap();
        if let Some(capture) = &mut session.active {
            if capture.drive
                && capture.id == id
                && !*capture.cancel.borrow()
                && capture.last_sample.elapsed() < STALE
            {
                if let Some(reader) = &capture.reader {
                    let state = reader.state()?;
                    if state.revision == capture.delivered_revision
                        && direction.key_for_mode(state.strafe).is_some_and(|key| state.permits(key))
                    {
                        capture.issued_motion = true;
                        return Ok(());
                    }
                }
            }
        }
    }
    Err("遥控方向键已释放或遥控会话已结束。".into())
}

#[cfg(any(target_os = "macos", windows))]
fn event(keys: Vec<String>, age: Duration, error: Option<String>) -> DirectionEvent {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    DirectionEvent {
        keys,
        strafe: None,
        sampled_at: epoch.saturating_sub(age).as_millis() as u64,
        error,
        voice_command: None,
        voice_error: None,
        voice_id: None,
    }
}

#[tauri::command]
pub(crate) async fn bumi_remote_input(
    window: WebviewWindow,
    webview: Webview,
    control: tauri::State<'_, Arc<Control>>,
    enabled: bool,
    capture_id: u64,
    events: Option<JavaScriptChannelId>,
    drive: Option<bool>,
    voice_commands: Option<bool>,
    menu_switch: Option<bool>,
) -> Result<String, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口读取遥控方向键。".into());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (
            control,
            enabled,
            capture_id,
            events,
            webview,
            drive,
            voice_commands,
            menu_switch,
        );
        Err(super::UNSUPPORTED.into())
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let core = control.inner().clone();
        if !enabled {
            let session = core.remote.lock().unwrap();
            if let Some(capture) = session
                .active
                .as_ref()
                .filter(|capture| capture.id == capture_id)
            {
                capture.cancel.send_replace(true);
            }
            return Ok(String::new());
        }
        let channel = events.ok_or("缺少遥控按键接收通道。")?.channel_on(webview);
        if !focused(&window) {
            return Err("请先激活 Bumi 控制窗口。".into());
        }
        let (cancel, mut cancelled) = watch::channel(false);
        let lifetime = {
            let owner = core.window.lock().unwrap();
            let lifetime = owner.as_ref().ok_or("Bumi 控制窗口已关闭。")?.subscribe();
            let mut session = core.remote.lock().unwrap();
            if session.active.is_some() {
                return Err("方向键监听尚未结束，请稍后重试。".into());
            }
            session.active = Some(Capture {
                id: capture_id,
                drive: drive.unwrap_or(false),
                voice_channel: if drive == Some(true) && voice_commands == Some(true) {
                    Some(channel.clone())
                } else {
                    None
                },
                voice_turn: VoiceTurn::default(),
                armed_at: Instant::now(),
                window: lifetime.clone(),
                cancel,
                reader: None,
                last_sample: Instant::now(),
                delivered_revision: 0,
                issued_motion: false,
            });
            lifetime
        };
        core.guide.lock().unwrap().arm(capture_id);
        super::classroom::end_window(&core, &lifetime);
        let menu_switch = menu_switch.unwrap_or(false);
        let setup = DirectionReader::open(menu_switch).and_then(|(reader, edges)| {
            if *cancelled.borrow() || !focused(&window) || lifetime.has_changed().is_err() {
                return Err("Bumi 窗口已失去焦点。".into());
            }
            let mut initial = event(Vec::new(), Duration::ZERO, None);
            initial.strafe = menu_switch.then_some(false);
            channel
                .send(initial)
                .map_err(|e| e.to_string())?;
            Ok((Arc::new(reader), edges))
        });
        let (reader, mut edges) = match setup {
            Ok(result) => result,
            Err(error) => {
                core.remote.lock().unwrap().active.take();
                return Err(error);
            }
        };
        core.remote.lock().unwrap().active.as_mut().unwrap().reader = Some(Arc::clone(&reader));
        let device = reader.device.clone();
        tauri::async_runtime::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_millis(100));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last = Instant::now();
            let mut keys = Vec::new();
            let mut strafe = false;
            let mut delivered_revision = 0;
            let reason = loop {
                let mut age = Duration::ZERO;
                let mut must_stop = false;
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => break "方向键监听已停止。",
                    edge = edges.recv() => match edge {
                        Ok((at, state)) => {
                            age = at.elapsed();
                            delivered_revision = state.revision;
                            must_stop = state.keys.first().is_none_or(|key| !state.permits(key));
                            strafe = state.strafe;
                            keys = state.keys;
                            if !keys.is_empty() {
                                super::classroom::end_window(&core, &lifetime);
                            }
                        }
                        Err(_) => break "遥控按键状态不同步，请重新启用。",
                    },
                    _ = timer.tick() => {}
                }
                if last.elapsed() >= STALE || age >= STALE {
                    break "遥控输入已超时，请重新启用。";
                }
                if !focused(&window) || lifetime.has_changed().is_err() {
                    break "Bumi 控制窗口已失去焦点。";
                }
                if reader.state().is_err() {
                    break "遥控器已断开或来源发生变化。";
                }
                last = Instant::now();
                let stop_previous =
                    core.remote
                        .lock()
                        .unwrap()
                        .active
                        .as_mut()
                        .is_some_and(|capture| {
                            capture.last_sample = last;
                            capture.delivered_revision = delivered_revision;
                            must_stop && std::mem::take(&mut capture.issued_motion)
                        });
                let mut sample = event(keys.clone(), age, None);
                sample.strafe = menu_switch.then_some(strafe);
                if channel.send(sample).is_err() {
                    break "方向键接收通道已断开。";
                }
                // Complete the release before delivering a newer press. Raw
                // events continue to queue; lag or a slow stop disarms the session.
                if stop_previous
                    && core
                        .bluetooth
                        .lock()
                        .await
                        .stop_remote_if_moving(&lifetime, capture_id)
                        .await
                        .is_err()
                {
                    break "遥控停止指令未确认，请现场确认机器人已停稳。";
                }
            };
            // Revoke before waiting for a slow GATT write. Any queued move
            // must pass the capture check again after acquiring the BLE lock.
            if let Some(capture) = core.remote.lock().unwrap().active.as_ref() {
                capture.cancel.send_replace(true);
            }
            let _ = channel.send(event(Vec::new(), Duration::ZERO, Some(reason.into())));
            super::classroom::end_window(&core, &lifetime);
            let _ = core
                .bluetooth
                .lock()
                .await
                .stop_remote_if_moving(&lifetime, capture_id)
                .await;
            core.remote.lock().unwrap().active.take();
        });
        Ok(device)
    }
}

#[cfg(test)]
mod tests {
    use super::VoiceTurn;

    #[test]
    fn only_the_current_complete_voice_turn_can_authorize_one_dance() {
        let mut turn = VoiceTurn::default();
        let first = turn.begin().unwrap();
        assert!(!turn.consume(first));
        let second = turn.begin().unwrap();
        assert!(!turn.publish(first));
        assert!(turn.publish(second));
        assert!(!turn.current_action(second));
        assert!(!turn.publish(second));
        assert!(turn.consume(second));
        assert!(turn.current_action(second));
        assert!(!turn.consume(second));
        assert!(!turn.publish(second));
        let third = turn.begin().unwrap();
        assert!(!turn.current_action(second));
        assert!(turn.publish(third));
        turn.begin();
        assert!(!turn.consume(third));
    }
}
