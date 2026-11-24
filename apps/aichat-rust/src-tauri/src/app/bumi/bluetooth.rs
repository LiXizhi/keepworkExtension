use super::protocol::{self, Reading, NOTIFY, SERVICE, WRITE};
use super::{Command, Device, LocomotionMode, Request, Snapshot};
use btleplug::api::{
    Central, CentralEvent, CentralState, CharPropFlags, Characteristic, Manager as _,
    Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures_util::{future::Shared, FutureExt, StreamExt};
use std::collections::BTreeSet;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tokio::time::{sleep, timeout};

type Adapters = Shared<futures_util::future::BoxFuture<'static, Result<Vec<Adapter>, String>>>;

const CLOSED: &str = "Bumi 控制窗口已关闭。";
const DISCONNECTED: &str = "请先连接 Bumi 机器人。";
const PERMISSION: &str = "蓝牙权限未开启。请在系统设置中允许 Keepwork 使用蓝牙，然后重试。";
const SCAN_WINDOW_SECONDS: u64 = 20;

#[derive(Default)]
pub(super) struct Bluetooth {
    adapters: Option<Adapters>,
    owner: Option<watch::Receiver<()>>,
    devices: Vec<(Device, Peripheral)>,
    connection: Option<Connection>,
    listener: Option<Listener>,
}

struct Listener {
    _stop: watch::Sender<()>,
    active: Arc<AtomicBool>,
}

struct Connection {
    device: Device,
    peripheral: Peripheral,
    tx: Characteristic,
    write_type: WriteType,
    last_motion_write: Option<Instant>,
    battery: Option<u8>,
    status: Option<i8>,
    moving: bool,
    locomotion_mode: Option<LocomotionMode>,
}

impl Bluetooth {
    pub(super) async fn request(
        &mut self,
        app: &AppHandle,
        request: Request,
        mut lifetime: watch::Receiver<()>,
    ) -> Result<Snapshot, String> {
        if lifetime.has_changed().is_err() {
            return Err(CLOSED.into());
        }
        if !self.owned_by(&lifetime) {
            self.reset().await;
            self.owner = Some(lifetime.clone());
        }
        if let Some(connection) = &self.connection {
            let connected = during(
                &mut lifetime,
                2,
                connection.peripheral.is_connected().map(map_error),
            )
            .await?;
            if !connected {
                self.disconnect().await;
            }
        }

        match request {
            Request::Status => {}
            Request::Scan if self.connection.is_none() => {
                self.devices.clear();
                self.devices = scan(self.adapter(&mut lifetime).await?, &mut lifetime).await?;
            }
            Request::Connect { id } if self.connection.is_none() => {
                let (device, peripheral) = self
                    .devices
                    .iter()
                    .find(|(device, _)| device.id == id)
                    .cloned()
                    .ok_or("请从最近一次扫描结果中选择机器人。")?;
                self.connection = Some(connect(device, peripheral, &mut lifetime).await?);
            }
            Request::Scan | Request::Connect { .. } => return Err("请先断开当前机器人。".into()),
            Request::Disconnect => self.disconnect().await,
            Request::Listen { enabled } => self.set_listening(app, enabled, &mut lifetime).await?,
            Request::Send { command } => {
                let monitor = self
                    .listener
                    .as_ref()
                    .filter(|listener| listener.active.load(Ordering::Relaxed))
                    .map(|_| app);
                let connection = self.connection.as_mut().ok_or(DISCONNECTED)?;
                connection.send(command, &mut lifetime, monitor).await?;
            }
        }

        let locomotion_mode = self.connection.as_ref().and_then(|c| c.locomotion_mode);
        Ok(Snapshot {
            available: true,
            devices: self
                .devices
                .iter()
                .map(|(device, _)| device.clone())
                .collect(),
            connected: self
                .connection
                .as_ref()
                .map(|connection| connection.device.clone()),
            battery: self
                .connection
                .as_ref()
                .and_then(|connection| connection.battery),
            status: self
                .connection
                .as_ref()
                .and_then(|connection| connection.status),
            moving: self
                .connection
                .as_ref()
                .is_some_and(|connection| connection.moving),
            walk_mode: locomotion_mode == Some(LocomotionMode::Walk),
            locomotion_mode,
            listening: self
                .listener
                .as_ref()
                .is_some_and(|listener| listener.active.load(Ordering::Relaxed)),
        })
    }

    async fn set_listening(
        &mut self,
        app: &AppHandle,
        enabled: bool,
        lifetime: &mut watch::Receiver<()>,
    ) -> Result<(), String> {
        if !enabled {
            self.stop_listening();
            return Ok(());
        }
        if self
            .listener
            .as_ref()
            .is_some_and(|listener| listener.active.load(Ordering::Relaxed))
        {
            return Ok(());
        }
        let peripheral = self
            .connection
            .as_ref()
            .ok_or(DISCONNECTED)?
            .peripheral
            .clone();
        let notifications = during(lifetime, 2, peripheral.notifications().map(map_error)).await?;
        self.stop_listening();
        let active = Arc::new(AtomicBool::new(true));
        let (stop, mut cancelled) = watch::channel(());
        let task_active = Arc::clone(&active);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut notifications = notifications;
            loop {
                let value = tokio::select! {
                    biased;
                    _ = cancelled.changed() => break,
                    value = notifications.next() => value,
                };
                let Some(value) = value else { break };
                if value.uuid != NOTIFY {
                    continue;
                }
                let description = protocol::describe(&value.value);
                emit_frame(&app, "rx", &value.value, description);
            }
            // Explicit stops already return a snapshot. A cancelled task must
            // not overwrite the next listener's active state.
            if task_active.swap(false, Ordering::Relaxed) {
                let _ = app.emit_to(
                    super::LABEL,
                    "bumi:listener",
                    serde_json::json!({ "active": false }),
                );
            }
        });
        self.listener = Some(Listener {
            _stop: stop,
            active,
        });
        Ok(())
    }

    fn stop_listening(&mut self) {
        if let Some(connection) = &mut self.connection {
            connection.last_motion_write = None;
        }
        if let Some(listener) = self.listener.take() {
            listener.active.store(false, Ordering::Relaxed);
        }
    }

    async fn adapter(&mut self, lifetime: &mut watch::Receiver<()>) -> Result<Adapter, String> {
        // Keep the pending macOS central initialization across timeouts. It owns
        // a CoreBluetooth thread and may be waiting for system Bluetooth consent.
        let pending = self.adapters.get_or_insert_with(|| {
            async {
                let manager = Manager::new().await.map_err(ble_error)?;
                manager.adapters().await.map_err(ble_error)
            }
            .boxed()
            .shared()
        });
        let adapters = during(lifetime, 8, pending.clone()).await?;
        if adapters.is_empty() {
            self.adapters = None;
        }
        for adapter in adapters {
            if during(lifetime, 3, adapter.adapter_state().map(map_error)).await?
                == CentralState::PoweredOn
            {
                return Ok(adapter);
            }
        }
        if permission_denied() {
            return Err(PERMISSION.into());
        }
        Err("没有可用的蓝牙适配器。请开启系统蓝牙，然后重试。".into())
    }

    fn owned_by(&self, lifetime: &watch::Receiver<()>) -> bool {
        self.owner
            .as_ref()
            .is_some_and(|owner| owner.same_channel(lifetime))
    }

    pub(super) async fn close(&mut self, lifetime: &watch::Receiver<()>) {
        if self.owned_by(lifetime) {
            self.reset().await;
            self.owner = None;
        }
    }

    async fn reset(&mut self) {
        self.stop_listening();
        self.devices.clear();
        self.disconnect().await;
    }

    async fn disconnect(&mut self) {
        self.stop_listening();
        if let Some(mut connection) = self.connection.take() {
            if connection.moving {
                let (_sender, mut lifetime) = watch::channel(());
                if let Err(error) = connection
                    .send(Command::Move { vx: 0, vyaw: 0 }, &mut lifetime, None)
                    .await
                {
                    eprintln!("Bumi: failed to stop movement before disconnect: {error}");
                }
            }
            disconnect(&connection.peripheral).await;
        }
    }
}

fn emit_frame(app: &AppHandle, direction: &str, bytes: &[u8], description: protocol::Description) {
    let size = bytes.len();
    let captured = &bytes[..size.min(1024)];
    let message = serde_json::json!({
        "receivedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "direction": direction,
        "size": size,
        "truncated": size > captured.len(),
        "hex": hex(captured),
        "opcode": description.opcode,
        "summary": description.summary,
        "text": description.text,
    });
    let _ = app.emit_to(super::LABEL, "bumi:message", message);
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 3),
        |mut output, byte| {
            let _ = write!(output, "{byte:02X} ");
            output
        },
    )
}

fn supported_name(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name.contains("bumi") || name.starts_with("ntxb")
}

async fn scan(
    adapter: Adapter,
    lifetime: &mut watch::Receiver<()>,
) -> Result<Vec<(Device, Peripheral)>, String> {
    let mut events = during(lifetime, 3, adapter.events().map(map_error)).await?;
    let discovered = during(lifetime, SCAN_WINDOW_SECONDS + 10, async {
        adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(ble_error)?;
        let deadline = sleep(Duration::from_secs(SCAN_WINDOW_SECONDS));
        tokio::pin!(deadline);
        let mut seen = BTreeSet::new();
        loop {
            let event = tokio::select! {
                biased;
                _ = &mut deadline => break,
                event = events.next() => event
            };
            match event {
                Some(
                    CentralEvent::DeviceDiscovered(id)
                    | CentralEvent::DeviceUpdated(id)
                    | CentralEvent::RssiUpdate { id, .. }
                    | CentralEvent::ServicesAdvertisement { id, .. },
                ) => {
                    seen.insert(id);
                }
                Some(CentralEvent::StateUpdate(CentralState::PoweredOff)) => {
                    return Err("系统蓝牙已关闭。".into())
                }
                Some(_) => {}
                None => return Err("蓝牙扫描已中断，请重试。".into()),
            }
        }
        Ok(seen)
    })
    .await;
    let stopped = timeout(Duration::from_secs(2), adapter.stop_scan()).await;
    let seen = discovered?;
    stopped
        .map_err(|_| "停止蓝牙扫描超时。")?
        .map_err(ble_error)?;

    during(lifetime, 5, async {
        let mut devices = Vec::new();
        for id in seen {
            let Ok(peripheral) = adapter.peripheral(&id).await else {
                continue;
            };
            let Ok(Some(properties)) = peripheral.properties().await else {
                continue;
            };
            let name = properties
                .advertisement_name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .or(properties.local_name.as_deref());
            if let Some(name) = name.filter(|name| supported_name(name)) {
                devices.push((
                    Device {
                        id: id.to_string(),
                        name: name.trim().chars().take(64).collect(),
                        rssi: properties.rssi,
                    },
                    peripheral,
                ));
            }
        }
        devices.sort_by(|(left, _), (right, _)| {
            right
                .rssi
                .cmp(&left.rssi)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(devices)
    })
    .await
}

async fn connect(
    device: Device,
    peripheral: Peripheral,
    lifetime: &mut watch::Receiver<()>,
) -> Result<Connection, String> {
    let setup = during(lifetime, 18, async {
        peripheral.connect().await.map_err(ble_error)?;
        peripheral.discover_services().await.map_err(ble_error)?;
        let characteristics = peripheral.characteristics();
        let incompatible = "这个设备未提供 Bumi 控制所需的蓝牙服务。";
        let tx = characteristics
            .iter()
            .find(|characteristic| {
                characteristic.service_uuid == SERVICE && characteristic.uuid == WRITE
            })
            .cloned()
            .ok_or(incompatible)?;
        let rx = characteristics
            .iter()
            .find(|characteristic| {
                characteristic.service_uuid == SERVICE
                    && characteristic.uuid == NOTIFY
                    && characteristic.properties.contains(CharPropFlags::NOTIFY)
            })
            .ok_or(incompatible)?;
        let write_type = if tx.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else if tx
            .properties
            .contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
        {
            WriteType::WithoutResponse
        } else {
            return Err(incompatible.into());
        };
        peripheral.subscribe(rx).await.map_err(ble_error)?;
        Ok((tx, write_type))
    })
    .await;
    match setup {
        Ok((tx, write_type)) => Ok(Connection {
            device,
            peripheral,
            tx,
            write_type,
            last_motion_write: None,
            battery: None,
            status: None,
            moving: false,
            locomotion_mode: None,
        }),
        Err(error) => {
            disconnect(&peripheral).await;
            Err(error)
        }
    }
}

// A mode-changing write may reach the robot even if it times out. Drop the old
// selection before writing and commit the returned mode only on success.
fn prepare_locomotion_mode(
    current: &mut Option<LocomotionMode>,
    command: &Command,
) -> Result<Option<LocomotionMode>, &'static str> {
    let selected = match command {
        Command::Walk => Some(LocomotionMode::Walk),
        Command::Run => Some(LocomotionMode::Run),
        Command::Dance
        | Command::Wave
        | Command::Handshake
        | Command::Cheer
        | Command::StandUp
        | Command::StandToFall => None,
        Command::Move { vx, vyaw } if current.is_none() && (*vx != 0 || *vyaw != 0) => {
            return Err("请先进入行走模式或全身行走模式，再控制移动。");
        }
        _ => return Ok(*current),
    };
    *current = None;
    Ok(selected)
}

impl Connection {
    async fn send(
        &mut self,
        command: Command,
        lifetime: &mut watch::Receiver<()>,
        monitor: Option<&AppHandle>,
    ) -> Result<(), String> {
        if self.moving && !matches!(&command, Command::Move { .. }) {
            self.write_frame(
                &protocol::frame(Command::Move { vx: 0, vyaw: 0 })?,
                lifetime,
                monitor,
            )
            .await?;
            self.moving = false;
        }
        let selected = prepare_locomotion_mode(&mut self.locomotion_mode, &command)?;
        let frame = protocol::frame(command.clone())?;
        let is_query = matches!(command, Command::Battery | Command::Status);
        let mut notifications = if is_query {
            Some(during(lifetime, 2, self.peripheral.notifications().map(map_error)).await?)
        } else {
            None
        };
        // A cancelled write may already have reached the robot. Keep disconnect's
        // stop armed until a zero-speed write actually completes.
        if matches!(&command, Command::Move { vx, vyaw } if *vx != 0 || *vyaw != 0) {
            self.moving = true;
        }
        self.write_frame(&frame, lifetime, monitor).await?;
        self.locomotion_mode = selected;
        if matches!(&command, Command::Move { vx: 0, vyaw: 0 }) {
            self.moving = false;
        }

        if let Some(notifications) = &mut notifications {
            let response = during(lifetime, 4, async {
                while let Some(value) = notifications.next().await {
                    if value.uuid == NOTIFY {
                        if let Some(reading) = protocol::reading(&value.value)
                            .filter(|reading| reading.matches(&command))
                        {
                            return Ok(reading);
                        }
                    }
                }
                Err("Bumi 蓝牙连接已中断。".into())
            })
            .await;
            match response {
                Ok(Reading::Battery(percent)) => self.battery = Some(percent),
                Ok(Reading::Status(status)) => self.status = Some(status),
                Err(error) => {
                    return Err(if error == TIMED_OUT {
                        "已发送查询，但 Bumi 未返回数据。".into()
                    } else {
                        error
                    })
                }
            }
        }
        Ok(())
    }

    async fn write_frame(
        &mut self,
        frame: &[u8],
        lifetime: &mut watch::Receiver<()>,
        monitor: Option<&AppHandle>,
    ) -> Result<(), String> {
        for chunk in frame.chunks(20) {
            during(
                lifetime,
                3,
                self.peripheral
                    .write(&self.tx, chunk, self.write_type)
                    .map(map_error),
            )
            .await?;
            if frame.len() > 20 && matches!(self.write_type, WriteType::WithoutResponse) {
                sleep(Duration::from_millis(15)).await;
            }
        }
        if let Some(app) = monitor {
            let mut description = protocol::describe_write(frame);
            if let [_, _, _, 0x13, vx, yaw, vy, _] = frame {
                let now = Instant::now();
                if let Some(previous) = self.last_motion_write {
                    description.summary.push_str(&format!(
                        " · 间隔 {} ms",
                        now.duration_since(previous).as_millis()
                    ));
                }
                self.last_motion_write = (*vx != 0 || *yaw != 0 || *vy != 0).then_some(now);
            }
            emit_frame(app, "tx", frame, description);
        }
        Ok(())
    }
}

async fn disconnect(peripheral: &Peripheral) {
    if !matches!(
        timeout(Duration::from_secs(3), peripheral.disconnect()).await,
        Ok(Ok(()))
    ) {
        eprintln!("Bumi: Bluetooth disconnect did not complete");
    }
}

const TIMED_OUT: &str = "蓝牙操作超时，请检查机器人和系统蓝牙状态。";

async fn during<T>(
    lifetime: &mut watch::Receiver<()>,
    seconds: u64,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = lifetime.changed() => Err(CLOSED.into()),
        result = timeout(Duration::from_secs(seconds), work) => result.map_err(|_| TIMED_OUT.to_owned())?,
    }
}

fn map_error<T>(result: btleplug::Result<T>) -> Result<T, String> {
    result.map_err(ble_error)
}

fn ble_error(error: btleplug::Error) -> String {
    if matches!(error, btleplug::Error::PermissionDenied) || permission_denied() {
        PERMISSION.into()
    } else {
        format!("蓝牙操作失败（{error}）")
    }
}

fn permission_denied() -> bool {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn keepwork_voice_bluetooth_denied() -> bool;
        }
        // The desktop already links this CoreBluetooth authorization check.
        unsafe { keepwork_voice_bluetooth_denied() }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(test)]
mod tests {
    use super::{prepare_locomotion_mode, supported_name, Command, LocomotionMode};

    #[test]
    fn movement_requires_a_successfully_written_gait_and_stop_is_always_available() {
        let mut mode = None;
        let forward = Command::Move { vx: 40, vyaw: 0 };
        let stop = Command::Move { vx: 0, vyaw: 0 };
        assert!(prepare_locomotion_mode(&mut mode, &forward).is_err());
        assert_eq!(prepare_locomotion_mode(&mut mode, &stop), Ok(None));

        for (command, gait) in [
            (Command::Walk, LocomotionMode::Walk),
            (Command::Run, LocomotionMode::Run),
            (Command::Walk, LocomotionMode::Walk),
        ] {
            let selected = prepare_locomotion_mode(&mut mode, &command).unwrap();
            assert_eq!(mode, None);
            assert!(prepare_locomotion_mode(&mut mode, &forward).is_err());
            mode = selected;
            assert_eq!(mode, Some(gait));
            for command in [&forward, &stop, &Command::Status] {
                assert_eq!(prepare_locomotion_mode(&mut mode, command), Ok(Some(gait)));
                assert_eq!(mode, Some(gait));
            }
        }
        for action in [
            Command::Dance,
            Command::Wave,
            Command::Handshake,
            Command::Cheer,
            Command::StandUp,
            Command::StandToFall,
        ] {
            mode = Some(LocomotionMode::Run);
            assert_eq!(prepare_locomotion_mode(&mut mode, &action), Ok(None));
            assert_eq!(mode, None);
            assert!(prepare_locomotion_mode(&mut mode, &forward).is_err());
        }
    }

    #[test]
    fn discovers_bumi_product_and_firmware_names_only() {
        for name in [
            "Bumi_Pro",
            "my-bumi-robot",
            "NTXB12CBM2656CB01A0039",
            "ntxb01",
        ] {
            assert!(supported_name(name), "{name}");
        }
        for name in ["NTXA12", "H260116000200429", "Boomy_Pro", ""] {
            assert!(!supported_name(name), "{name}");
        }
    }
}
