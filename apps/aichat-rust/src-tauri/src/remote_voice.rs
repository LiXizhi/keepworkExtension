//! Native ATVV dictation. Audio and text stay out of the renderer/MCP bridge
//! and are never persisted. Only completed PTT audio goes to Keepwork ASR.
mod asr;
mod atvv;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod ble;
mod native_input;

use crate::files::atomic_json_write;
use native_input::{Delivery, NativeInput, Target};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    pub device: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSnapshot {
    pub supported: bool,
    pub running: bool,
    pub state: String,
    pub error: String,
    pub device: String,
    pub config: VoiceConfig,
}
struct Inner {
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    native: Option<Arc<NativeInput>>,
    snapshot: VoiceSnapshot,
}
pub struct RemoteVoice {
    config_path: PathBuf,
    inner: Mutex<Inner>,
}
impl RemoteVoice {
    pub fn new(profile: &Path) -> Self {
        let config_path = profile.join("remote-voice/config.json");
        // Ignore old optional environment/model preferences, retain user data.
        // Neither configuration format starts input without a user action.
        let config = std::fs::read(&config_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            config_path,
            inner: Mutex::new(Inner {
                generation: 0,
                cancel: None,
                native: None,
                snapshot: VoiceSnapshot {
                    supported: cfg!(any(target_os = "windows", target_os = "macos")),
                    running: false,
                    state: "stopped".into(),
                    error: String::new(),
                    device: String::new(),
                    config,
                },
            }),
        }
    }
    pub fn snapshot(&self) -> VoiceSnapshot {
        self.inner.lock().unwrap().snapshot.clone()
    }

    pub fn start(self: &Arc<Self>, mut config: VoiceConfig) -> Result<VoiceSnapshot, String> {
        config.device = config.device.trim().to_string();
        if config.device.len() > 256 || config.device.contains('\0') {
            return Err("蓝牙设备 ID 无效。".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if !inner.snapshot.supported {
            return Err("遥控器语音输入目前支持 Windows 和 macOS。".into());
        }
        if inner.snapshot.running {
            return Err("语音输入正在运行或停止中，请稍后重试。".into());
        }
        let native = Arc::new(NativeInput::new()?);
        atomic_json_write(&self.config_path, &config)?;
        let (cancel, receiver) = watch::channel(false);
        inner.generation += 1;
        let generation = inner.generation;
        inner.cancel = Some(cancel);
        inner.native = Some(Arc::clone(&native));
        inner.snapshot.config = config.clone();
        inner.snapshot.running = true;
        inner.snapshot.state = "scanning".into();
        inner.snapshot.error.clear();
        inner.snapshot.device.clear();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let service = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                let result = ble::run(&service, generation, config, native, receiver).await;
                service.finish(generation, result.err());
            });
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (generation, receiver);
        Ok(inner.snapshot.clone())
    }
    pub fn stop(&self) -> VoiceSnapshot {
        let mut inner = self.inner.lock().unwrap();
        if let Some(cancel) = &inner.cancel {
            let _ = cancel.send(true);
        }
        if let Some(native) = &inner.native {
            native.stop();
        }
        inner.snapshot.state = if inner.snapshot.running {
            "stopping"
        } else {
            "stopped"
        }
        .into();
        inner.snapshot.error.clear();
        inner.snapshot.clone()
    }
    fn current(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.generation == generation
            && inner.snapshot.running
            && inner.cancel.as_ref().is_some_and(|c| !*c.borrow())
    }
    fn update(&self, generation: u64, state: &str, error: &str, device: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) {
            return;
        }
        inner.snapshot.state = state.into();
        inner.snapshot.error = error.chars().take(500).collect();
        if let Some(device) = device {
            inner.snapshot.device = device.chars().take(256).collect();
        }
    }
    fn arm(&self, generation: u64) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) {
            return Err("已停止。".into());
        }
        inner.native.as_ref().ok_or("系统输入未就绪。")?.start()
    }
    fn disarm(&self, generation: u64) {
        let inner = self.inner.lock().unwrap();
        if inner.generation == generation {
            if let Some(native) = &inner.native {
                native.stop();
            }
        }
    }
    fn deliver(&self, generation: u64, text: &str, target: &Option<Target>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) {
            return;
        }
        let Some(native) = &inner.native else {
            return;
        };
        match native.deliver(text, target) {
            Ok(Delivery::Pasted) => {
                inner.snapshot.state = "pasted".into();
                inner.snapshot.error.clear();
            }
            Ok(Delivery::Copied) => {
                inner.snapshot.state = "copied".into();
                inner.snapshot.error = "光标或前台应用已变化，识别文字已复制，请手动粘贴。".into();
            }
            Ok(Delivery::Cancelled) => {}
            Err(error) => {
                inner.snapshot.state = "error".into();
                inner.snapshot.error = error;
            }
        }
    }
    fn finish(&self, generation: u64, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return;
        }
        if let Some(native) = inner.native.take() {
            native.stop();
        }
        let cancelled = inner.cancel.take().is_none_or(|c| *c.borrow());
        inner.snapshot.running = false;
        if let Some(error) = error.filter(|_| !cancelled) {
            inner.snapshot.state = "error".into();
            inner.snapshot.error = error;
        } else {
            inner.snapshot.state = "stopped".into();
            inner.snapshot.error.clear();
        }
    }
}
impl Drop for RemoteVoice {
    fn drop(&mut self) {
        self.stop();
    }
}
pub(super) async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_configuration_keeps_device_but_cannot_restore_environment_or_auto_start() {
        let dir = std::env::temp_dir().join(format!("voice-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("remote-voice")).unwrap();
        std::fs::write(
            dir.join("remote-voice/config.json"),
            br#"{"python":"old-exe","model":"old-model","device":"RC003"}"#,
        )
        .unwrap();
        let voice = RemoteVoice::new(&dir);
        let snapshot = voice.snapshot();
        assert_eq!(snapshot.config.device, "RC003");
        assert!(!snapshot.running);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("old-exe") && !json.contains("old-model"));
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn cancelled_generation_never_changes_status_or_delivers_late_text() {
        let voice = RemoteVoice::new(Path::new("unused-voice-fixture"));
        let (cancel, _receiver) = watch::channel(false);
        {
            let mut inner = voice.inner.lock().unwrap();
            inner.generation = 1;
            inner.cancel = Some(cancel);
            inner.snapshot.running = true;
        }
        voice.update(1, "recording", "", None);
        assert_eq!(voice.snapshot().state, "recording");
        voice.stop();
        voice.update(1, "pasted", "", None);
        voice.deliver(1, "private transcript", &None);
        assert_eq!(voice.snapshot().state, "stopping");
        voice.finish(1, Some("late network failure".into()));
        assert_eq!(voice.snapshot().state, "stopped");
        assert!(!serde_json::to_string(&voice.snapshot())
            .unwrap()
            .contains("private transcript"));
    }
}
