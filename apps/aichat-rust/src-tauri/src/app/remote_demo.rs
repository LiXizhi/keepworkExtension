//! The keyboard guard belongs to the focused diagram, independently of dictation.
use super::state::AppCore;
use crate::remote_voice::RemoteVoice;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, WebviewWindow};

#[cfg(target_os = "macos")]
#[path = "remote_demo_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "remote_demo_windows.rs"]
mod platform;

#[cfg(windows)]
pub(super) fn prepare_window(window: &WebviewWindow) {
    // HWND subclassing must run on the thread that owns the window. A failed
    // installation disables entry into the demo, leaving voice settings usable.
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = platform::install_app_command_guard(&target);
    });
}

#[derive(Clone, Copy, Serialize)]
pub(super) struct KeyEdge {
    key: &'static str,
    pressed: bool,
}

#[derive(Default)]
struct Lease {
    generation: u64,
    #[cfg(any(target_os = "macos", windows))]
    guard: Option<platform::Guard>,
}

#[derive(Default)]
pub(super) struct Capture(Mutex<Lease>);

impl Capture {
    /// An old callback must not release a newer window's guard. Drop native
    /// resources after unlocking: removal can marshal back onto the UI thread.
    fn release(&self, voice: &RemoteVoice, expected: Option<u64>) -> Option<u64> {
        let mut lease = self.0.lock().unwrap();
        if expected.is_some_and(|generation| generation != lease.generation) {
            return None;
        }
        lease.generation += 1;
        let generation = lease.generation;
        voice.set_demo_mode(false);
        #[cfg(any(target_os = "macos", windows))]
        let guard = lease.guard.take();
        drop(lease);
        #[cfg(any(target_os = "macos", windows))]
        drop(guard);
        Some(generation)
    }

    pub(super) fn stop(&self, voice: &RemoteVoice) {
        let _ = self.release(voice, None);
    }

    #[cfg(any(target_os = "macos", windows))]
    pub(super) fn start(
        &self,
        window: &WebviewWindow,
        core: &Arc<AppCore>,
        feedback: Option<Channel<KeyEdge>>,
    ) -> Result<bool, String> {
        let generation = self.release(&core.remote_voice, None).unwrap();
        let focused =
            || window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false);
        if !focused() {
            return Ok(false);
        }
        {
            let lease = self.0.lock().unwrap();
            if lease.generation != generation {
                return Ok(false);
            }
            // A BLE Home/voice action can arrive while the OS hook is being installed.
            core.remote_voice.set_demo_mode(true);
        }

        // A native hook never waits on IPC. Only diagram keys enter the queue.
        let (sender, mut edges) = tokio::sync::broadcast::channel(64);
        let result = platform::Guard::start(
            window,
            Arc::new(move |key, pressed| {
                if matches!(
                    key,
                    "up" | "down"
                        | "left"
                        | "right"
                        | "ok"
                        | "back"
                        | "home"
                        | "menu"
                        | "volume"
                        | "voice"
                        | "power"
                        | "tv"
                        | "ended"
                        | "unavailable"
                ) {
                    let _ = sender.send(KeyEdge { key, pressed });
                }
            }),
        );
        let guard = match result {
            Ok(guard) if focused() => guard,
            result => {
                let _ = self.release(&core.remote_voice, Some(generation));
                return result.map(|_| false);
            }
        };
        {
            let mut lease = self.0.lock().unwrap();
            if lease.generation != generation {
                return Ok(false);
            }
            lease.guard = Some(guard);
        }

        let core = Arc::downgrade(core);
        tauri::async_runtime::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            let reason = loop {
                match edges.recv().await {
                    Ok(edge) if matches!(edge.key, "ended" | "unavailable") => break edge.key,
                    Ok(edge) => {
                        if feedback
                            .as_ref()
                            .is_some_and(|channel| channel.send(edge).is_err())
                        {
                            break "ended";
                        }
                    }
                    Err(RecvError::Closed) => break "ended",
                    Err(RecvError::Lagged(_)) => break "unavailable",
                }
            };
            if let Some(core) = core.upgrade() {
                let _ = core
                    .remote_demo
                    .release(&core.remote_voice, Some(generation));
            }
            if let Some(channel) = feedback {
                let _ = channel.send(KeyEdge {
                    key: reason,
                    pressed: false,
                });
            }
        });
        Ok(true)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub(super) fn start(
        &self,
        _: &WebviewWindow,
        _: &Arc<AppCore>,
        _: Option<Channel<KeyEdge>>,
    ) -> Result<bool, String> {
        Err("当前系统不支持演示按键拦截。".into())
    }
}
