//! Native ATVV dictation. Audio and text stay out of the renderer/MCP bridge
//! and are never persisted. Only completed PTT audio goes to Keepwork ASR.
mod asr;
mod atvv;
mod auto_start;
mod buttons;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod ble;
mod native_input;
mod paired;

use crate::files::atomic_json_write;
use auto_start::AutoPolicy;
use native_input::{Delivery, NativeInput};
use buttons::{ButtonAction, ButtonStatus, Buttons};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    pub device: String,
    pub auto_start: bool,
}
impl Default for VoiceConfig {
    fn default() -> Self {
        Self { device: String::new(), auto_start: true }
    }
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
    pub buttons: ButtonStatus,
    pub auto_paused: bool,
}
struct Inner {
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    native: Option<Arc<NativeInput>>,
    buttons: Buttons,
    snapshot: VoiceSnapshot,
    automatic: AutoPolicy,
}
pub struct RemoteVoice {
    config_path: PathBuf,
    inner: Mutex<Inner>,
    auto_events: watch::Sender<()>,
}
impl RemoteVoice {
    pub fn new(profile: &Path) -> Self {
        let config_path = profile.join("remote-voice/config.json");
        // Missing preferences opt into the requested paired-device default.
        // A damaged/unreadable file cannot silently undo a saved opt-out.
        let (config, error) = match std::fs::read(&config_path) {
            Ok(bytes) => match serde_json::from_slice::<VoiceConfig>(&bytes) {
                Ok(config) => (config, String::new()),
                Err(_) => (VoiceConfig { auto_start: false, ..Default::default() }, "遥控器配置无法读取，自动开启已暂停。请在设置中重新选择自动开启。".into()),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (VoiceConfig::default(), String::new()),
            Err(_) => (VoiceConfig { auto_start: false, ..Default::default() }, "无法读取遥控器配置，自动开启已暂停。请检查配置文件权限。".into()),
        };
        let (auto_events, _) = watch::channel(());
        Self {
            config_path,
            auto_events,
            inner: Mutex::new(Inner {
                generation: 0,
                cancel: None,
                native: None,
                buttons: Buttons::new(),
                automatic: AutoPolicy::default(),
                snapshot: VoiceSnapshot {
                    supported: cfg!(any(target_os = "windows", target_os = "macos")),
                    running: false,
                    state: if error.is_empty() { "stopped" } else { "auto-error" }.into(),
                    error,
                    device: String::new(),
                    config,
                    buttons: Buttons::new().status(),
                    auto_paused: false,
                },
            }),
        }
    }
    pub fn snapshot(&self) -> VoiceSnapshot {
        let inner = self.inner.lock().unwrap();
        Self::snapshot_locked(&inner)
    }
    fn snapshot_locked(inner: &Inner) -> VoiceSnapshot {
        let mut snapshot = inner.snapshot.clone();
        snapshot.buttons = inner.buttons.status();
        snapshot.auto_paused = inner.automatic.suppressed && snapshot.config.auto_start;
        snapshot
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
        if inner.automatic.shutdown { return Err("客户端正在退出。".into()); }
        inner.automatic.explicit_start();
        let result = self.launch_locked(&mut inner, config, true);
        if result.is_err() { inner.automatic.block(); }
        self.auto_events.send_replace(());
        result.map(|()| Self::snapshot_locked(&inner))
    }
    fn launch_locked(self: &Arc<Self>, inner: &mut Inner, config: VoiceConfig, save: bool) -> Result<(), String> {
        let native = Arc::new(NativeInput::new()?);
        if save {
            atomic_json_write(&self.config_path, &config)?;
            inner.snapshot.config = config.clone();
        }
        let (cancel, receiver) = watch::channel(false);
        inner.generation += 1;
        let generation = inner.generation;
        inner.cancel = Some(cancel);
        inner.native = Some(Arc::clone(&native));
        inner.snapshot.running = true;
        inner.snapshot.state = "scanning".into();
        inner.snapshot.error.clear();
        inner.snapshot.device.clear();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let service = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                let result = ble::run(&service, generation, config, receiver).await;
                service.finish(generation, result.err());
            });
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (generation, receiver);
        Ok(())
    }
    pub fn stop(&self) -> VoiceSnapshot {
        let mut inner = self.inner.lock().unwrap();
        inner.automatic.pause();
        Self::stop_locked(&mut inner);
        self.auto_events.send_replace(());
        Self::snapshot_locked(&inner)
    }
    fn stop_locked(inner: &mut Inner) {
        if let Some(cancel) = &inner.cancel {
            let _ = cancel.send(true);
        }
        inner.buttons.stop();
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
    }
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.automatic.close();
        Self::stop_locked(&mut inner);
        self.auto_events.send_replace(());
    }
    pub fn set_auto_start(&self, enabled: bool) -> Result<VoiceSnapshot, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.automatic.shutdown { return Err("客户端正在退出。".into()); }
        let mut config = inner.snapshot.config.clone();
        config.auto_start = enabled;
        atomic_json_write(&self.config_path, &config)?;
        inner.snapshot.config = config;
        if enabled {
            inner.automatic.explicit_start();
            if !inner.snapshot.running {
                inner.snapshot.state = "waiting-paired".into();
                inner.snapshot.error.clear();
            }
        } else {
            inner.automatic.pause();
            Self::stop_locked(&mut inner);
        }
        self.auto_events.send_replace(());
        Ok(Self::snapshot_locked(&inner))
    }

    /// Passive inventory only until a paired remote is confirmed. The monitor
    /// never creates a voice session after Stop/Off/manual Start/Exit wins.
    pub fn start_automatic(self: &Arc<Self>) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.automatic.monitor_started || inner.automatic.shutdown { return; }
            inner.automatic.monitor_started = true;
            let mut changes = self.auto_events.subscribe();
            let weak = Arc::downgrade(self);
            tauri::async_runtime::spawn(async move {
                loop {
                    let Some(service) = weak.upgrade() else { return; };
                    let ticket = {
                        let inner = service.inner.lock().unwrap();
                        if inner.automatic.shutdown { return; }
                        inner.automatic.ticket(inner.snapshot.config.auto_start, inner.snapshot.running)
                            .map(|revision| (revision, inner.snapshot.config.clone()))
                    };
                    drop(service);
                    if let Some((revision, config)) = ticket {
                        let result = tokio::select! {
                            biased;
                            _=changes.changed()=>continue,
                            result=tokio::time::timeout(std::time::Duration::from_secs(10), paired::paired_remote(&config.device))=>result.unwrap_or_else(|_| Err("检查已配对遥控器超时，自动开启已暂停；可手动启动重试。".into())),
                        };
                        if let Some(service) = weak.upgrade() { service.apply_auto_probe(revision, result); }
                    }
                    tokio::select! {
                        biased;
                        result=changes.changed()=>if result.is_err() { return; },
                        _=tokio::time::sleep(std::time::Duration::from_secs(3))=>{},
                    }
                }
            });
        }
    }
    fn apply_auto_probe(self: &Arc<Self>, revision: u64, result: Result<Option<String>, String>) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.automatic.accepts(revision, inner.snapshot.config.auto_start, inner.snapshot.running) { return; }
        match result {
            Ok(None) => {
                inner.snapshot.state = "waiting-paired".into();
                inner.snapshot.error.clear();
            }
            Ok(Some(device)) => {
                let mut runtime_config = inner.snapshot.config.clone();
                if runtime_config.device.is_empty() { runtime_config.device = device; }
                inner.automatic.explicit_start();
                if let Err(error) = self.launch_locked(&mut inner, runtime_config, false) {
                    inner.automatic.block();
                    inner.snapshot.state = "auto-error".into();
                    inner.snapshot.error = error;
                }
            }
            Err(error) => {
                inner.automatic.block();
                inner.snapshot.state = "auto-error".into();
                inner.snapshot.error = error.chars().take(500).collect();
            }
        }
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
        inner.native.as_ref().ok_or("系统输入未就绪。")?.start()?;
        // Button availability is optional; it cannot disable working dictation.
        let _ = inner.buttons.start();
        Ok(())
    }
    fn disarm(&self, generation: u64) {
        let inner = self.inner.lock().unwrap();
        if inner.generation == generation {
            inner.buttons.stop();
            if let Some(native) = &inner.native {
                native.stop();
            }
        }
    }
    fn deliver(&self, generation: u64, text: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) {
            return;
        }
        let Some(native) = &inner.native else {
            return;
        };
        let result = native.deliver(text);
        Self::input_result(&mut inner.snapshot, result);
    }
    fn poll_clear(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.generation == generation
            && inner.cancel.as_ref().is_some_and(|c| !*c.borrow())
            && matches!(inner.buttons.poll(), Some(ButtonAction::Clear))
    }
    // The BLE loop cancels the utterance before invoking this mutation.
    fn clear(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return; }
        let Some(native) = &inner.native else { return; };
        let result = native.clear();
        Self::input_result(&mut inner.snapshot, result);
    }
    fn input_result(snapshot: &mut VoiceSnapshot, result: Result<Delivery, String>) {
        match result {
            Ok(Delivery::Submitted) => {
                snapshot.state = "submitted".into();
                snapshot.error.clear();
            }
            Ok(Delivery::Pasted) => {
                snapshot.state = "pasted".into();
                snapshot.error.clear();
            }
            Ok(Delivery::Cleared) => {
                snapshot.state = "cleared".into();
                snapshot.error.clear();
            }
            Ok(Delivery::NotEditable) => {
                snapshot.state = "input-blocked".into();
                snapshot.error = "当前录音/识别已取消。请先点击可编辑输入框，再清空；未发送删除按键。".into();
            }
            Ok(Delivery::ModifiersHeld) => {
                snapshot.state = "input-blocked".into();
                snapshot.error =
                    "请先松开 Ctrl、Alt、Shift、Command 或 Win 修饰键，再重新录制。".into();
            }
            Ok(Delivery::Cancelled) => {}
            Err(error) => {
                snapshot.state = "error".into();
                snapshot.error = error;
            }
        }
    }
    fn finish(&self, generation: u64, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return;
        }
        inner.buttons.stop();
        if let Some(native) = inner.native.take() {
            native.stop();
        }
        let cancelled = inner.cancel.take().is_none_or(|c| *c.borrow());
        inner.snapshot.running = false;
        if let Some(error) = error.filter(|_| !cancelled) {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            let waiting_for_radio = error == ble::BLUETOOTH_OFF || error == ble::NO_ADAPTER;
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let waiting_for_radio = false;
            // A permission/configuration failure must not launch a fresh
            // automatic session every poll. Manual retry re-enables probing.
            if !waiting_for_radio { inner.automatic.block(); }
            inner.snapshot.state = if waiting_for_radio && inner.snapshot.config.auto_start { "waiting-paired" } else { "error" }.into();
            inner.snapshot.error = error;
        } else {
            inner.snapshot.state = "stopped".into();
            inner.snapshot.error.clear();
        }
    }
}
impl Drop for RemoteVoice {
    fn drop(&mut self) {
        self.shutdown();
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
    fn old_configuration_keeps_device_and_opts_into_pairing_without_restoring_legacy_environment() {
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
        assert!(snapshot.config.auto_start);
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
        voice.deliver(1, "private transcript");
        voice.deliver(1, "发送提示词。");
        assert_eq!(voice.snapshot().state, "stopping");
        voice.finish(1, Some("late network failure".into()));
        assert_eq!(voice.snapshot().state, "stopped");
        assert!(!serde_json::to_string(&voice.snapshot())
            .unwrap()
            .contains("private transcript"));
    }

    fn auto_profile(name: &str) -> PathBuf {
        let profile = std::env::temp_dir().join(format!("voice-auto-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(profile.join("remote-voice")).unwrap();
        profile
    }
    fn assert_no_native_session(voice: &RemoteVoice) {
        let inner = voice.inner.lock().unwrap();
        assert_eq!(inner.generation, 0);
        assert!(inner.native.is_none());
        assert!(inner.cancel.is_none());
        assert!(!inner.snapshot.running);
        assert_eq!(inner.buttons.poll(), None);
    }

    #[test]
    fn automatic_start_defaults_true_for_new_and_valid_legacy_configs_but_preserves_explicit_false() {
        assert!(VoiceConfig::default().auto_start);
        for (json, expected) in [(None, true), (Some("{}"), true),
            (Some(r#"{"device":"saved-device"}"#), true),
            (Some(r#"{"device":"saved-device","autoStart":false}"#), false)] {
            let profile = auto_profile("config");
            let path = profile.join("remote-voice/config.json");
            if let Some(json) = json { std::fs::write(&path, json).unwrap(); }
            let voice = RemoteVoice::new(&profile);
            assert_eq!(voice.snapshot().config.auto_start, expected);
            assert_no_native_session(&voice);
            if let Some(json) = json { assert_eq!(std::fs::read_to_string(&path).unwrap(), json); }
            else { assert!(!path.exists(), "reading defaults does not write preferences"); }
            drop(voice);
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[test]
    fn damaged_or_unreadable_preferences_fail_closed_without_overwriting_user_data() {
        let profile = auto_profile("damaged");
        let path = profile.join("remote-voice/config.json");
        let damaged = b"{this is not valid json";
        std::fs::write(&path, damaged).unwrap();
        let voice = RemoteVoice::new(&profile);
        assert!(!voice.snapshot().config.auto_start);
        assert_eq!(voice.snapshot().state, "auto-error");
        assert!(!voice.snapshot().error.is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), damaged);
        assert_no_native_session(&voice);
        drop(voice);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap(); // Read error works on every platform without chmod/elevation.
        let voice = RemoteVoice::new(&profile);
        assert!(!voice.snapshot().config.auto_start && path.is_dir());
        assert_no_native_session(&voice);
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn automatic_preference_persists_while_manual_stop_only_suppresses_this_process() {
        let profile = auto_profile("preference");
        let voice = RemoteVoice::new(&profile);
        voice.stop();
        assert!(voice.snapshot().config.auto_start && voice.snapshot().auto_paused);
        let reopened = RemoteVoice::new(&profile);
        assert!(reopened.snapshot().config.auto_start && !reopened.snapshot().auto_paused);
        assert!(!voice.set_auto_start(false).unwrap().config.auto_start);
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(voice.config_path.clone()).unwrap()).unwrap();
        assert_eq!(saved["autoStart"], false);
        let disabled = RemoteVoice::new(&profile);
        assert!(!disabled.snapshot().config.auto_start);
        assert!(voice.set_auto_start(true).unwrap().config.auto_start);
        let enabled = RemoteVoice::new(&profile);
        assert!(enabled.snapshot().config.auto_start && !enabled.snapshot().auto_paused);
        for instance in [&voice, &reopened, &disabled, &enabled] { assert_no_native_session(instance); }
        drop((voice, reopened, disabled, enabled));
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn stop_off_manual_start_intent_and_shutdown_all_reject_late_paired_probe_results() {
        for intent in 0..4 {
            let profile = auto_profile("stale");
            let voice = Arc::new(RemoteVoice::new(&profile));
            let revision = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
            match intent {
                0 => { voice.stop(); }
                1 => { voice.set_auto_start(false).unwrap(); }
                2 => voice.inner.lock().unwrap().automatic.explicit_start(),
                _ => voice.shutdown(),
            }
            let state = voice.snapshot().state;
            // This is deliberately an invalidated Some result: never exercise
            // the valid launch branch or create a real BLE/native session.
            voice.apply_auto_probe(revision, Ok(Some("stale-device-must-never-launch".into())));
            voice.apply_auto_probe(revision, Err("stale permission error".into()));
            assert_eq!(voice.snapshot().state, state);
            assert_no_native_session(&voice);
            drop(voice);
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[test]
    fn no_paired_device_does_not_launch_and_probe_errors_block_repeated_automatic_attempts() {
        let profile = auto_profile("empty-or-denied");
        let voice = Arc::new(RemoteVoice::new(&profile));
        let revision = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
        voice.apply_auto_probe(revision, Ok(None));
        assert_eq!(voice.snapshot().state, "waiting-paired");
        assert_no_native_session(&voice);
        voice.apply_auto_probe(revision, Err("permission denied fixture".into()));
        assert_eq!(voice.snapshot().state, "auto-error");
        assert!(voice.inner.lock().unwrap().automatic.ticket(true, false).is_none());
        voice.apply_auto_probe(revision, Ok(None));
        assert_eq!(voice.snapshot().error, "permission denied fixture");
        assert_no_native_session(&voice);
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn disabling_automatic_start_cancels_an_existing_session_and_prevents_late_voice_actions() {
        let profile = auto_profile("off-cancels");
        let voice = RemoteVoice::new(&profile);
        let (cancel, receiver) = watch::channel(false);
        {
            let mut inner = voice.inner.lock().unwrap();
            inner.generation = 1;
            inner.cancel = Some(cancel);
            inner.snapshot.running = true;
        }
        let snapshot = voice.set_auto_start(false).unwrap();
        assert!(!snapshot.config.auto_start && *receiver.borrow());
        assert_eq!(snapshot.state, "stopping");
        voice.deliver(1, "late transcript");
        voice.deliver(1, "发送提示词");
        assert_eq!(voice.snapshot().state, "stopping");
        voice.finish(1, Some("late backend error".into()));
        assert!(!voice.snapshot().running);
        assert_eq!(voice.snapshot().state, "stopped");
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }
}
