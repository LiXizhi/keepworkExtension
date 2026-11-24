use super::{trusted_page, Control};
use serde::Serialize;
use std::sync::Arc;
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
    sampled_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(any(target_os = "macos", windows))]
const STALE: Duration = Duration::from_millis(500);

#[cfg(any(target_os = "macos", windows))]
struct Capture {
    id: u64,
    drive: bool,
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
fn focused(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn verify_direction(
    window: &WebviewWindow,
    control: &Control,
    id: u64,
    key: &str,
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
                    if state.revision == capture.delivered_revision && state.permits(key) {
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
        sampled_at: epoch.saturating_sub(age).as_millis() as u64,
        error,
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
) -> Result<String, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口读取遥控方向键。".into());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (control, enabled, capture_id, events, webview, drive);
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
                window: lifetime.clone(),
                cancel,
                reader: None,
                last_sample: Instant::now(),
                delivered_revision: 0,
                issued_motion: false,
            });
            lifetime
        };
        let setup = DirectionReader::open().and_then(|(reader, edges)| {
            if *cancelled.borrow() || !focused(&window) || lifetime.has_changed().is_err() {
                return Err("Bumi 窗口已失去焦点。".into());
            }
            channel
                .send(event(Vec::new(), Duration::ZERO, None))
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
                            keys = state.keys;
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
                if channel.send(event(keys.clone(), age, None)).is_err() {
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
