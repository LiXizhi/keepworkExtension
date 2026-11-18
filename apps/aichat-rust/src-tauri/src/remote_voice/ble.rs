//! Native BLE transport. Retrieving already connected peripherals is required:
//! paired HID remotes often stop advertising while the OS owns their keyboard.
use super::gestures::{Edge, Press, RecordGesture, Release};
use super::atvv::{Action, Caps, Ptt, CHUNK_SAMPLES, AUDIO, CONTROL, GET_CAPS, SERVICE, TX};
use super::{asr, cancelled, RecordingFeedback, RecordingFocus, RecordingPhase, RecordingTarget, RemoteVoice, VoiceConfig, VoiceDevice};
use btleplug::api::{
    Central, CentralEvent, CentralState, Characteristic, Manager as _, Peripheral as _,
    RetrievePeripheralsOptions, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures_util::{future::pending, StreamExt};
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

#[path = "ble_startup.rs"]
mod startup;
use startup::{NotificationInbox, TimedNotification};
#[path = "ble_gatt.rs"]
mod gatt;

pub(super) const BLUETOOTH_OFF: &str = "没有已开启的 BLE 蓝牙适配器，请开启系统蓝牙后重试。";
pub(super) const NO_ADAPTER: &str = "没有可用的 BLE 蓝牙适配器，请开启蓝牙后重试。";

#[derive(Clone, Debug)]
struct Failure {
    message: String,
    retry: bool,
    devices: Option<Vec<VoiceDevice>>,
    incomplete_atvv: bool,
}
impl Failure {
    fn temporary(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: true,
            devices: None,
            incomplete_atvv: false,
        }
    }
    fn permanent(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: false,
            devices: None,
            incomplete_atvv: false,
        }
    }
}
fn bluetooth_error(error: btleplug::Error) -> Failure {
    match error {
        btleplug::Error::PermissionDenied => {
            Failure::permanent("系统拒绝了蓝牙访问，请在系统设置允许 Keepwork 使用蓝牙后重试。")
        }
        btleplug::Error::NoAdapterAvailable => Failure::temporary(NO_ADAPTER),
        other => {
            let message = other.to_string().to_lowercase();
            if [
                "denied",
                "unauthorized",
                "not authorized",
                "0x80070005",
                "0x80070522",
            ]
            .iter()
            .any(|s| message.contains(s))
            {
                Failure::permanent("蓝牙访问被系统拒绝，请检查 Keepwork 蓝牙权限后重试。")
            } else {
                Failure::temporary("遥控器连接中断或蓝牙操作失败，请检查配对并按键唤醒遥控器。")
            }
        }
    }
}
async fn operation<T>(
    cancel: &watch::Receiver<bool>,
    future: impl Future<Output = btleplug::Result<T>>,
    seconds: u64,
) -> Result<T, Failure> {
    let mut stop = cancel.clone();
    tokio::select! {
        biased;
        _=cancelled(&mut stop)=> Err(Failure::permanent("已停止。")),
        result=timeout(Duration::from_secs(seconds),future)=> match result {
            Ok(result)=>result.map_err(bluetooth_error),
            Err(_)=>Err(Failure::temporary("蓝牙操作超时，请检查设备配对、权限和连接状态。")),
        }
    }
}
fn requested_id(device: &str) -> Result<PeripheralId, Failure> {
    #[cfg(target_os = "macos")]
    {
        Uuid::parse_str(device)
            .map(Into::into)
            .map_err(|_| Failure::permanent("macOS 蓝牙设备 ID 必须是系统 CoreBluetooth UUID。"))
    }
    #[cfg(target_os = "windows")]
    {
        device
            .parse::<btleplug::api::BDAddr>()
            .map(Into::into)
            .map_err(|_| {
                Failure::permanent("Windows 蓝牙设备 ID 必须是 XX:XX:XX:XX:XX:XX 格式的地址。")
            })
    }
}
fn remote_name(name: &str) -> bool {
    super::paired::known_remote_name(name)
}
fn unique(mut peripherals: Vec<Peripheral>) -> Vec<Peripheral> {
    let mut seen = std::collections::HashSet::new();
    peripherals.retain(|p| seen.insert(p.id()));
    peripherals
}
async fn describe(peripherals: Vec<Peripheral>, cancel: &watch::Receiver<bool>) -> Result<Vec<VoiceDevice>, Failure> {
    let mut devices = Vec::new();
    for peripheral in unique(peripherals).into_iter().take(256) {
        let name = operation(cancel, peripheral.properties(), 3).await?
            .and_then(|properties| properties.local_name)
            .unwrap_or_else(|| "小米遥控器".into());
        devices.push(VoiceDevice {
            id: peripheral.id().to_string(),
            name: name.chars().take(120).collect(),
            connected: operation(cancel, peripheral.is_connected(), 3).await?,
        });
    }
    devices.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(devices)
}
async fn choose(peripherals: Vec<Peripheral>, cancel: &watch::Receiver<bool>) -> Result<Option<Peripheral>, Failure> {
    let mut peripherals = unique(peripherals);
    if peripherals.len() > 1 {
        return Err(Failure {
            message: "发现多个遥控器，请选择要使用的设备。".into(),
            retry: false,
            devices: Some(describe(peripherals, cancel).await?),
            incomplete_atvv: false,
        });
    }
    Ok(peripherals.pop())
}

async fn known_peripherals(adapter: &Adapter, cancel: &watch::Receiver<bool>) -> Result<Vec<Peripheral>, Failure> {
    let mut remotes = operation(cancel, adapter.retrieve_peripherals(RetrievePeripheralsOptions {
        identifiers: None, services: Some(vec![SERVICE]),
    }), 10).await?;
    let keyboards = operation(cancel, adapter.retrieve_peripherals(RetrievePeripheralsOptions {
        identifiers: None, services: Some(vec![Uuid::from_u128(0x0000181200001000800000805f9b34fb)]),
    }), 10).await?;
    for peripheral in keyboards {
        if let Some(properties) = operation(cancel, peripheral.properties(), 5).await? {
            if properties.local_name.as_deref().is_some_and(remote_name) { remotes.push(peripheral); }
        }
    }
    Ok(unique(remotes))
}

async fn scan(adapter: &Adapter, requested: Option<&PeripheralId>, cancel: &watch::Receiver<bool>) -> Result<Vec<Peripheral>, Failure> {
    let scanning = async {
        operation(cancel, adapter.start_scan(ScanFilter::default()), 10).await?;
        let mut stop = cancel.clone();
        tokio::select! { biased; _=cancelled(&mut stop)=>return Err(Failure::permanent("已停止。")), _=sleep(Duration::from_secs(8))=>{} }
        let mut candidates = vec![];
        for peripheral in operation(cancel, adapter.peripherals(), 5).await? {
            if let Some(id) = requested {
                if &peripheral.id() == id { candidates.push(peripheral); }
            } else if let Some(properties) = operation(cancel, peripheral.properties(), 5).await? {
                if properties.services.contains(&SERVICE) || properties.local_name.as_deref().is_some_and(remote_name) { candidates.push(peripheral); }
            }
        }
        Ok(candidates)
    }.await;
    let _ = timeout(Duration::from_secs(2), adapter.stop_scan()).await;
    scanning
}

#[cfg(target_os = "macos")]
pub(super) async fn known_devices() -> Result<Vec<VoiceDevice>, String> {
    let (_sender, cancel) = watch::channel(false);
    let result = async {
        let adapter = powered_adapter(&cancel).await?;
        describe(known_peripherals(&adapter, &cancel).await?, &cancel).await
    }.await;
    result.map_err(|error: Failure| error.message)
}

pub(super) async fn scan_devices(cancel: &watch::Receiver<bool>) -> Result<Vec<VoiceDevice>, String> {
    let result = async {
        let adapter = powered_adapter(cancel).await?;
        let mut peripherals = known_peripherals(&adapter, cancel).await?;
        peripherals.extend(scan(&adapter, None, cancel).await?);
        describe(peripherals, cancel).await
    }.await;
    result.map_err(|error: Failure| error.message)
}
async fn discover(
    adapter: &Adapter,
    requested: Option<&PeripheralId>,
    cancel: &watch::Receiver<bool>,
) -> Result<Peripheral, Failure> {
    if let Some(id) = requested {
        #[cfg(target_os = "windows")]
        {
            return operation(cancel, adapter.add_peripheral(id), 10).await;
        }
        #[cfg(target_os = "macos")]
        {
            let known = operation(
                cancel,
                adapter.retrieve_peripherals(RetrievePeripheralsOptions {
                    identifiers: Some(vec![id.clone()]),
                    services: None,
                }),
                10,
            )
            .await?;
            let known = known.into_iter().filter(|p| &p.id() == id).collect();
            if let Some(peripheral) = choose(known, cancel).await? {
                return Ok(peripheral);
            }
        }
    } else {
        if let Some(peripheral) = choose(known_peripherals(adapter, cancel).await?, cancel).await? {
            return Ok(peripheral);
        }
    }
    choose(scan(adapter, requested, cancel).await?, cancel).await?
        .ok_or_else(||Failure::temporary("未找到小米遥控器，请先在系统蓝牙设置配对并按键唤醒；也可填写设备 ID。"))
}

#[cfg(target_os = "macos")]
async fn adapters() -> Result<Vec<Adapter>, Failure> {
    use futures_util::future::{BoxFuture, Shared};
    use futures_util::FutureExt;
    type Pending = Shared<BoxFuture<'static, Result<Vec<Adapter>, Failure>>>;
    static ADAPTERS: tokio::sync::Mutex<Option<Pending>> = tokio::sync::Mutex::const_new(None);

    // btleplug allocates a long-lived CoreBluetooth thread on each enumeration. Keep
    // the single macOS central across PTT stop/wake. If enumeration is interrupted,
    // resume the same retained future instead of constructing another manager thread.
    let mut slot = ADAPTERS.lock().await;
    let pending = slot.get_or_insert_with(|| {
        async {
            let manager = Manager::new().await.map_err(bluetooth_error)?;
            manager.adapters().await.map_err(bluetooth_error)
        }
        .boxed()
        .shared()
    });
    let result = pending.clone().await;
    if result.is_err() {
        *slot = None;
    }
    result
}

/// Creating the shared central triggers the OS dialog only after the caller
/// has admitted a remote, an undecided grant, and a foreground startup intent.
#[cfg(target_os = "macos")]
pub(super) async fn prepare_bluetooth() {
    let _ = timeout(Duration::from_secs(8), adapters()).await;
}

#[cfg(target_os = "macos")]
fn saved_remote_matches(requested: &PeripheralId, actual: &PeripheralId, name: Option<&str>, services: &[Uuid]) -> bool {
    requested == actual && (services.contains(&SERVICE) || name.is_some_and(super::paired::known_remote_name))
}

/// Read-only recovery of an explicit target, including a sleeping peripheral.
/// Retrieval proves the system knows this UUID, not that it is currently paired.
#[cfg(target_os = "macos")]
pub(super) async fn saved_remote(device: &str) -> Result<super::paired::Probe, String> {
    use super::paired::Probe;
    let result: Result<Probe, Failure> = async {
        let requested = requested_id(device)?;
        let (_sender, cancel) = watch::channel(false);
        let adapter = powered_adapter(&cancel).await?;
        let known = operation(&cancel, adapter.retrieve_peripherals(RetrievePeripheralsOptions {
            identifiers: Some(vec![requested.clone()]), services: None,
        }), 5).await?;
        for peripheral in known {
            if peripheral.id() != requested { continue; }
            if let Some(properties) = operation(&cancel, peripheral.properties(), 2).await? {
                if saved_remote_matches(&requested, &peripheral.id(), properties.local_name.as_deref(), &properties.services) {
                    return Ok(Probe::Available(peripheral.id().to_string()));
                }
            }
        }
        Ok(Probe::Retry("系统尚未找到保存的指定遥控器，请检查设备 ID 并按键唤醒；不会改连其他设备。".into()))
    }.await;
    match result {
        Ok(probe) => Ok(probe),
        Err(error) if error.retry => Ok(Probe::Retry(error.message)),
        Err(error) => Err(error.message),
    }
}

#[cfg(windows)]
async fn adapters() -> Result<Vec<Adapter>, Failure> {
    let manager = Manager::new().await.map_err(bluetooth_error)?;
    manager.adapters().await.map_err(bluetooth_error)
}

fn radio_unavailable(absent: bool, denied: bool) -> Failure {
    if denied {
        Failure::permanent("蓝牙访问未获允许。请到系统设置 → 隐私与安全性 → 蓝牙中允许系统显示的应用，再点启动语音输入。")
    } else {
        Failure::temporary(if absent { NO_ADAPTER } else { BLUETOOTH_OFF })
    }
}

async fn powered_adapter(cancel: &watch::Receiver<bool>) -> Result<Adapter, Failure> {
    let mut stop = cancel.clone();
    let available = tokio::select! {
        biased;
        _ = cancelled(&mut stop) => return Err(Failure::permanent("已停止。")),
        result = timeout(Duration::from_secs(15), adapters()) =>
            result.map_err(|_| Failure::temporary("读取蓝牙适配器超时，将重新连接。"))??,
    };
    let absent = available.is_empty();
    let mut last_error = None;
    for adapter in available {
        match operation(cancel, adapter.adapter_state(), 5).await {
            Ok(CentralState::PoweredOn) => return Ok(adapter),
            Ok(_) => {}
            Err(error) if !error.retry => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    #[cfg(target_os = "macos")]
    let denied = {
        extern "C" {
            fn keepwork_voice_bluetooth_denied() -> bool;
        }
        unsafe { keepwork_voice_bluetooth_denied() }
    };
    #[cfg(not(target_os = "macos"))]
    let denied = false;
    if denied {
        return Err(radio_unavailable(absent, true));
    }
    Err(last_error.unwrap_or_else(|| radio_unavailable(absent, false)))
}

async fn with_idle_buttons<T>(
    service: &RemoteVoice,
    generation: u64,
    work: impl Future<Output = T>,
) -> T {
    tokio::pin!(work);
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            output = &mut work => return output,
            _ = tick.tick() => service.dispatch_idle_buttons(generation),
        }
    }
}

pub(super) async fn run(
    service: &RemoteVoice,
    generation: u64,
    config: VoiceConfig,
    cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let requested = if config.device.is_empty() {
        None
    } else {
        Some(requested_id(&config.device).map_err(|error| error.message)?)
    };
    let mut delay = 2;
    // Partial discovery can be a transient OS cache failure. Retry once, keeping
    // the exact identity even if another remote becomes available meanwhile.
    let mut retry_target = None;
    while service.current(generation) {
        service.update(generation, "scanning", "", None);
        let attempt = async {
            let adapter = with_idle_buttons(service, generation, powered_adapter(&cancel)).await?;
            let peripheral =
                with_idle_buttons(service, generation, discover(&adapter, requested.as_ref().or(retry_target.as_ref()), &cancel))
                    .await?;
            service.update(
                generation,
                "connecting",
                "",
                Some(peripheral.id().to_string()),
            );
            #[cfg(target_os = "windows")]
            ensure_windows_paired(service, generation, &peripheral, &cancel).await?;
            let mut result = connection(service, generation, &adapter, &peripheral, &cancel).await;
            if let Err(error) = &mut result {
                recover_missing_atvv(error, peripheral.id(), &mut retry_target);
            }
            service.dialogue.exit("disconnected");
            service.disarm(generation);
            // No audio request survives this attempt. Release this client's
            // GATT subscriptions, never OS pairing or another app's connection.
            for ch in peripheral
                .characteristics()
                .iter()
                .filter(|c| c.service_uuid == SERVICE && [AUDIO, CONTROL].contains(&c.uuid))
            {
                let _ = timeout(Duration::from_secs(1), peripheral.unsubscribe(ch)).await;
            }
            let _ = timeout(Duration::from_secs(2), peripheral.disconnect()).await;
            result
        }
        .await;
        service.disarm(generation);
        if !service.current(generation) || *cancel.borrow() {
            break;
        }
        match attempt {
            Ok(()) => break,
            Err(error) if error.devices.is_some() => {
                service.offer_devices(generation, error.devices.unwrap());
                return Ok(());
            }
            Err(error) if !error.retry => return Err(error.message),
            Err(error) => service.update(generation, "reconnecting", &error.message, None),
        }
        let mut stop = cancel.clone();
        tokio::select! {
            biased;
            _ = cancelled(&mut stop) => break,
            _ = with_idle_buttons(service, generation, sleep(Duration::from_secs(delay))) => {}
        }
        delay = (delay * 2).min(30);
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum RecognitionError {
    Cloud(String),
    Focus(String),
    Partial(String, String),
}
type Preview = Box<dyn FnMut(&str) + Send>;
type SpeechRequest = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
type RecognitionWork = Pin<Box<dyn Future<Output = Result<String, RecognitionError>> + Send>>;
type PcmStream = tokio::sync::mpsc::Receiver<Vec<i16>>;
const MAX_PENDING_CHUNKS: usize = 16_000 * 60 / CHUNK_SAMPLES;

struct Recognition {
    work: RecognitionWork,
    audio: Option<tokio::sync::mpsc::Sender<Vec<i16>>>,
    feedback: Option<std::sync::Arc<RecordingFeedback>>,
    stream_started: bool,
    received_audio: bool,
    released: bool,
    interrupted: Option<String>,
    result: Option<Result<String, RecognitionError>>,
}

impl Recognition {
    fn start(target: RecordingTarget, cancel: watch::Receiver<bool>, speech: std::sync::Arc<asr::SpeechConnection>) -> Self {
        Self::with_transcriber(target, move |pcm, preview| {
            Box::pin(async move { speech.transcribe(pcm, cancel, preview).await })
        })
    }
    fn with_transcriber(
        target: RecordingTarget,
        transcribe: impl FnOnce(PcmStream, Preview) -> SpeechRequest + Send + 'static,
    ) -> Self {
        let (focus, feedback) = match target {
            Ok(Some(mut feedback)) => (Ok(feedback.focus.take()), Some(std::sync::Arc::new(feedback))),
            Ok(None) => (Ok(None), None),
            Err(message) => (Err(message), None),
        };
        let (audio, stream) = tokio::sync::mpsc::channel(MAX_PENDING_CHUNKS);
        let preview = feedback.clone();
        let work = async move {
            let preview: Preview = Box::new(move |text| {
                if let Some(owner) = &preview {
                    (owner.notify)(RecordingPhase::Preview(text.to_owned()));
                }
            });
            recognize_for_focus(focus, stream, move |pcm| transcribe(pcm, preview)).await
        };
        Self { work: Box::pin(work), audio: Some(audio), feedback, stream_started: false, received_audio: false,
            released: false, interrupted: None, result: None }
    }
    // Report recording only after actual decoded PCM arrives. A stream-start
    // notification by itself is possible even when a waking mic sends no audio.
    fn enqueue(&mut self, pcm: Vec<i16>) -> bool {
        if pcm.is_empty() || self.result.is_some() { return false; }
        let first = !self.received_audio;
        if first {
            self.received_audio = true;
            if let Some(owner) = &self.feedback { (owner.notify)(RecordingPhase::Recording); }
        }
        if let Some(audio) = &self.audio {
            if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) = audio.try_send(pcm) {
                self.interrupted = Some("语音处理积压超过限制。".into());
                self.audio.take();
            }
        }
        first
    }
    fn release(&mut self) {
        if let Some(owner) = &self.feedback { (owner.notify)(RecordingPhase::Transcribing); }
        self.released = true;
        self.audio.take();
    }
    fn finish(&mut self) -> Result<String, RecognitionError> {
        let text = self.result.take().expect("only released completed work is delivered")?;
        match self.interrupted.take() {
            Some(reason) => Err(RecognitionError::Partial(text, reason)),
            None => Ok(text),
        }
    }
}
async fn recognize_for_focus(
    focus: RecordingFocus,
    mut audio: PcmStream,
    transcribe: impl FnOnce(PcmStream) -> SpeechRequest,
) -> Result<String, RecognitionError> {
    let Some(ready) = focus.map_err(RecognitionError::Focus)? else {
        return transcribe(audio).await.map_err(RecognitionError::Cloud);
    };
    // Start the handshake on key-down in parallel with pet focus. Keep all PCM local
    // until the owner confirms focus. Both futures are owned by this physical press.
    let (gate, gated_audio) = tokio::sync::mpsc::channel(1);
    let forward = async move {
        if !matches!(timeout(Duration::from_secs(3), ready).await, Ok(Ok(true))) {
            return Err(RecognitionError::Focus("桌宠输入框未获得焦点。请点开桌宠输入框，再重新按住语音键。".into()));
        }
        while let Some(chunk) = audio.recv().await {
            if gate.send(chunk).await.is_err() { break; }
        }
        Ok(())
    };
    let recognize = async move { transcribe(gated_audio).await.map_err(RecognitionError::Cloud) };
    let ((), text) = tokio::try_join!(forward, recognize)?;
    Ok(text)
}

async fn confirm_composer(focus: RecordingFocus) -> Result<(), RecognitionError> {
    if let Some(ack) = focus.map_err(RecognitionError::Focus)? {
        if !matches!(timeout(Duration::from_secs(1), ack).await, Ok(Ok(true))) {
            return Err(RecognitionError::Focus("AIChat 当前没有可用的输入框，请打开聊天输入框后重试。".into()));
        }
    }
    Ok(())
}
fn cancel_utterance(ptt: &mut Ptt, recognition: &mut Option<Recognition>) {
    // Drop the owned socket lease and upload future before clearing the current input.
    *recognition = None;
    ptt.cancel_current();
}
fn handle_record_control(
    data: &[u8], now: Instant, dialogue: &std::sync::Arc<super::dialogue::Dialogue>,
    gesture: &mut RecordGesture, ptt: &mut Ptt, recognition: &mut Option<Recognition>,
) -> Result<Vec<Action>, String> {
    // Firmware can report a press twice (request + stream start),
    // or release before the first audio frame arrives.
    match gesture.control(data, now, dialogue.active()) {
        Edge::Down(press) => match press {
            Press::DialogueRecord => {
                *recognition = None;
                dialogue.record("record");
                return Ok(ptt.discard_press(data));
            }
            Press::Second => {
                cancel_utterance(ptt, recognition);
                // Still capture this hold in case it is not a tap.
            }
            Press::Dictate => dialogue.interrupt(),
            Press::Duplicate => {}
        },
        Edge::Up(Release::Enter) => {
            cancel_utterance(ptt, recognition);
            dialogue.enter();
        }
        _ => {}
    }
    ptt.control(data)
}

async fn write(
    peripheral: &Peripheral,
    tx: &Characteristic,
    data: &[u8],
    cancel: &watch::Receiver<bool>,
) -> Result<(), Failure> {
    operation(
        cancel,
        peripheral.write(tx, data, WriteType::WithResponse),
        5,
    )
    .await
}
fn missing_atvv(empty: bool, previously_validated: bool) -> Failure {
    if empty || previously_validated {
        Failure::temporary("系统尚未恢复遥控器的语音服务，将重新连接。")
    } else {
        let mut failure = Failure::permanent("未发现本客户端支持的完整语音服务。请断开电视或其他遥控软件、唤醒遥控器后重试；仍失败时，请提供电池仓型号和下方蓝牙服务诊断。");
        failure.incomplete_atvv = true;
        failure
    }
}
fn recover_missing_atvv(error: &mut Failure, device: PeripheralId, retry_target: &mut Option<PeripheralId>) {
    if error.incomplete_atvv && retry_target.is_none() {
        *retry_target = Some(device);
        error.retry = true;
        error.message = "遥控器语音服务尚未完整发现，正在对同一设备重新连接一次。".into();
    }
}

#[cfg(target_os = "windows")]
async fn ensure_windows_paired(
    service: &RemoteVoice,
    generation: u64,
    peripheral: &Peripheral,
    cancel: &watch::Receiver<bool>,
) -> Result<(), Failure> {
    use super::paired::{ensure_paired, PairOutcome};
    let bytes = peripheral.address().into_inner();
    let address = u64::from_be_bytes([0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]);
    let mut stop = cancel.clone();
    let outcome = with_idle_buttons(service, generation, async {
        tokio::select! {
            biased;
            _ = cancelled(&mut stop) => Err(Failure::permanent("已停止。")),
            result = timeout(Duration::from_secs(15), ensure_paired(address)) => match result {
                Ok(Ok(outcome)) => Ok(outcome),
                Ok(Err(message)) => Err(Failure::temporary(&message)),
                Err(_) => Err(Failure::temporary("蓝牙配对超时，请同时长按遥控器「主页 + 菜单」至快闪后重试。")),
            }
        }
    })
    .await?;
    match outcome {
        PairOutcome::AlreadyPaired => Ok(()),
        PairOutcome::NewlyPaired => {
            with_idle_buttons(service, generation, sleep(Duration::from_millis(400))).await;
            Ok(())
        }
        PairOutcome::NeedsPairingMode => Err(Failure::temporary(
            "遥控器尚未完成配对：请同时长按遥控器「主页 + 菜单」直到指示灯快闪，正在自动配对…",
        )),
    }
}

async fn connection(
    service: &RemoteVoice,
    generation: u64,
    adapter: &Adapter,
    peripheral: &Peripheral,
    cancel: &watch::Receiver<bool>,
) -> Result<(), Failure> {
    let mut events = with_idle_buttons(service, generation, operation(cancel, adapter.events(), 5)).await?;
    if !with_idle_buttons(service, generation, operation(cancel, peripheral.is_connected(), 5)).await? {
        with_idle_buttons(service, generation, operation(cancel, peripheral.connect(), 15)).await?;
    }
    with_idle_buttons(service, generation, operation(cancel, peripheral.discover_services(), 15)).await?;
    // A newly resumed radio can publish its characteristics in stages. Remember only
    // the last successfully negotiated device across reconnects and service restarts.
    static LAST_VALIDATED: std::sync::Mutex<Option<PeripheralId>> = std::sync::Mutex::new(None);
    let device_id = peripheral.id();
    let chars = peripheral.characteristics();
    service.set_diagnostic(generation, gatt::report(&device_id.to_string(), &peripheral.services(), &chars));
    let gatt::Channels { tx, control, audio } = gatt::channels(&chars).ok_or_else(|| {
            let known = LAST_VALIDATED.lock().unwrap().as_ref() == Some(&device_id);
            missing_atvv(chars.is_empty(), known)
        })?;
    let stream = operation(cancel, peripheral.notifications(), 5).await?;
    let mut notifications = NotificationInbox::new(stream);
    let setup = async {
        // Register both channels without waiting for the first subscription's
        // acknowledgement. The reader is already listening to both.
        tokio::try_join!(
            operation(cancel, peripheral.subscribe(&control), 5),
            operation(cancel, peripheral.subscribe(&audio), 5),
        )?;
        write(peripheral, &tx, GET_CAPS, cancel).await
    };
    let mut startup_target = None;
    let mut stop = cancel.clone();
    let negotiation = tokio::select! {
        biased;
        _ = cancelled(&mut stop) => return Ok(()),
        result = with_idle_buttons(service, generation, startup::negotiate(&mut notifications, setup, || {
            service.update(generation, "preparing-microphone", "", None);
            if !service.dialogue.active() {
                startup_target = Some(service.prepare_recording_focus(generation));
            }
        })) => result,
    };
    let (caps, mut backlog) = match negotiation {
        Ok(ready) => ready,
        Err(error) => {
            if let Some(Ok(Some(owner))) = &startup_target { (owner.notify)(RecordingPhase::NoAudio); }
            return Err(error);
        }
    };
    *LAST_VALIDATED.lock().unwrap() = Some(device_id);
    if let Err(message) = service.arm(generation) {
        if let Some(Ok(Some(owner))) = &startup_target { (owner.notify)(RecordingPhase::NoAudio); }
        return Err(Failure::permanent(&message));
    }
    if startup_target.is_none() { service.update(generation, "ready", "", None); }
    let mut ptt = Ptt::new(caps);
    let mut gesture = RecordGesture::default();
    let mut recognition: Option<Recognition> = None;
    let speech = std::sync::Arc::new(asr::SpeechConnection::default());
    let mut heartbeat = tokio::time::interval(Duration::from_millis(50));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut health_ticks = 0;
    let mut cleared_at = None;
    loop {
        service.dispatch_home(generation);
        if super::dialogue::take_ok() { service.dialogue.record("ok"); }
        if service.poll_clear(generation) {
            cleared_at = Some(Instant::now());
            startup_target.take();
            gesture = RecordGesture::default();
            cancel_utterance(&mut ptt, &mut recognition);
            service.clear(generation);
        }
        let mut stop = cancel.clone();
        tokio::select! {
            biased;
            _=cancelled(&mut stop)=>return Ok(()),
            event=events.next()=>match event {
                Some(CentralEvent::DeviceDisconnected(id)) if id==peripheral.id()=>return Err(Failure::temporary("遥控器蓝牙已断开，将重新连接；上一段录音不会重发。")),
                Some(CentralEvent::StateUpdate(CentralState::PoweredOff))=>return Err(Failure::temporary("蓝牙已关闭，请开启后重新连接。")),
                None=>return Err(Failure::temporary("蓝牙状态连接已结束。")),
                _=>{},
            },
            result=async {
                if let Some(job) = recognition.as_mut().filter(|job| job.result.is_none()) { job.work.as_mut().await }
                else { pending().await }
            }=>{
                if let Some(job) = &mut recognition {
                    if result.is_err() {
                        if let Some(owner) = &job.feedback { (owner.notify)(RecordingPhase::Preview(String::new())); }
                    }
                    job.result = Some(result);
                }
            },
            _=heartbeat.tick()=>{
                if service.poll_clear(generation) {
                    cleared_at = Some(Instant::now());
                    startup_target.take();
                    gesture = RecordGesture::default();
                    cancel_utterance(&mut ptt,&mut recognition);
                    service.clear(generation);
                }
                if ptt.open_timed_out() || ptt.expired() {
                    if let Some(tail) = ptt.interrupt_capture() {
                        let Some(job) = &mut recognition else { return Err(Failure::temporary("录音状态失效，请重新按键。")); };
                        job.enqueue(tail);
                        let message = "单次输入已达到 10 分钟上限，请松开语音键。";
                        job.interrupted = Some(message.into());
                        job.audio.take();
                        service.update(generation, "recording-limit", message, None);
                    } else {
                        if let Some(owner) = recognition.as_ref().and_then(|job| job.feedback.as_ref()) {
                            (owner.notify)(RecordingPhase::NoAudio);
                        }
                        let close=ptt.abort(); write(peripheral,&tx,&close,cancel).await?;
                        return Err(Failure::temporary("遥控器未开始传输音频，正在重新连接语音通道；请松开语音键后重试。"));
                    }
                }
                health_ticks+=1;
                if health_ticks%20==0 && !operation(cancel,peripheral.is_connected(),3).await? { return Err(Failure::temporary("遥控器连接已断开。")); }
            },
            received = async {
                if let Some(item) = backlog.pop() { Ok(item) } else { notifications.next().await }
            } => {
                let TimedNotification { packet: notification, at } = received?;
                let actions=if notification.uuid==CONTROL {
                    if !service.current(generation) { return Ok(()); }
                    if cleared_at.is_some_and(|cutoff| at <= cutoff) {
                        ptt.discard_buffered_control(&notification.value)
                    } else {
                        handle_record_control(&notification.value, at, &service.dialogue, &mut gesture, &mut ptt, &mut recognition)
                    }
                } else if notification.uuid==AUDIO { ptt.audio(&notification.value).map(|_|vec![]) } else { Ok(vec![]) };
                let actions=match actions {
                    Ok(actions)=>actions,
                    Err(message) if recognition.is_some() && notification.uuid == CONTROL
                        && matches!(notification.value.first(), Some(0x00 | 0x13)) => {
                        let job = recognition.as_mut().unwrap();
                        job.interrupted = Some(message);
                        job.release();
                        ptt.busy = true;
                        service.update(generation,"transcribing","",None);
                        vec![]
                    }
                    Err(message) if recognition.is_some() && ptt.interrupt_capture().is_some() => {
                        let job = recognition.as_mut().unwrap();
                        job.interrupted = Some(message.clone());
                        job.audio.take();
                        service.update(generation, "audio-error", &message, None);
                        continue;
                    }
                    Err(message)=>{
                        let close=ptt.abort(); write(peripheral,&tx,&close,cancel).await?;
                        // MIC_CLOSE invalidates Notify on firmware 2671.
                        // End this attempt so only freshly subscribed audio
                        // can enter the next physical PTT session.
                        return Err(Failure::temporary(&format!("{message} 正在重新连接语音通道，请稍后重新录制。")));
                    }
                };
                while let Some(pcm) = ptt.take_chunk() {
                    if recognition.as_mut().is_some_and(|job| job.enqueue(pcm)) {
                        service.update(generation, "recording", "", None);
                    }
                }
                if notification.uuid == CONTROL && matches!(notification.value.first(), Some(0x00 | 0x13)) {
                    // An interrupted capture discarded its tail until this physical release.
                    if let Some(job) = recognition.as_mut().filter(|j| j.interrupted.is_some() && !j.released && actions.is_empty()) {
                        job.release();
                        ptt.busy = true;
                        service.update(generation,"transcribing","",None);
                    }
                }
                for action in actions {
                    match action {
                        Action::AcknowledgePress(data) => {
                            notifications.drain_available(&mut backlog)?;
                            if !backlog.mic_open_obsolete() { write(peripheral, &tx, &data, cancel).await?; }
                        }
                        Action::OpenMic(data)=>{
                            // MIC_OPEN is the earliest accepted key-down indication. Signal the pet
                            // before waiting for its GATT response or the first audio packet.
                            service.update(generation, "preparing-microphone", "", None);
                            let target = startup_target.take().unwrap_or_else(|| service.prepare_recording_focus(generation));
                            let mut job = Recognition::start(target, cancel.clone(), speech.clone());
                            notifications.drain_available(&mut backlog)?;
                            if backlog.mic_open_obsolete() {
                                recognition = Some(job);
                                continue;
                            }
                            // Poll both immediately. The WebSocket handshake must not delay MIC_OPEN,
                            // and the GATT write acknowledgement must not delay the handshake.
                            let mic = write(peripheral, &tx, &data, cancel);
                            tokio::pin!(mic);
                            tokio::select! {
                                result = job.work.as_mut() => {
                                    job.result = Some(result);
                                    mic.await?;
                                }
                                result = &mut mic => { result?; }
                            }
                            recognition = Some(job);
                        }
                        Action::State(state)=>{
                            if state == "recording" {
                                if recognition.as_ref().is_some_and(|job| job.stream_started) {
                                    // ATVV ignores duplicate stream IDs. A new ID supersedes all earlier work.
                                    recognition = None;
                                }
                                let job = recognition.get_or_insert_with(|| Recognition::start(
                                    startup_target.take().unwrap_or_else(|| service.prepare_recording_focus(generation)),
                                    cancel.clone(), speech.clone()));
                                job.stream_started = true;
                                service.update(generation, "preparing-microphone", "", None);
                                continue;
                            } else if state != "busy" {
                                if state == "no-audio" {
                                    if let Some(owner) = recognition.as_ref().and_then(|job| job.feedback.as_ref()) {
                                        (owner.notify)(RecordingPhase::NoAudio);
                                    }
                                }
                                recognition = None;
                            }
                            service.update(generation,state,"",None);
                        }
                        Action::Recognize{samples}=>{
                            service.update(generation,"transcribing","",None);
                            let Some(job) = &mut recognition else { return Err(Failure::temporary("录音状态失效，请重新按键。")); };
                            job.enqueue(samples);
                            job.release();
                        }
                    }
                }
            },

        }
        if !gesture.defer_result(Instant::now()) && recognition.as_ref().is_some_and(|job| job.released && job.result.is_some()) {
            let mut job = recognition.take().unwrap();
            let mut result = job.finish();
            ptt.busy = false;
            if !operation(cancel, peripheral.is_connected(), 5).await? {
                return Err(Failure::temporary("识别结束前蓝牙已断开，本段结果已丢弃。"));
            }
            let pending_text = match &result {
                Ok(text) | Err(RecognitionError::Partial(text, _)) => !text.is_empty(),
                _ => false,
            };
            let owner = job.feedback.as_deref();
            if pending_text && !owner.is_some_and(|target| target.pet_delivery.is_some()) {
                let ready = tokio::select! {
                    biased;
                    _=cancelled(&mut stop)=>return Ok(()),
                    ready=confirm_composer(service.prepare_composer())=>ready,
                };
                if let Err(blocked) = ready { result = Err(blocked); }
            }
            if service.poll_clear(generation) {
                cleared_at = Some(Instant::now());
                startup_target.take();
                gesture = RecordGesture::default();
                cancel_utterance(&mut ptt, &mut recognition);
                service.clear(generation);
                continue;
            }
            match result {
                Ok(text) if text.is_empty() => service.update(generation, "ready", "", None),
                Ok(text) => { service.deliver_recognition(generation, owner, &text, true).await; }
                Err(RecognitionError::Partial(text, error)) => {
                    if text.is_empty() || service.deliver_recognition(generation, owner, &text, false).await {
                        service.update(generation, "cloud-error", &format!("部分语音未能识别。{error}"), None);
                    }
                }
                Err(RecognitionError::Cloud(error)) => service.update(generation, "cloud-error", &error, None),
                Err(RecognitionError::Focus(error)) => service.update(generation, "input-blocked", &error, None),
            }
        }
    }
}

#[cfg(test)]
#[path = "ble_startup_tests.rs"]
mod startup_tests;

#[cfg(test)]
#[path = "ble_gesture_tests.rs"]
mod gesture_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn released_job(target: RecordingTarget, work: impl Future<Output = Result<String, String>> + Send + 'static) -> Recognition {
        let mut job = Recognition::with_transcriber(target, move |_, _| Box::pin(work));
        job.release();
        job
    }

    #[tokio::test]
    async fn key_down_opens_one_stream_which_receives_all_pcm_and_finishes_only_on_release() {
        use std::sync::Mutex;
        let events = Arc::new(Mutex::new(Vec::new()));
        let ui = events.clone();
        let target = RecordingFeedback { pet_delivery: None, focus: None, notify: Box::new(move |phase| {
            ui.lock().unwrap().push(match phase {
                RecordingPhase::Recording => "record".into(),
                RecordingPhase::NoAudio => "no-audio".into(),
                RecordingPhase::Preview(text) => text,
                RecordingPhase::Transcribing => "waiting".into(),
                RecordingPhase::End => "end".into(),
            });
        }) };
        let captured = Arc::new(Mutex::new(Vec::new()));
        let received = captured.clone();
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let opened = connected.clone();
        let mut job = Recognition::with_transcriber(Ok(Some(target)), move |mut audio, mut preview| Box::pin(async move {
            opened.store(true, std::sync::atomic::Ordering::Relaxed);
            let mut first = true;
            while let Some(chunk) = audio.recv().await {
                received.lock().unwrap().extend(chunk);
                if first { preview("早期假设"); first = false; }
            }
            Ok("完整结果".into())
        }));
        assert!(futures_util::poll!(&mut job.work).is_pending());
        assert!(connected.load(std::sync::atomic::Ordering::Relaxed));
        job.stream_started = true;
        assert!(events.lock().unwrap().is_empty(), "a stream start alone contains no audio");
        let mut ptt = Ptt::new(Caps { version: 0x100, frame_size: 1 });
        ptt.control(&[4,0,2,1]).unwrap();
        for i in 0..800 {
            ptt.audio(&vec![if i == 0 { 0 } else { 0x77 }; CHUNK_SAMPLES/2]).unwrap();
            job.enqueue(ptt.take_chunk().unwrap());
            assert!(futures_util::poll!(&mut job.work).is_pending());
            if i == 0 { assert_eq!(&*events.lock().unwrap(), &["record", "早期假设"]); }
        }
        ptt.audio(&[0x77;2]).unwrap();
        let Action::Recognize { samples }=ptt.control(&[0]).unwrap().pop().unwrap() else { panic!("invalid release") };
        job.enqueue(samples);
        job.release();
        assert_eq!(job.work.as_mut().await.unwrap(),"完整结果");
        let pcm = captured.lock().unwrap();
        assert_eq!(pcm.len(), 800 * CHUNK_SAMPLES + 4);
        assert_eq!(&pcm[..CHUNK_SAMPLES], vec![0;CHUNK_SAMPLES]);
        assert_eq!(pcm.last(),Some(&i16::MAX));
        drop(job);
        assert_eq!(&*events.lock().unwrap(), &["record","早期假设","waiting","end"]);
    }

    #[tokio::test]
    async fn pending_capacity_closes_only_the_contiguous_prefix_for_literal_completion() {
        let mut job = Recognition::with_transcriber(Ok(None), |mut pcm, _| Box::pin(async move {
            let mut count=0;
            while pcm.recv().await.is_some() { count+=1; }
            assert_eq!(count,MAX_PENDING_CHUNKS);
            Ok("发送提示词".into())
        }));
        for _ in 0..MAX_PENDING_CHUNKS+2 { job.enqueue(vec![100]); }
        job.release();
        job.result = Some(job.work.as_mut().await);
        assert!(matches!(job.finish(),Err(RecognitionError::Partial(text,_)) if text=="发送提示词"));
    }

    #[test]
    fn unavailable_adapters_retry_across_sleep_but_confirmed_denial_stops() {
        assert!(bluetooth_error(btleplug::Error::NoAdapterAvailable).retry);
        assert!(bluetooth_error(btleplug::Error::TimedOut(Duration::from_secs(5))).retry);
        let localized_denial = btleplug::Error::Other("HRESULT(0x80070005): 拒绝访问".into());
        assert!(!bluetooth_error(localized_denial).retry);
        assert!(missing_atvv(true, false).retry);
        assert!(missing_atvv(false, true).retry);
        assert!(!missing_atvv(false, false).retry);
        for absent in [false, true] {
            assert!(radio_unavailable(absent, false).retry);
            assert!(!radio_unavailable(absent, true).retry);
        }
    }

    #[test]
    fn incomplete_first_discovery_retries_once_and_pins_the_same_remote() {
        #[cfg(target_os = "macos")]
        let identity = "12345678-1234-5678-1234-567812345678";
        #[cfg(windows)]
        let identity = "E8:55:40:EE:4D:D9";
        let device = requested_id(identity).unwrap();
        let mut target = None;
        let mut first = missing_atvv(false, false);
        recover_missing_atvv(&mut first, device.clone(), &mut target);
        assert!(first.retry);
        assert_eq!(target.as_ref(), Some(&device));
        let mut second = missing_atvv(false, false);
        recover_missing_atvv(&mut second, device.clone(), &mut target);
        assert!(!second.retry);
        assert!(second.message.contains("蓝牙服务诊断"));
        assert!(!second.message.contains("设备不提供"));
        // Permission/cancellation errors cannot be converted into connection retries.
        for mut error in [bluetooth_error(btleplug::Error::PermissionDenied), Failure::permanent("已停止。") ] {
            let mut target = None;
            recover_missing_atvv(&mut error, device.clone(), &mut target);
            assert!(!error.retry);
            assert!(target.is_none());
        }
        for empty in [false, true] {
            let mut error = missing_atvv(empty, true);
            recover_missing_atvv(&mut error, device.clone(), &mut target);
            assert!(error.retry, "previously validated devices retain sleep recovery");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn saved_uuid_requires_exact_identity_and_remote_evidence_without_a_connection() {
        let requested = requested_id("12345678-1234-5678-1234-567812345678").unwrap();
        let other = requested_id("12345678-1234-5678-1234-567812345679").unwrap();
        assert!(saved_remote_matches(&requested, &requested, Some("小米蓝牙语音遥控器"), &[]));
        assert!(saved_remote_matches(&requested, &requested, None, &[SERVICE]));
        for name in [None, Some("Xiaomi"), Some("Bluetooth Remote"), Some("Xiaomi Keyboard"), Some("Xiaomi Headphones")] {
            assert!(!saved_remote_matches(&requested, &requested, name, &[]));
        }
        assert!(!saved_remote_matches(&requested, &other, Some("RC003"), &[SERVICE]));
        assert!(requested_id("AA:BB:CC:DD:EE:FF").is_err());
    }

    #[test]
    fn invalid_identifiers_and_permission_errors_are_bounded() {
        assert!(requested_id("invalid").is_err());
        assert!(!bluetooth_error(btleplug::Error::PermissionDenied).retry);
        assert!(bluetooth_error(btleplug::Error::NotConnected).retry);
        assert!(remote_name("Xiaomi Bluetooth Remote 2 Pro"));
        assert!(!remote_name("普通键盘"));
    }

    #[tokio::test]
    async fn pet_handshake_is_immediate_but_pcm_waits_for_its_own_focus() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (send_focus, focus) = tokio::sync::oneshot::channel();
        let (send, pcm) = tokio::sync::mpsc::channel(2);
        send.send(vec![9]).await.unwrap();
        drop(send); // Even a fast release before focus returns can complete normally.
        let opened = Arc::new(AtomicBool::new(false));
        let observed = opened.clone();
        let work = recognize_for_focus(Ok(Some(focus)), pcm, move |mut gated| Box::pin(async move {
            observed.store(true, Ordering::SeqCst);
            assert_eq!(gated.recv().await, Some(vec![9]));
            assert_eq!(gated.recv().await, None);
            Ok("发送提示词".into())
        }));
        tokio::pin!(work);
        assert!(futures_util::poll!(&mut work).is_pending());
        assert!(opened.load(Ordering::SeqCst));
        send_focus.send(true).unwrap();
        assert_eq!(work.await.unwrap(), "发送提示词");
    }

    #[tokio::test(start_paused = true)]
    async fn delivery_requires_a_positive_foreground_composer_ack_but_external_paste_is_immediate() {
        use tokio::sync::oneshot;
        assert_eq!(confirm_composer(Ok(None)).await, Ok(()));
        let (sender, receiver) = oneshot::channel();
        let checked = confirm_composer(Ok(Some(receiver)));
        tokio::pin!(checked);
        assert!(futures_util::poll!(&mut checked).is_pending());
        sender.send(true).unwrap();
        assert_eq!(checked.await, Ok(()));
        let (refused, receiver) = oneshot::channel();
        refused.send(false).unwrap();
        assert!(matches!(confirm_composer(Ok(Some(receiver))).await, Err(RecognitionError::Focus(_))));
        let (_silent, receiver) = oneshot::channel();
        assert!(matches!(confirm_composer(Ok(Some(receiver))).await, Err(RecognitionError::Focus(_))));
    }

    #[tokio::test(start_paused = true)]
    async fn unavailable_pet_focus_blocks_cloud_work_and_keeps_cloud_errors_distinct() {
        use tokio::sync::oneshot;
        let (refused, negative) = oneshot::channel();
        refused.send(false).unwrap();
        let (closed, unavailable) = oneshot::channel();
        drop(closed);
        let (silent, unanswered) = oneshot::channel();
        for focus in [Ok(Some(negative)), Ok(Some(unavailable)), Ok(Some(unanswered)), Err("桌宠未就绪".into())] {
            let (send, pcm) = tokio::sync::mpsc::channel(2);
            send.send(vec![3]).await.unwrap();
            drop(send);
            let result = recognize_for_focus(focus, pcm, |mut gated| Box::pin(async move {
                let received = gated.recv().await;
                panic!("focus refusal must drop the handshake before sending audio or EOF: {received:?}")
            })).await;
            assert!(matches!(result, Err(RecognitionError::Focus(_))));
        }
        assert!(silent.send(true).is_err(), "a timed-out acknowledgement cannot deliver");
        let (_send, pcm) = tokio::sync::mpsc::channel(1);
        let result = recognize_for_focus(Ok(None), pcm, |_| Box::pin(async { Err("network".into()) })).await;
        assert_eq!(result, Err(RecognitionError::Cloud("network".into())));
    }

    #[test]
    fn clear_drops_a_pending_recognition_so_late_text_and_voice_send_cannot_complete() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::task::{Context, Poll};
        for text in ["late private transcript", "发送提示词。"] {
            let mut ptt = Ptt::new(Caps { version: 0x100, frame_size: 120 });
            ptt.busy = true;
            let completed = Arc::new(AtomicUsize::new(0));
            let count = Arc::clone(&completed);
            let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
            let mut recognition = Some(released_job(Ok(None), async move {
                let result = receiver.await.map_err(|_| "cancelled".to_owned())?;
                count.fetch_add(1, Ordering::SeqCst);
                Ok(result)
            }));
            let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
            assert!(matches!(recognition.as_mut().unwrap().work.as_mut().poll(&mut context), Poll::Pending));
            cancel_utterance(&mut ptt, &mut recognition);
            assert!(recognition.is_none());
            assert!(!ptt.busy);
            assert!(sender.send(text.to_string()).is_err(), "the revoked utterance must have no receiver");
            assert_eq!(completed.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn clear_wins_over_an_already_ready_result_without_poisoning_the_next_utterance() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for text in ["already ready transcript", "发送提示词"] {
            let mut ptt = Ptt::new(Caps { version: 0x100, frame_size: 120 });
            ptt.busy = true;
            let completed = Arc::new(AtomicUsize::new(0));
            let count = Arc::clone(&completed);
            let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
            let mut recognition = Some(released_job(Ok(None), async move {
                let result = receiver.await.map_err(|_| "cancelled".to_owned())?;
                count.fetch_add(1, Ordering::SeqCst);
                Ok(result)
            }));
            sender.send(text.to_string()).unwrap();
            cancel_utterance(&mut ptt, &mut recognition);
            assert!(recognition.is_none());
            assert_eq!(completed.load(Ordering::SeqCst), 0);
            let next = released_job(Ok(None), async { Ok("fresh next utterance".into()) });
            assert_eq!(next.work.await.unwrap(), "fresh next utterance");
        }
    }
}
