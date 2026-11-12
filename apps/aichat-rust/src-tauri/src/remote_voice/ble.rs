//! Native BLE transport. Retrieving already connected peripherals is required:
//! paired HID remotes often stop advertising while the OS owns their keyboard.
use super::atvv::{Action, Caps, Ptt, AUDIO, CONTROL, GET_CAPS, SERVICE, TX};
use super::native_input::{NativeInput, Target};
use super::{asr, cancelled, RemoteVoice, VoiceConfig};
use btleplug::api::{
    Central, CentralEvent, CentralState, Characteristic, Manager as _, Peripheral as _,
    RetrievePeripheralsOptions, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures_util::{future::pending, StreamExt};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

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
        btleplug::Error::NoAdapterAvailable => {
            Failure::permanent("没有可用的 BLE 蓝牙适配器，请开启蓝牙后重试。")
        }
        other => {
            let message = other.to_string().to_lowercase();
            if [
                "denied",
                "unauthorized",
                "not authorized",
                "access is denied",
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
    explicit: &str,
    cancel: &watch::Receiver<bool>,
) -> Result<Peripheral, Failure> {
    let requested = if explicit.is_empty() {
        None
    } else {
        Some(requested_id(explicit)?)
    };
    if let Some(id) = &requested {
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
    operation(cancel, adapter.start_scan(ScanFilter::default()), 10).await?;
    let scanning=async {
        let mut stop=cancel.clone();
        tokio::select! { biased; _=cancelled(&mut stop)=>return Err(Failure::permanent("已停止。")), _=sleep(Duration::from_secs(8))=>{} }
        let mut candidates=vec![];
        for peripheral in operation(cancel,adapter.peripherals(),5).await? {
            if let Some(id)=&requested {
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

pub(super) async fn run(
    service: &RemoteVoice,
    generation: u64,
    config: VoiceConfig,
    native: Arc<NativeInput>,
    cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let manager = operation(&cancel, Manager::new(), 15)
        .await
        .map_err(|e| e.message)?;
    let adapters = operation(&cancel, manager.adapters(), 10)
        .await
        .map_err(|e| e.message)?;
    let mut selected = None;
    for adapter in adapters {
        if operation(&cancel, adapter.adapter_state(), 5)
            .await
            .map_err(|e| e.message)?
            == CentralState::PoweredOn
        {
            selected = Some(adapter);
            break;
        }
    }
    let adapter = selected.ok_or("没有已开启的 BLE 蓝牙适配器，请开启系统蓝牙后重试。")?;
    let mut delay = 2;
    while service.current(generation) {
        service.update(generation, "scanning", "", None);
        let attempt = async {
            let peripheral = discover(&adapter, &config.device, &cancel).await?;
            service.update(
                generation,
                "connecting",
                "",
                Some(peripheral.id().to_string()),
            );
            let result =
                connection(service, generation, &adapter, &peripheral, &native, &cancel).await;
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
        if !service.current(generation) {
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

type Recognition = Pin<Box<dyn Future<Output = (Option<Target>, Result<String, String>)> + Send>>;
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
async fn connection(
    service: &RemoteVoice,
    generation: u64,
    adapter: &Adapter,
    peripheral: &Peripheral,
    native: &NativeInput,
    cancel: &watch::Receiver<bool>,
) -> Result<(), Failure> {
    let mut events = operation(cancel, adapter.events(), 5).await?;
    if !operation(cancel, peripheral.is_connected(), 5).await? {
        operation(cancel, peripheral.connect(), 15).await?;
    }
    operation(cancel, peripheral.discover_services(), 15).await?;
    let chars = peripheral.characteristics();
    let find =
        |id| {
            chars.iter().find(|c| c.uuid == id).cloned().ok_or_else(|| {
                Failure::permanent("设备不提供完整的 ATVV 语音服务，请检查遥控器型号。")
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
    service.arm(generation).map_err(|message| Failure {
        message,
        retry: false,
    })?;
    service.update(generation, "ready", "", None);
    let mut ptt = Ptt::<Target>::new(caps);
    let mut recognition: Option<Recognition> = None;
    let mut heartbeat = tokio::time::interval(Duration::from_millis(250));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut health_ticks = 0;
    loop {
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
            notification=notifications.next()=>{
                let Some(notification)=notification else { return Err(Failure::temporary("遥控器音频连接已结束。")); };
                let actions=if notification.uuid==CONTROL {
                    let target=if matches!(notification.value.first(),Some(0x04|0x11)) { native.target() } else { None };
                    ptt.control(&notification.value,target)
                } else if notification.uuid==AUDIO { ptt.audio(&notification.value).map(|_|vec![]) } else { Ok(vec![]) };
                let actions=match actions {
                    Ok(actions)=>actions,
                    Err(message)=>{
                        let close=ptt.abort(); write(peripheral,&tx,&close,cancel).await?;
                        service.update(generation,"error",&message,None); continue;
                    }
                };
                for action in actions {
                    match action {
                        Action::Write(data)=>write(peripheral,&tx,&data,cancel).await?,
                        Action::State(state)=>service.update(generation,state,"",None),
                        Action::Recognize{samples,target}=>{
                            service.update(generation,"transcribing","",None);
                            let cancel=cancel.clone();
                            recognition=Some(Box::pin(async move { let result=asr::transcribe(&samples,cancel).await; (target,result) }));
                        }
                    }
                }
            },
            result=async { if let Some(work)=recognition.as_mut() { work.await } else { pending().await } }=>{
                recognition=None; ptt.busy=false;
                if !operation(cancel,peripheral.is_connected(),5).await? { return Err(Failure::temporary("识别结束前蓝牙已断开，本段结果已丢弃。")); }
                match result {
                    (_,Ok(text)) if text.trim().is_empty()=>service.update(generation,"ready","",None),
                    (target,Ok(text))=>service.deliver(generation,&text,&target),
                    (_,Err(error))=>service.update(generation,"cloud-error",&error,None),
                }
            },
            _=heartbeat.tick()=>{
                if ptt.expired() {
                    let close=ptt.abort(); write(peripheral,&tx,&close,cancel).await?;
                    service.update(generation,"error","单次语音输入不能超过 60 秒，请松开语音键后重试。",None);
                }
                health_ticks+=1;
                if health_ticks%4==0 && !operation(cancel,peripheral.is_connected(),3).await? { return Err(Failure::temporary("遥控器连接已断开。")); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_identifiers_and_permission_errors_are_bounded() {
        assert!(requested_id("invalid").is_err());
        assert!(!bluetooth_error(btleplug::Error::PermissionDenied).retry);
        assert!(bluetooth_error(btleplug::Error::NotConnected).retry);
        assert!(remote_name("Xiaomi Bluetooth Remote 2 Pro"));
        assert!(!remote_name("普通键盘"));
    }
}
