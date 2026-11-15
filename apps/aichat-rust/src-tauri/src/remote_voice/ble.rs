//! Native BLE transport. Retrieving already connected peripherals is required:
//! paired HID remotes often stop advertising while the OS owns their keyboard.
use super::gestures::{Edge, Press, RecordGesture, Release};
use super::atvv::{Action, Caps, Ptt, CHUNK_SAMPLES, AUDIO, CONTROL, GET_CAPS, SERVICE, TX};
use super::{asr, cancelled, RecordingFeedback, RecordingFocus, RecordingPhase, RecordingTarget, RemoteVoice, VoiceConfig};
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

pub(super) const BLUETOOTH_OFF: &str = "没有已开启的 BLE 蓝牙适配器，请开启系统蓝牙后重试。";
pub(super) const NO_ADAPTER: &str = "没有可用的 BLE 蓝牙适配器，请开启蓝牙后重试。";

#[derive(Clone, Debug)]
struct Failure {
    message: String,
    retry: bool,
}
impl Failure {
    fn temporary(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: true,
        }
    }
    fn permanent(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: false,
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
    let name = name.to_lowercase();
    ["xiaomi", "rc001", "rc003", "小米"]
        .iter()
        .any(|n| name.contains(n))
}
fn choose(mut peripherals: Vec<Peripheral>) -> Result<Option<Peripheral>, Failure> {
    let mut seen = std::collections::HashSet::new();
    peripherals.retain(|p| seen.insert(p.id()));
    if peripherals.len() > 1 {
        return Err(Failure::permanent(
            "发现多个遥控器，请在设置中填写要使用的蓝牙设备 ID。",
        ));
    }
    Ok(peripherals.pop())
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
            if let Some(peripheral) = choose(known)? {
                return Ok(peripheral);
            }
        }
    } else {
        let known = operation(
            cancel,
            adapter.retrieve_peripherals(RetrievePeripheralsOptions {
                identifiers: None,
                services: Some(vec![SERVICE]),
            }),
            10,
        )
        .await?;
        if let Some(peripheral) = choose(known)? {
            return Ok(peripheral);
        }
        let keyboards = operation(
            cancel,
            adapter.retrieve_peripherals(RetrievePeripheralsOptions {
                identifiers: None,
                services: Some(vec![Uuid::from_u128(0x0000181200001000800000805f9b34fb)]),
            }),
            10,
        )
        .await?;
        let mut remotes = vec![];
        for peripheral in keyboards {
            if let Some(properties) = operation(cancel, peripheral.properties(), 5).await? {
                if properties.local_name.as_deref().is_some_and(remote_name) {
                    remotes.push(peripheral);
                }
            }
        }
        if let Some(peripheral) = choose(remotes)? {
            return Ok(peripheral);
        }
    }
    let scanning=async {
        operation(cancel, adapter.start_scan(ScanFilter::default()), 10).await?;
        let mut stop=cancel.clone();
        tokio::select! { biased; _=cancelled(&mut stop)=>return Err(Failure::permanent("已停止。")), _=sleep(Duration::from_secs(8))=>{} }
        let mut candidates=vec![];
        for peripheral in operation(cancel,adapter.peripherals(),5).await? {
            if let Some(id)=requested {
                if &peripheral.id()==id { candidates.push(peripheral); }
            } else if let Some(properties)=operation(cancel,peripheral.properties(),5).await? {
                if properties.services.contains(&SERVICE) || properties.local_name.as_deref().is_some_and(remote_name) { candidates.push(peripheral); }
            }
        }
        choose(candidates)?.ok_or_else(||Failure::temporary("未找到小米遥控器，请先在系统蓝牙设置配对并按键唤醒；也可填写设备 ID。"))
    }.await;
    let _ = timeout(Duration::from_secs(2), adapter.stop_scan()).await;
    scanning
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
    while service.current(generation) {
        service.update(generation, "scanning", "", None);
        let attempt = async {
            let adapter = powered_adapter(&cancel).await?;
            let peripheral = discover(&adapter, requested.as_ref(), &cancel).await?;
            service.update(
                generation,
                "connecting",
                "",
                Some(peripheral.id().to_string()),
            );
            let result = connection(service, generation, &adapter, &peripheral, &cancel).await;
            service.dialogue.exit("disconnected");
            service.disarm(generation);
            // No audio request survives this attempt. Release this client's
            // GATT subscriptions, never OS pairing or another app's connection.
            for ch in peripheral
                .characteristics()
                .iter()
                .filter(|c| [AUDIO, CONTROL].contains(&c.uuid))
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
            Err(error) if !error.retry => return Err(error.message),
            Err(error) => service.update(generation, "reconnecting", &error.message, None),
        }
        let mut stop = cancel.clone();
        tokio::select! { biased; _=cancelled(&mut stop)=>break, _=sleep(Duration::from_secs(delay))=>{} }
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
    recording: bool,
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
        Self { work: Box::pin(work), audio: Some(audio), feedback, recording: false,
            released: false, interrupted: None, result: None }
    }
    fn recording(&mut self) {
        self.recording = true;
        if let Some(owner) = &self.feedback { (owner.notify)(RecordingPhase::Recording); }
    }
    fn enqueue(&mut self, pcm: Vec<i16>) {
        if pcm.is_empty() || self.result.is_some() { return; }
        if let Some(audio) = &self.audio {
            if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) = audio.try_send(pcm) {
                self.interrupted = Some("语音处理积压超过限制。".into());
                self.audio.take();
            }
        }
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
                dialogue.record();
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
        Failure::permanent("设备不提供完整的 ATVV 语音服务，请检查遥控器型号。")
    }
}

async fn connection(
    service: &RemoteVoice,
    generation: u64,
    adapter: &Adapter,
    peripheral: &Peripheral,
    cancel: &watch::Receiver<bool>,
) -> Result<(), Failure> {
    let mut events = operation(cancel, adapter.events(), 5).await?;
    if !operation(cancel, peripheral.is_connected(), 5).await? {
        operation(cancel, peripheral.connect(), 15).await?;
    }
    operation(cancel, peripheral.discover_services(), 15).await?;
    // A newly resumed radio can publish its characteristics in stages. Remember only
    // the last successfully negotiated device across reconnects and service restarts.
    static LAST_VALIDATED: std::sync::Mutex<Option<PeripheralId>> = std::sync::Mutex::new(None);
    let device_id = peripheral.id();
    let chars = peripheral.characteristics();
    let find = |id| {
        chars.iter().find(|c| c.uuid == id).cloned().ok_or_else(|| {
            let known = LAST_VALIDATED.lock().unwrap().as_ref() == Some(&device_id);
            missing_atvv(chars.is_empty(), known)
        })
    };
    let tx = find(TX)?;
    let control = find(CONTROL)?;
    let audio = find(AUDIO)?;
    let mut notifications = operation(cancel, peripheral.notifications(), 5).await?;
    operation(cancel, peripheral.subscribe(&control), 5).await?;
    operation(cancel, peripheral.subscribe(&audio), 5).await?;
    write(peripheral, &tx, GET_CAPS, cancel).await?;
    let caps = async {
        while let Some(notification) = notifications.next().await {
            if notification.uuid == CONTROL && notification.value.first() == Some(&0x0b) {
                return Caps::parse(&notification.value).map_err(|message| Failure {
                    message,
                    retry: false,
                });
            }
        }
        Err(Failure::temporary("遥控器在协商语音能力时断开。"))
    };
    let mut stop = cancel.clone();
    let caps = tokio::select! {
        biased;
        _=cancelled(&mut stop)=>return Ok(()),
        result=timeout(Duration::from_secs(5),caps)=>result.map_err(|_|Failure::temporary("ATVV 能力协商超时，请唤醒遥控器后重试。"))??,
    };
    *LAST_VALIDATED.lock().unwrap() = Some(device_id);
    service.arm(generation).map_err(|message| Failure {
        message,
        retry: false,
    })?;
    service.update(generation, "ready", "", None);
    let mut ptt = Ptt::new(caps);
    let mut gesture = RecordGesture::default();
    let mut recognition: Option<Recognition> = None;
    let speech = std::sync::Arc::new(asr::SpeechConnection::default());
    let mut heartbeat = tokio::time::interval(Duration::from_millis(50));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut health_ticks = 0;
    loop {
        service.dispatch_home(generation);
        if super::dialogue::take_ok() { service.dialogue.exit("ok"); }
        if service.poll_clear(generation) {
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
                        let close=ptt.abort(); write(peripheral,&tx,&close,cancel).await?;
                        return Err(Failure::temporary("遥控器未开始传输音频，正在重新连接语音通道；请松开语音键后重试。"));
                    }
                }
                health_ticks+=1;
                if health_ticks%20==0 && !operation(cancel,peripheral.is_connected(),3).await? { return Err(Failure::temporary("遥控器连接已断开。")); }
            },
            notification=notifications.next()=>{
                let Some(notification)=notification else { return Err(Failure::temporary("遥控器音频连接已结束。")); };
                let actions=if notification.uuid==CONTROL {
                    if !service.current(generation) { return Ok(()); }
                    handle_record_control(&notification.value, Instant::now(), &service.dialogue, &mut gesture, &mut ptt, &mut recognition)
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
                    if let Some(job) = &mut recognition { job.enqueue(pcm); }
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
                        Action::AcknowledgePress(data) => write(peripheral, &tx, &data, cancel).await?,
                        Action::OpenMic(data)=>{
                            // MIC_OPEN is the earliest accepted key-down indication. Signal the pet
                            // before waiting for its GATT response or the first audio packet.
                            let mut job = Recognition::start(service.prepare_recording_focus(generation), cancel.clone(), speech.clone());
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
                                if recognition.as_ref().is_some_and(|job| job.recording) {
                                    // ATVV ignores duplicate stream IDs. A new ID supersedes all earlier work.
                                    recognition = None;
                                }
                                let job = recognition.get_or_insert_with(|| Recognition::start(
                                    service.prepare_recording_focus(generation), cancel.clone(), speech.clone()));
                                job.recording();
                            } else if state != "busy" {
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
            if pending_text {
                let ready = tokio::select! {
                    biased;
                    _=cancelled(&mut stop)=>return Ok(()),
                    ready=confirm_composer(service.prepare_composer())=>ready,
                };
                if let Err(blocked) = ready { result = Err(blocked); }
            }
            if service.poll_clear(generation) {
                cancel_utterance(&mut ptt, &mut recognition);
                service.clear(generation);
                continue;
            }
            match result {
                Ok(text) if text.is_empty() => service.update(generation, "ready", "", None),
                Ok(text) => service.deliver(generation, &text),
                Err(RecognitionError::Partial(text, error)) => {
                    if text.is_empty() || service.deliver_literal(generation, &text) {
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
        let target = RecordingFeedback { focus: None, notify: Box::new(move |phase| {
            ui.lock().unwrap().push(match phase {
                RecordingPhase::Recording => "record".into(),
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
        job.recording();
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
