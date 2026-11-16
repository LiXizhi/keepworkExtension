//! Native ATVV dictation. Audio goes directly to Keepwork ASR; transcripts are
//! delivered only to the current editor and are never persisted or sent to MCP.
#[path = "remote_voice/asr.rs"]
mod asr;
#[path = "remote_voice/atvv.rs"]
mod atvv;
#[path = "remote_voice/auto_start.rs"]
mod auto_start;
#[path = "remote_voice/buttons.rs"]
mod buttons;
#[path = "remote_voice/gestures.rs"]
mod gestures;
#[path = "remote_voice/dialogue.rs"]
pub(crate) mod dialogue;
#[cfg(windows)]
#[path = "remote_voice/home_windows.rs"]
pub(crate) mod home_windows;
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[path = "remote_voice/ble.rs"]
mod ble;
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[path = "remote_voice/focus_highlight.rs"]
mod focus_highlight;
#[path = "remote_voice/native_input.rs"]
mod native_input;
#[path = "remote_voice/paired.rs"]
mod paired;
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[path = "remote_voice/power.rs"]
mod power;

use crate::files::atomic_json_write;
use auto_start::AutoPolicy;
use native_input::{Delivery, NativeInput};
use buttons::{ButtonStatus, Buttons};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub(crate) type RecordingFocus = Result<Option<tokio::sync::oneshot::Receiver<bool>>, String>;
pub(crate) enum RecordingPhase { Recording, Preview(String), Transcribing, NoAudio, End }
/// A caption shows the newest words. Keep the full transcript only in the recognizer.
pub(crate) fn preview_tail(text: &str) -> &str {
    let start = text.char_indices().rev().nth(159).map_or(0, |(i, _)| i);
    &text[start..]
}

pub(crate) type PetDelivery = dyn Fn(&str, &str) -> Result<tokio::sync::oneshot::Receiver<bool>, String> + Send + Sync;

pub(crate) struct RecordingFeedback {
    pub(crate) pet_delivery: Option<Box<PetDelivery>>,
    pub(crate) focus: Option<tokio::sync::oneshot::Receiver<bool>>,
    pub(crate) notify: Box<dyn Fn(RecordingPhase) + Send + Sync>,
}
impl Drop for RecordingFeedback {
    fn drop(&mut self) { (self.notify)(RecordingPhase::End); }
}
pub(crate) type RecordingTarget = Result<Option<RecordingFeedback>, String>;
type RecordingFocusCallback = dyn Fn() -> RecordingTarget + Send + Sync;
type ComposerFocusCallback = dyn Fn() -> RecordingFocus + Send + Sync;

#[derive(Debug, PartialEq)]
pub(crate) enum ComposerDelivery { NotApplicable, Inserted }
pub(crate) type ComposerDeliveryRequest = Result<Option<tokio::sync::oneshot::Receiver<Result<ComposerDelivery, String>>>, String>;
type ComposerDeliveryCallback = dyn Fn(u64, &str) -> ComposerDeliveryRequest + Send + Sync;

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
    session_config: Option<VoiceConfig>,
    resume_config: Option<VoiceConfig>,
}
pub(crate) enum BackRoute { Pet, MainComposer, Native }

pub struct RemoteVoice {
    pub(crate) dialogue: Arc<dialogue::Dialogue>,
    config_path: PathBuf,
    inner: Mutex<Inner>,
    auto_events: watch::Sender<()>,
    recording_focus: std::sync::OnceLock<Box<RecordingFocusCallback>>,
    composer_focus: std::sync::OnceLock<Box<ComposerFocusCallback>>,
    composer_delivery: std::sync::OnceLock<Box<ComposerDeliveryCallback>>,
    home_pressed: std::sync::OnceLock<Box<dyn Fn(u64) + Send + Sync>>,
    back_route: std::sync::OnceLock<Box<dyn Fn(u64) -> Result<BackRoute, String> + Send + Sync>>,
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
            recording_focus: std::sync::OnceLock::new(),
            composer_focus: std::sync::OnceLock::new(),
            composer_delivery: std::sync::OnceLock::new(),
            dialogue: Arc::new(dialogue::Dialogue::default()),
            home_pressed: std::sync::OnceLock::new(),
            back_route: std::sync::OnceLock::new(),
            inner: Mutex::new(Inner {
                generation: 0,
                cancel: None,
                native: None,
                buttons: Buttons::new(),
                automatic: AutoPolicy::default(),
                session_config: None,
                resume_config: None,
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
    pub(crate) fn pet_readiness(&self) -> String {
        let inner = self.inner.lock().unwrap();
        let voice = &inner.snapshot;
        if voice.state == "waiting-paired" && voice.config.device.is_empty() && voice.device.is_empty() {
            return String::new();
        }
        voice.state.clone()
    }
    pub(crate) fn set_recording_focus(&self, callback: impl Fn() -> RecordingTarget + Send + Sync + 'static) {
        let _ = self.recording_focus.set(Box::new(callback));
    }
    pub(crate) fn set_composer_focus(&self, callback: impl Fn() -> RecordingFocus + Send + Sync + 'static) {
        let _ = self.composer_focus.set(Box::new(callback));
    }
    pub(crate) fn set_composer_delivery(&self, callback: impl Fn(u64, &str) -> ComposerDeliveryRequest + Send + Sync + 'static) {
        let _ = self.composer_delivery.set(Box::new(callback));
    }
    pub(crate) fn set_home_pressed(&self, callback: impl Fn(u64) + Send + Sync + 'static) {
        let _ = self.home_pressed.set(Box::new(callback));
    }
    pub(crate) fn set_back_route(&self, callback: impl Fn(u64) -> Result<BackRoute, String> + Send + Sync + 'static) {
        let _ = self.back_route.set(Box::new(callback));
    }
    fn prepare_composer(&self) -> RecordingFocus {
        self.composer_focus.get().map_or(Ok(None), |callback| callback())
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn prepare_recording_focus(&self, generation: u64) -> RecordingTarget {
        if !self.current(generation) {
            return Err("语音输入已停止。".into());
        }
        // The host can inspect the pet/window state without holding the voice lock.
        let pet = self.recording_focus.get().map_or(Ok(None), |callback| callback())?;
        Ok(Some(pet.unwrap_or_else(|| {
            // Allow native focus restoration to finish without delaying microphone capture.
            // The paste path independently confirms the target after recognition.
            if let Ok(Some(ready)) = self.prepare_composer() {
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), ready).await;
                });
            }
            focus_highlight::start()
        })))
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
        if inner.automatic.asleep() { return Err("电脑休眠中，请在唤醒后启动。".into()); }
        inner.resume_config = None;
        // Only a Start click from the verified local settings can request input consent.
        #[cfg(target_os = "macos")]
        if let Err(error) = NativeInput::request_permissions() {
            // Preserve the selected target. A matching automatic preference may
            // keep checking consent; a different unsaved target requires retry.
            if config.auto_start && inner.snapshot.config.auto_start
                && inner.snapshot.config.device == config.device {
                inner.automatic.explicit_start();
            } else {
                inner.automatic.block();
            }
            inner.snapshot.state = "needs-permission".into();
            inner.snapshot.error = error;
            self.auto_events.send_replace(());
            return Ok(Self::snapshot_locked(&inner));
        }
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
        inner.session_config = Some(config.clone());
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
        inner.resume_config = None;
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

    fn power_changed(&self, sleeping: bool) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.automatic.power_changed(sleeping) { return; }
        // Revoke the old recording synchronously. Its BLE task owns subscription cleanup.
        // A wake without a prior sleep notification can also invalidate a stale connection.
        if let Some(cancel) = inner.cancel.as_ref().filter(|c| !*c.borrow()) {
            cancel.send_replace(true);
            inner.resume_config = inner.session_config.take().map(|mut config| {
                if config.device.is_empty() { config.device.clone_from(&inner.snapshot.device); }
                config
            });
        }
        if inner.resume_config.is_some() {
            inner.snapshot.state = if sleeping { "sleeping" } else { "reconnecting" }.into();
            inner.snapshot.error.clear();
        }
        self.auto_events.send_replace(());
    }

    fn take_resume(inner: &mut Inner) -> Option<VoiceConfig> {
        if inner.snapshot.running || inner.automatic.asleep() || inner.automatic.shutdown { return None; }
        inner.resume_config.take()
    }

    /// Passive inventory only until a paired remote is confirmed. The monitor
    /// never creates a voice session after Stop/Off/manual Start/Exit wins.
    pub fn start_automatic(self: &Arc<Self>, show_setup: impl Fn() -> bool + Send + 'static,
        foreground: impl Fn() -> bool + Send + 'static) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            power::observe(self);
            let mut inner = self.inner.lock().unwrap();
            if inner.automatic.monitor_started || inner.automatic.shutdown { return; }
            inner.automatic.monitor_started = true;
            let mut changes = self.auto_events.subscribe();
            let weak = Arc::downgrade(self);
            tauri::async_runtime::spawn(async move {
                let mut setup_shown = false;
                loop {
                    let Some(service) = weak.upgrade() else { return; };
                    let ticket = {
                        let mut inner = service.inner.lock().unwrap();
                        if inner.automatic.shutdown { return; }
                        if let Some(config) = Self::take_resume(&mut inner) {
                            // The previous generation is fully disarmed before a new one starts.
                            if let Err(error) = service.launch_locked(&mut inner, config, false) {
                                inner.automatic.block();
                                inner.snapshot.state = "error".into();
                                inner.snapshot.error = error;
                            }
                        }
                        inner.automatic.ticket(inner.snapshot.config.auto_start, inner.snapshot.running)
                            .map(|revision| (revision, inner.snapshot.config.clone()))
                    };
                    drop(service);
                    if let Some((revision, config)) = ticket {
                        let result = tokio::select! {
                            biased;
                            _=changes.changed()=>continue,
                            result=tokio::time::timeout(std::time::Duration::from_secs(10), paired::paired_remote(&config.device))=>result.unwrap_or_else(|_| Ok(paired::Probe::Retry("检查已配对遥控器超时，正在等待重试。".into()))),
                        };
                        if let Some(service) = weak.upgrade() {
                            let bluetooth_permission = matches!(&result, Ok(paired::Probe::NeedsBluetoothPermission));
                            let needs_permission = service.apply_auto_probe(revision, result);
                            if bluetooth_permission {
                                let request = {
                                    let focused = foreground();
                                    let mut inner = service.inner.lock().unwrap();
                                    let enabled = inner.snapshot.config.auto_start;
                                    let running = inner.snapshot.running;
                                    inner.automatic.request_bluetooth(revision, enabled, running, focused)
                                };
                                if request {
                                    drop(service);
                                    #[cfg(target_os = "macos")]
                                    tokio::select! {
                                        biased;
                                        _ = changes.changed() => continue,
                                        _ = ble::prepare_bluetooth() => {},
                                    }
                                }
                            } else if needs_permission && !setup_shown { setup_shown = show_setup(); }
                        }
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
    fn apply_auto_probe(self: &Arc<Self>, revision: u64, result: Result<paired::Probe, String>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.automatic.accepts(revision, inner.snapshot.config.auto_start, inner.snapshot.running) { return false; }
        match result {
            Ok(paired::Probe::Waiting) => {
                inner.snapshot.state = "waiting-paired".into();
                inner.snapshot.error.clear();
            }
            Ok(paired::Probe::Retry(message)) => {
                inner.snapshot.state = "waiting-paired".into();
                inner.snapshot.error = message;
            }
            Ok(paired::Probe::NeedsPermission(message)) => {
                inner.snapshot.state = "needs-permission".into();
                inner.snapshot.error = message.into();
                return true;
            }
            Ok(paired::Probe::NeedsBluetoothPermission) => {
                inner.snapshot.state = "needs-permission".into();
                inner.snapshot.error = "已检测到遥控器。请在 Keepwork 位于前台时允许系统蓝牙授权；授权后将自动继续连接。".into();
                return true;
            }
            Ok(paired::Probe::Available(device)) => {
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
        false
    }
    pub(crate) fn current(&self, generation: u64) -> bool {
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
            dialogue::release_device();
            inner.buttons.stop();
            if let Some(native) = &inner.native {
                native.stop();
            }
        }
    }
    async fn deliver_composer_text(&self, generation: u64, text: &str, complete: bool) -> Result<Option<Delivery>, String> {
        if !self.current(generation) || text.trim().is_empty() { return Ok(Some(Delivery::Cancelled)); }
        if text.len() > 64_000 || text.contains('\0') { return Err("识别文字超出长度限制或包含无效字符。".into()); }
        // Exact, complete commands keep their existing native semantics. A
        // partial command and ordinary sentences remain literal dictation.
        if complete && (native_input::is_clear_command(text) || native_input::is_submit_command(text)) { return Ok(None); }
        let Some(callback) = self.composer_delivery.get() else { return Ok(None); };
        {
            let inner = self.inner.lock().unwrap();
            if inner.native.as_deref().is_some_and(NativeInput::modifiers_down) {
                return Ok(Some(Delivery::ModifiersHeld));
            }
        }
        // Never hold the voice mutex while the UI resolves/edits its composer.
        let Some(ack) = callback(generation, text)? else { return Ok(None); };
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), ack).await;
        if !self.current(generation) { return Ok(Some(Delivery::Cancelled)); }
        match result {
            Ok(Ok(Ok(ComposerDelivery::Inserted))) => Ok(Some(Delivery::Pasted)),
            Ok(Ok(Ok(ComposerDelivery::NotApplicable))) => Ok(None),
            Ok(Ok(Err(error))) => Err(error),
            _ => Err("聊天框未确认文字写入，请先检查草稿；没有重复粘贴。".into()),
        }
    }
    async fn deliver_recognition(&self, generation: u64, owner: Option<&RecordingFeedback>, text: &str, complete: bool) -> bool {
        if let Some(edit) = owner.and_then(|target| target.pet_delivery.as_ref()) {
            {
                let mut inner = self.inner.lock().unwrap();
                if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return false; }
                if inner.native.as_deref().is_some_and(NativeInput::modifiers_down) {
                    Self::input_result(&mut inner.snapshot, Ok(Delivery::ModifiersHeld));
                    return false;
                }
            }
            if text.len() > 64_000 || text.contains('\0') {
                self.update(generation, "input-blocked", "识别文字过长或包含无效字符。", None);
                return false;
            }
            let (action, outcome) = if complete && native_input::is_clear_command(text) {
                ("clear", Delivery::Cleared)
            } else if complete && native_input::is_submit_command(text) {
                ("submit", Delivery::Submitted)
            } else {
                ("insert", Delivery::Pasted)
            };
            let accepted = match edit(action, if action == "insert" { text } else { "" }) {
                Ok(reply) => matches!(tokio::time::timeout(std::time::Duration::from_secs(1), reply).await, Ok(Ok(true))),
                Err(_) => false,
            };
            if !accepted {
                self.update(generation, "input-blocked", "桌宠输入框已关闭或已切换。", None);
                return false;
            }
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return false; }
            Self::input_result(&mut inner.snapshot, Ok(outcome));
            return outcome == Delivery::Pasted;
        }
        match self.deliver_composer_text(generation, text, complete).await {
            Ok(Some(delivery)) => {
                let pasted = delivery == Delivery::Pasted;
                let mut inner = self.inner.lock().unwrap();
                if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return false; }
                Self::input_result(&mut inner.snapshot, Ok(delivery));
                return pasted;
            }
            Err(error) => { self.update(generation, "input-blocked", &error, None); return false; }
            // Only an explicitly untouched, inapplicable target may use the
            // legacy current-focus native path. Unknown edits never get replayed.
            Ok(None) => {}
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) {
            return false;
        }
        let Some(native) = &inner.native else {
            return false;
        };
        let result = if complete { native.deliver(text) } else { native.deliver_literal(text) };
        let pasted = matches!(result, Ok(Delivery::Pasted));
        Self::input_result(&mut inner.snapshot, result);
        pasted
    }
    fn poll_clear(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.generation == generation
            && inner.cancel.as_ref().is_some_and(|c| !*c.borrow())
            && inner.buttons.poll_clear()
    }
    fn dispatch_home(&self, generation: u64) {
        let pressed = {
            let inner = self.inner.lock().unwrap();
            inner.generation == generation
                && inner.cancel.as_ref().is_some_and(|c| !*c.borrow())
                && inner.buttons.poll_home()
        };
        if pressed {
            if let Some(callback) = self.home_pressed.get() {
                callback(generation);
            }
        }
    }
    // The BLE loop cancels the utterance before invoking this mutation.
    fn clear(&self, generation: u64) {
        if !self.current(generation) || self.dialogue.exit("back") { return; }
        // The window queries may need the UI thread. Keep the voice mutex free.
        if let Some(route) = self.back_route.get() {
            match route(generation) {
                Ok(BackRoute::Pet) => {
                    self.update(generation, "ready", "", None);
                    return;
                }
                Err(error) => {
                    self.update(generation, "input-blocked", &error, None);
                    return;
                }
                Ok(BackRoute::MainComposer) => {
                    self.update(generation, "cleared", "", None);
                    return;
                }
                Ok(BackRoute::Native) => {}
            }
        }
        let native = {
            let inner = self.inner.lock().unwrap();
            if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return; }
            let Some(native) = inner.native.clone() else { return; };
            native
        };
        // A cold external editor can take a few seconds to expose its text field.
        // Keep settings and session cancellation available during that AX lookup.
        #[cfg(target_os = "macos")]
        let result = native.clear_back();
        #[cfg(not(target_os = "macos"))]
        let result = native.clear();
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.cancel.as_ref().is_none_or(|c| *c.borrow()) { return; }
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
        inner.session_config = None;
        inner.snapshot.running = false;
        if inner.resume_config.is_some() {
            inner.snapshot.state = if inner.automatic.asleep() { "sleeping" } else { "reconnecting" }.into();
            inner.snapshot.error.clear();
            self.auto_events.send_replace(());
            return;
        }
        if let Some(error) = error.filter(|_| !cancelled) {
            // The BLE loop has already handled retryable radio/transport failures.
            inner.automatic.block();
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
    #[tokio::test]
    async fn cancelled_generation_never_changes_status_or_delivers_late_text() {
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
        voice.deliver_recognition(1, None, "private transcript", true).await;
        voice.deliver_recognition(1, None, "发送提示词。", true).await;
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
        assert!(!inner.buttons.poll_clear());
        assert!(!inner.buttons.poll_home());
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
            voice.apply_auto_probe(revision, Ok(paired::Probe::Available("stale-device-must-never-launch".into())));
            voice.apply_auto_probe(revision, Err("stale permission error".into()));
            assert_eq!(voice.snapshot().state, state);
            assert_no_native_session(&voice);
            drop(voice);
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[test]
    fn missing_setup_keeps_rechecking_passively_and_stop_cancels_the_hint() {
        let profile = auto_profile("permission");
        let voice = Arc::new(RemoteVoice::new(&profile));
        let ticket = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
        assert!(voice.apply_auto_probe(ticket, Ok(paired::Probe::NeedsPermission("Bluetooth"))));
        assert_eq!(voice.snapshot().state, "needs-permission");
        assert_no_native_session(&voice);
        assert!(!voice.apply_auto_probe(ticket, Ok(paired::Probe::Waiting)));
        assert_eq!(voice.snapshot().state, "waiting-paired");
        voice.stop();
        assert!(!voice.apply_auto_probe(ticket, Ok(paired::Probe::NeedsPermission("Bluetooth"))));
        assert_eq!(voice.snapshot().state, "stopped");
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn no_paired_device_does_not_launch_and_probe_errors_block_repeated_automatic_attempts() {
        let profile = auto_profile("empty-or-denied");
        let voice = Arc::new(RemoteVoice::new(&profile));
        let revision = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
        voice.apply_auto_probe(revision, Ok(paired::Probe::Waiting));
        assert_eq!(voice.snapshot().state, "waiting-paired");
        assert_no_native_session(&voice);
        voice.apply_auto_probe(revision, Err("permission denied fixture".into()));
        assert_eq!(voice.snapshot().state, "auto-error");
        assert!(voice.inner.lock().unwrap().automatic.ticket(true, false).is_none());
        voice.apply_auto_probe(revision, Ok(paired::Probe::Waiting));
        assert_eq!(voice.snapshot().error, "permission denied fixture");
        assert_no_native_session(&voice);
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }

    fn active_voice_before_sleep(auto_start: bool) -> (RemoteVoice, watch::Receiver<bool>, PathBuf) {
        let profile = auto_profile("wake");
        let voice = RemoteVoice::new(&profile);
        let (cancel, stopped) = watch::channel(false);
        {
            let mut inner = voice.inner.lock().unwrap();
            inner.snapshot.config.auto_start = auto_start;
            inner.session_config = Some(inner.snapshot.config.clone());
            inner.snapshot.device = "connected-remote".into();
            inner.snapshot.running = true;
            inner.generation = 1;
            inner.cancel = Some(cancel);
        }
        (voice, stopped, profile)
    }

    #[test]
    fn wake_restarts_only_the_previous_remote_after_cleanup_even_with_auto_start_off() {
        for auto in [false, true] {
            for wake_before_cleanup in [false, true] {
                let (voice, stopped, profile) = active_voice_before_sleep(auto);
                voice.power_changed(true);
                assert!(*stopped.borrow());
                assert!(!voice.current(1));
                assert_eq!(voice.snapshot().state, "sleeping");
                if wake_before_cleanup { voice.power_changed(false); }
                assert!(RemoteVoice::take_resume(&mut voice.inner.lock().unwrap()).is_none());
                voice.finish(1, Some("old Bluetooth error".into()));
                if !wake_before_cleanup {
                    assert!(RemoteVoice::take_resume(&mut voice.inner.lock().unwrap()).is_none());
                    voice.power_changed(false);
                }
                voice.power_changed(false);
                let mut inner = voice.inner.lock().unwrap();
                let selected = RemoteVoice::take_resume(&mut inner).unwrap();
                assert_eq!(selected.device, "connected-remote");
                assert_eq!(selected.auto_start, auto);
                assert!(RemoteVoice::take_resume(&mut inner).is_none());
                drop(inner);
                drop(voice);
                std::fs::remove_dir_all(profile).unwrap();
            }
        }
    }

    #[test]
    fn stop_off_and_exit_win_even_if_wake_and_old_cleanup_are_pending() {
        for intent in 0..3 {
            let (voice, _, profile) = active_voice_before_sleep(true);
            voice.power_changed(true);
            match intent {
                0 => { voice.stop(); }
                1 => { voice.set_auto_start(false).unwrap(); }
                _ => voice.shutdown(),
            }
            voice.power_changed(false);
            voice.finish(1, None);
            let mut inner = voice.inner.lock().unwrap();
            assert!(RemoteVoice::take_resume(&mut inner).is_none());
            assert!(inner.automatic.ticket(inner.snapshot.config.auto_start, false).is_none());
            drop(inner);
            drop(voice);
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[test]
    fn wake_invalidates_stale_inventory_and_transient_probe_errors_stay_retryable() {
        let profile = auto_profile("wake-probe");
        let voice = Arc::new(RemoteVoice::new(&profile));
        let old = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
        voice.power_changed(true);
        assert!(voice.inner.lock().unwrap().automatic.ticket(true, false).is_none());
        voice.power_changed(false);
        voice.apply_auto_probe(old, Err("stale failure".into()));
        let fresh = voice.inner.lock().unwrap().automatic.ticket(true, false).unwrap();
        voice.apply_auto_probe(fresh, Ok(paired::Probe::Retry("radio starting".into())));
        assert_eq!(voice.snapshot().state, "waiting-paired");
        assert!(voice.inner.lock().unwrap().automatic.accepts(fresh, true, false));
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[tokio::test]
    async fn main_composer_acknowledges_literal_text_without_native_paste_or_holding_voice_lock() {
        let (voice, _stop, profile) = active_voice_before_sleep(true);
        let voice = Arc::new(voice);
        let weak = Arc::downgrade(&voice);
        let edits = Arc::new(Mutex::new(Vec::new()));
        let recorded = edits.clone();
        voice.set_composer_delivery(move |generation, text| {
            let current = weak.upgrade().unwrap();
            assert!(current.inner.try_lock().is_ok(), "UI delivery must not inherit the voice lock");
            assert_eq!(generation, 1);
            recorded.lock().unwrap().push(text.to_owned());
            let (send, ack) = tokio::sync::oneshot::channel();
            send.send(Ok(ComposerDelivery::Inserted)).unwrap();
            Ok(Some(ack))
        });
        for (text, complete) in [("你好\n第二行 <img onerror=alert(1)>", true), ("发送提示词", false), ("清除提示词", false)] {
            assert!(voice.deliver_recognition(1, None, text, complete).await);
            assert_eq!(voice.snapshot().state, "pasted");
            assert_eq!(edits.lock().unwrap().last().unwrap(), text);
        }
        for text in ["发送提示词。", "清除提示词"] {
            assert_eq!(voice.deliver_composer_text(1, text, true).await.unwrap(), None);
        }
        assert_eq!(edits.lock().unwrap().len(), 3, "exact complete commands must not become literal edits");
        voice.stop();
        assert!(!voice.deliver_recognition(1, None, "late", true).await);
        assert_eq!(edits.lock().unwrap().len(), 3);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[tokio::test]
    async fn only_an_explicitly_untouched_composer_can_decline_to_native_delivery() {
        for synchronous in [true, false] {
            let (voice, _stop, profile) = active_voice_before_sleep(true);
            voice.set_composer_delivery(move |_, _| {
                if synchronous { return Ok(None); }
                let (send, ack) = tokio::sync::oneshot::channel();
                send.send(Ok(ComposerDelivery::NotApplicable)).unwrap();
                Ok(Some(ack))
            });
            assert_eq!(voice.deliver_composer_text(1, "literal", true).await.unwrap(), None);
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[tokio::test]
    async fn rejected_dropped_and_timed_out_composer_edits_never_fall_back_or_report_pasted() {
        for mode in 0..4 {
            let (voice, _stop, profile) = active_voice_before_sleep(true);
            let held = Arc::new(Mutex::new(None));
            let pending = held.clone();
            voice.set_composer_delivery(move |_, _| {
                if mode == 0 { return Err("主聊天已切换".into()); }
                let (send, ack) = tokio::sync::oneshot::channel();
                match mode {
                    1 => { send.send(Err("编辑已取消".into())).unwrap(); }
                    2 => drop(send),
                    _ => { *pending.lock().unwrap() = Some(send); }
                }
                Ok(Some(ack))
            });
            assert!(!voice.deliver_recognition(1, None, "never replay this", true).await);
            let snapshot = voice.snapshot();
            assert_eq!(snapshot.state, "input-blocked");
            assert!(!snapshot.error.is_empty());
            assert!(!serde_json::to_string(&snapshot).unwrap().contains("never replay this"));
            std::fs::remove_dir_all(profile).unwrap();
        }
    }

    #[tokio::test]
    async fn cancelling_a_composer_request_preserves_stop_and_never_falls_back() {
        let (voice, _stop, profile) = active_voice_before_sleep(true);
        let pending = Arc::new(Mutex::new(None));
        let slot = pending.clone();
        voice.set_composer_delivery(move |_, _| {
            let (send, ack) = tokio::sync::oneshot::channel();
            *slot.lock().unwrap() = Some(send);
            Ok(Some(ack))
        });
        let edit = voice.deliver_composer_text(1, "cancelled", true);
        let cancel = async {
            tokio::task::yield_now().await;
            voice.stop();
            pending.lock().unwrap().take().unwrap().send(Ok(ComposerDelivery::Inserted)).unwrap();
        };
        let (result, ()) = tokio::join!(edit, cancel);
        assert_eq!(result.unwrap(), Some(Delivery::Cancelled));
        assert_eq!(voice.snapshot().state, "stopping");
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[tokio::test]
    async fn pet_final_edits_use_the_press_owner_including_partial_commands_and_rejected_edits() {
        let (voice, _stop, profile) = active_voice_before_sleep(true);
        let edits = Arc::new(Mutex::new(Vec::new()));
        let recorded = edits.clone();
        let owner = RecordingFeedback {
            focus: None,
            notify: Box::new(|_| {}),
            pet_delivery: Some(Box::new(move |action, text| {
                recorded.lock().unwrap().push((action.to_owned(), text.to_owned()));
                let (reply, ack) = tokio::sync::oneshot::channel();
                reply.send(text != "hidden").unwrap();
                Ok(ack)
            })),
        };
        for (text, complete, action, state) in [
            ("draft", true, "insert", "pasted"),
            ("发送提示词。", true, "submit", "submitted"),
            ("清除提示词", true, "clear", "cleared"),
            ("发送提示词", false, "insert", "pasted"),
            ("hidden", true, "insert", "input-blocked"),
        ] {
            voice.deliver_recognition(1, Some(&owner), text, complete).await;
            assert_eq!(voice.snapshot().state, state);
            assert_eq!(edits.lock().unwrap().last().unwrap(), &(action.into(), if action == "insert" { text } else { "" }.into()));
        }
        voice.stop();
        voice.deliver_recognition(1, Some(&owner), "late", true).await;
        assert_eq!(edits.lock().unwrap().len(), 5);
        std::fs::remove_dir_all(profile).unwrap();
    }

    #[tokio::test]
    async fn disabling_automatic_start_cancels_an_existing_session_and_prevents_late_voice_actions() {
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
        voice.deliver_recognition(1, None, "late transcript", true).await;
        voice.deliver_recognition(1, None, "发送提示词", true).await;
        assert_eq!(voice.snapshot().state, "stopping");
        voice.finish(1, Some("late backend error".into()));
        assert!(!voice.snapshot().running);
        assert_eq!(voice.snapshot().state, "stopped");
        drop(voice);
        std::fs::remove_dir_all(profile).unwrap();
    }
}
