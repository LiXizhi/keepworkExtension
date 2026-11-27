use super::protocol::{self, Reading, TeachListAssembler, NOTIFY, SERVICE, WRITE};
use super::{Command, Device, LocomotionMode, Request, Snapshot, TeachAction};
use btleplug::api::{
    Central, CentralEvent, CentralState, CharPropFlags, Characteristic, Manager as _,
    Peripheral as _, ScanFilter, ValueNotification, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures_util::{future::Shared, FutureExt, Stream, StreamExt};
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
    devices: Vec<(Device, Peripheral, Adapter)>,
    connection: Option<Connection>,
    listener: Option<Listener>,
}

struct Listener {
    _stop: watch::Sender<()>,
    active: Arc<AtomicBool>,
}

struct Connection {
    device: Device,
    id: String,
    attempt_id: Option<String>,
    link_lost: Arc<AtomicBool>,
    cancel_link_monitor: watch::Sender<()>,
    peripheral: Peripheral,
    tx: Characteristic,
    write_type: WriteType,
    last_motion_write: Option<Instant>,
    battery: Option<u8>,
    status: Option<i8>,
    moving: bool,
    motion_owner: Option<u64>,
    locomotion_mode: Option<LocomotionMode>,
    gait_confirmed: bool,
    voice_posture_owner: Option<watch::Receiver<bool>>,
    teach_recording: bool,
    teach_actions: Vec<TeachAction>,
    teach_saved_at: Option<Instant>,
}

impl Bluetooth {
    pub(super) async fn request(
        &mut self,
        app: &AppHandle,
        request: Request,
        owner: watch::Receiver<()>,
        mut lifetime: watch::Receiver<()>,
        voice_session: Option<watch::Receiver<bool>>,
        verify_remote: impl Fn() -> Result<(), String>,
    ) -> Result<Snapshot, String> {
        if owner.has_changed().is_err() || lifetime.has_changed().is_err() {
            return Err(CLOSED.into());
        }
        if !self.owned_by(&owner) {
            self.reset().await;
            self.owner = Some(owner);
        }
        if let Some(connection) = &self.connection {
            // A stop must not wait for a separate peripheral status query. The
            // GATT write reports its own failure if the link was just lost.
            let stopping = matches!(
                &request,
                Request::Disconnect | Request::CancelConnection { .. }
            ) || matches!(&request, Request::Send { command, .. } if command.motion_active() == Some(false));
            let lost = connection.link_lost.load(Ordering::Acquire)
                || (!stopping
                    && !during(
                        &mut lifetime,
                        2,
                        connection.peripheral.is_connected().map(map_error),
                    )
                    .await?);
            if lost || connection.link_lost.load(Ordering::Acquire) {
                report_link_loss(
                    app,
                    &connection.device.id,
                    &connection.id,
                    &connection.link_lost,
                );
                self.stop_listening();
                self.connection = None;
            }
        }

        match request {
            Request::BeginClassroom { .. }
            | Request::ClassroomStep { .. }
            | Request::ClassroomStop { .. }
            | Request::EndClassroom { .. } => return Err("课堂任务需要独立的控制会话。".into()),
            Request::Guide { .. } => return Err("导航步进需先验证当前遥控会话。".into()),
            Request::InterpretWalk(_) => return Err("行走指令由独立的识别通道解析。".into()),
            Request::LocateVision(_) => return Err("视觉定位请求已由独立通道处理。".into()),
            Request::Status => {}
            Request::Scan { .. } if self.connection.is_none() => {
                self.devices.clear();
                self.devices = scan(self.adapter(&mut lifetime).await?, &mut lifetime).await?;
            }
            Request::Connect { id, attempt_id } if self.connection.is_none() => {
                let (device, peripheral, adapter) = self
                    .devices
                    .iter()
                    .find(|(device, _, _)| device.id == id)
                    .cloned()
                    .ok_or("请从最近一次扫描结果中选择机器人。")?;
                self.connection = Some(
                    connect(app, device, peripheral, adapter, attempt_id, &mut lifetime).await?,
                );
            }
            Request::Scan { .. } | Request::Connect { .. } => {
                return Err("请先断开当前机器人。".into())
            }
            Request::CancelConnection { attempt_id } => {
                // Setup may already have completed while its IPC reply was in flight.
                if self.connection.as_ref().and_then(|c| c.attempt_id.as_ref()) == Some(&attempt_id)
                {
                    self.disconnect().await;
                }
            }
            Request::Disconnect => self.disconnect().await,
            Request::Listen { enabled } => self.set_listening(app, enabled, &mut lifetime).await?,
            Request::Send {
                command,
                remote_capture_id,
                ..
            } => {
                let monitor = self
                    .listener
                    .as_ref()
                    .filter(|listener| listener.active.load(Ordering::Relaxed))
                    .map(|_| app);
                let connection = self.connection.as_mut().ok_or(DISCONNECTED)?;
                if let Some(session) = voice_session {
                    connection
                        .send_voice_action(command, &mut lifetime, monitor, session, verify_remote)
                        .await?;
                } else {
                    if command.motion_active().is_none()
                        && !matches!(
                            command,
                            Command::Status
                                | Command::Battery
                                | Command::TeachList
                                | Command::Volume { .. }
                                | Command::Speak { .. }
                        )
                    {
                        connection.voice_posture_owner = None;
                    }
                    if command.motion_active() == Some(true) {
                        if remote_capture_id.is_some() && !connection.gait_confirmed {
                            return Err("请查询并确认机器人已进入所选步态。".into());
                        }
                    }
                    verify_remote()?;
                    connection
                        .send(command, &mut lifetime, monitor, remote_capture_id)
                        .await?;
                }
            }
        }

        Ok(self.snapshot())
    }

    pub(super) fn snapshot(&self) -> Snapshot {
        let locomotion_mode = self.connection.as_ref().and_then(|c| c.locomotion_mode);
        Snapshot {
            available: true,
            guided_motion_version: Some(1),
            remote_motion_version: Some(2),
            remote_menu_switch: Some(true),
            remote_voice_command_version: Some(1),
            remote_voice_gestures: Some(true),
            remote_voice_continue: Some(true),
            remote_voice_step_directions: Some(true),
            vision_version: Some(2),
            scene_vision_version: Some(1),
            scene_confidence_version: Some(1),
            scene_walk_path_version: Some(1),
            automatic_walk_clearance_version: Some(1),
            walk_floor_scale_version: Some(1),
            scene_inspection_version: Some(1),
            search_view_version: Some(1),
            walk_continue_version: Some(1),
            single_frame_route_version: Some(1),
            single_frame_estimated_step_version: Some(1),
            single_frame_directions_version: Some(1),
            single_frame_pulse_directions_version: Some(1),
            scene_spoken_choice: Some(true),
            classroom_pulse_version: Some(1),
            teach_version: Some(1),
            walk_intent_version: Some(1),
            walk_intent: None,
            vision_pose: None,
            connection_id: self.connection.as_ref().map(|c| c.id.clone()),
            devices: self
                .devices
                .iter()
                .map(|(device, _, _)| device.clone())
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
            teach_recording: self
                .connection
                .as_ref()
                .is_some_and(|connection| connection.teach_recording),
            teach_actions: Some(
                self.connection
                    .as_ref()
                    .map(|connection| connection.teach_actions.clone())
                    .unwrap_or_default(),
            ),
            listening: self
                .listener
                .as_ref()
                .is_some_and(|listener| listener.active.load(Ordering::Relaxed)),
        }
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

    pub(super) fn owned_by(&self, lifetime: &watch::Receiver<()>) -> bool {
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

    pub(super) async fn stop_remote_if_moving(
        &mut self,
        lifetime: &watch::Receiver<()>,
        capture_id: u64,
    ) -> Result<(), String> {
        if self.owned_by(lifetime) {
            if let Some(connection) = self
                .connection
                .as_mut()
                .filter(|c| c.motion_owner == Some(capture_id))
            {
                if connection.link_lost.load(Ordering::Acquire) {
                    return Err("机器人蓝牙已断开，停止状态未知。".into());
                }
                connection
                    .send(Command::STOP, &mut lifetime.clone(), None, None)
                    .await?;
            }
        }
        Ok(())
    }

    async fn reset(&mut self) {
        self.stop_listening();
        self.devices.clear();
        self.disconnect().await;
    }

    async fn disconnect(&mut self) {
        self.stop_listening();
        if let Some(mut connection) = self.connection.take() {
            let _ = connection.cancel_link_monitor.send(());
            if connection.link_lost.load(Ordering::Acquire) {
                return;
            }
            if connection.teach_recording {
                let (_sender, mut lifetime) = watch::channel(());
                if let Err(error) = connection
                    .send(Command::StopTeach, &mut lifetime, None, None)
                    .await
                {
                    eprintln!("Bumi: failed to stop teach recording before disconnect: {error}");
                }
            }
            if connection.moving {
                let (_sender, mut lifetime) = watch::channel(());
                if let Err(error) = connection
                    .send(Command::STOP, &mut lifetime, None, None)
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
) -> Result<Vec<(Device, Peripheral, Adapter)>, String> {
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
                    adapter.clone(),
                ));
            }
        }
        devices.sort_by(|(left, _, _), (right, _, _)| {
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
    app: &AppHandle,
    device: Device,
    peripheral: Peripheral,
    adapter: Adapter,
    attempt_id: Option<String>,
    lifetime: &mut watch::Receiver<()>,
) -> Result<Connection, String> {
    let events = during(lifetime, 2, adapter.events().map(map_error)).await?;
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
        Ok((tx, write_type)) => {
            let id = uuid::Uuid::new_v4().to_string();
            let link_lost = Arc::new(AtomicBool::new(false));
            let (cancel_link_monitor, cancelled) = watch::channel(());
            let app = app.clone();
            let peripheral_id = peripheral.id();
            let device_id = device.id.clone();
            let connection_id = id.clone();
            let lost = link_lost.clone();
            tauri::async_runtime::spawn(async move {
                if wait_for_link_loss(events, cancelled, peripheral_id).await {
                    report_link_loss(&app, &device_id, &connection_id, &lost);
                }
            });
            Ok(Connection {
                device,
                id,
                attempt_id,
                link_lost,
                cancel_link_monitor,
                peripheral,
                tx,
                write_type,
                last_motion_write: None,
                battery: None,
                status: None,
                moving: false,
                motion_owner: None,
                locomotion_mode: None,
                gait_confirmed: false,
                voice_posture_owner: None,
                teach_recording: false,
                teach_actions: Vec::new(),
                teach_saved_at: None,
            })
        }
        Err(error) => {
            disconnect(&peripheral).await;
            Err(error)
        }
    }
}

async fn wait_for_link_loss(
    mut events: impl Stream<Item = CentralEvent> + Unpin,
    mut cancelled: watch::Receiver<()>,
    device_id: PeripheralId,
) -> bool {
    loop {
        let event = tokio::select! {
            biased;
            _ = cancelled.changed() => return false,
            event = events.next() => event,
        };
        match event {
            Some(CentralEvent::DeviceDisconnected(id)) if id == device_id => return true,
            Some(CentralEvent::StateUpdate(CentralState::PoweredOff)) | None => return true,
            _ => {}
        }
    }
}

fn report_link_loss(app: &AppHandle, id: &str, connection_id: &str, lost: &AtomicBool) {
    if !lost.swap(true, Ordering::AcqRel) {
        let _ = app.emit_to(
            super::LABEL,
            "bumi:disconnected",
            serde_json::json!({ "id": id, "connectionId": connection_id }),
        );
    }
}

fn check_teach_recording(recording: bool, command: &Command) -> Result<(), &'static str> {
    if !recording {
        return Ok(());
    }
    if matches!(
        command,
        Command::StopTeach | Command::SaveTeach { .. } | Command::Battery | Command::Status
    ) || command.motion_active() == Some(false)
    {
        return Ok(());
    }
    Err("正在示教录制中，请先停止录制。")
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
        | Command::StandToFall
        | Command::StartTeach
        | Command::StopTeach
        | Command::SaveTeach { .. }
        | Command::PlayTeach { .. } => None,
        _ if current.is_none() && command.motion_active() == Some(true) => {
            return Err("请先进入行走模式或全身行走模式，再控制移动。");
        }
        _ => return Ok(*current),
    };
    *current = None;
    Ok(selected)
}

fn needs_voice_status(
    moving: bool,
    confirmed: bool,
    previous: Option<&watch::Receiver<bool>>,
    session: &watch::Receiver<bool>,
) -> Result<bool, &'static str> {
    if moving {
        return Err("请等机器人停止移动后再说指令。");
    }
    if confirmed {
        return Ok(false);
    }
    if previous.is_some_and(|capture| capture.same_channel(session)) {
        return Ok(true);
    }
    Err("请先确认 Bumi 已进入所选步态，再开启遥控。")
}

fn ensure_ready_for_voice(status: Option<i8>) -> Result<(), String> {
    match status {
        Some(1..=3) => Ok(()),
        Some(code) => Err(format!(
            "机器人当前状态码为 {code}。请等机器人站稳并进入准备或行走状态后再说指令。"
        )),
        None => Err("未能确认机器人当前状态，请稍后再说指令。".into()),
    }
}

fn confirm_voice_gait(
    mode: &mut Option<LocomotionMode>,
    confirmed: &mut bool,
    status_result: Result<(), String>,
) -> Result<(), String> {
    let result = status_result.and_then(|_| {
        if *confirmed {
            Ok(())
        } else {
            Err("机器人还未确认所选步态。请等机器人站稳后重新说步态指令。".into())
        }
    });
    if result.is_err() {
        *mode = None;
        *confirmed = false;
    }
    result
}

impl Connection {
    async fn send_voice_action(
        &mut self,
        command: Command,
        lifetime: &mut watch::Receiver<()>,
        monitor: Option<&AppHandle>,
        session: watch::Receiver<bool>,
        verify_turn: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        if needs_voice_status(
            self.moving,
            self.gait_confirmed,
            self.voice_posture_owner.as_ref(),
            &session,
        )? {
            self.send(Command::Status, lifetime, monitor, None).await?;
            ensure_ready_for_voice(self.status)?;
        }
        // A new recording, a held key or a focus change during the status query
        // invalidates the old command even when the robot itself is ready.
        verify_turn()?;
        let gait = matches!(command, Command::Walk | Command::Run);
        // A timed-out write could have reached the robot. A new turn from this
        // exact capture may check its current status without replaying the write.
        self.voice_posture_owner = Some(session);
        self.send(command, lifetime, monitor, None).await?;
        if gait {
            let status = self.send(Command::Status, lifetime, monitor, None).await;
            confirm_voice_gait(
                &mut self.locomotion_mode,
                &mut self.gait_confirmed,
                status.and_then(|()| verify_turn()),
            )?;
        }
        Ok(())
    }

    async fn send(
        &mut self,
        command: Command,
        lifetime: &mut watch::Receiver<()>,
        monitor: Option<&AppHandle>,
        remote_capture_id: Option<u64>,
    ) -> Result<(), String> {
        check_teach_recording(self.teach_recording, &command)?;
        let motion_active = command.motion_active();
        if self.moving && motion_active.is_none() {
            self.write_frame(&protocol::frame(Command::STOP)?, lifetime, monitor)
                .await?;
            self.moving = false;
            self.motion_owner = None;
        }
        let selected = prepare_locomotion_mode(&mut self.locomotion_mode, &command)?;
        // Keep the last reported status visible in the UI. A new gait write
        // (even the same gait) or an inconclusive status query needs fresh
        // confirmation before the remote may move again.
        if self.locomotion_mode.is_none() || matches!(command, Command::Status) {
            self.gait_confirmed = false;
        }
        // Bumi persists the recording asynchronously. Give it the documented
        // two seconds before requesting the library, including on older UIs.
        if matches!(command, Command::TeachList) {
            if let Some(saved_at) = self.teach_saved_at {
                let wait = Duration::from_secs(2).saturating_sub(saved_at.elapsed());
                if !wait.is_zero() {
                    during(lifetime, 3, async {
                        sleep(wait).await;
                        Ok(())
                    })
                    .await?;
                }
            }
        }
        let frame = protocol::frame(command.clone())?;
        let is_query = matches!(
            command,
            Command::Battery | Command::Status | Command::TeachList
        );
        let mut notifications = if is_query {
            Some(during(lifetime, 2, self.peripheral.notifications().map(map_error)).await?)
        } else {
            None
        };
        // A cancelled write may already have reached the robot. Keep disconnect's
        // stop armed until a zero-speed write actually completes.
        if motion_active == Some(true) {
            self.moving = true;
            self.motion_owner = remote_capture_id;
        }
        self.write_frame(&frame, lifetime, monitor).await?;
        self.locomotion_mode = selected;
        match &command {
            Command::StartTeach => self.teach_recording = true,
            Command::StopTeach => self.teach_recording = false,
            Command::SaveTeach { .. } => {
                self.teach_recording = false;
                self.teach_saved_at = Some(Instant::now());
            }
            Command::DeleteTeach { id } => self.teach_actions.retain(|item| item.id != *id),
            _ => {}
        }
        if motion_active == Some(false) {
            self.moving = false;
            self.motion_owner = None;
        }

        if let Some(notifications) = &mut notifications {
            if matches!(command, Command::TeachList) {
                self.teach_actions = query_teach_list(notifications, lifetime).await?;
            } else {
                match query_reading(notifications, &command, lifetime).await? {
                    Reading::Battery(percent) => self.battery = Some(percent),
                    Reading::Status(status) => {
                        self.status = Some(status);
                        self.gait_confirmed = matches!(
                            (self.locomotion_mode, status),
                            (Some(LocomotionMode::Walk), 2) | (Some(LocomotionMode::Run), 3)
                        );
                    }
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
            if self.link_lost.load(Ordering::Acquire) {
                return Err("Bumi 蓝牙连接已中断，请重新连接。".into());
            }
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
        if self.link_lost.load(Ordering::Acquire) {
            return Err("Bumi 蓝牙连接已中断，指令执行结果未知。".into());
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

async fn query_reading(
    mut notifications: impl Stream<Item = ValueNotification> + Unpin,
    command: &Command,
    lifetime: &mut watch::Receiver<()>,
) -> Result<Reading, String> {
    let mut received_notification = false;
    let mut invalid_battery = None;
    let result = during(lifetime, 4, async {
        while let Some(value) = notifications.next().await {
            if value.uuid != NOTIFY {
                continue;
            }
            received_notification = true;
            if let Some(reading) = protocol::reading(&value.value).filter(|r| r.matches(command)) {
                return Ok(reading);
            }
            if matches!(command, Command::Battery)
                && matches!(value.value.as_slice(), [0x55, 0xaa, _, 0x26, ..])
            {
                invalid_battery = Some(protocol::describe(&value.value).summary);
            }
        }
        Err("Bumi 蓝牙连接已中断。".into())
    })
    .await;
    match result {
        Err(error) if error == TIMED_OUT => {
            let query = if matches!(command, Command::Battery) {
                "电量"
            } else {
                "状态"
            };
            Err(if let Some(reason) = invalid_battery {
                format!("电量查询未取得有效读数：{reason}。")
            } else if received_notification {
                format!("已收到蓝牙通知，但 4 秒内未识别到有效的{query}回包。可开启监听后再查，查看收到的原始帧。")
            } else {
                format!("已发送{query}查询，4 秒内未收到 Bumi 的蓝牙通知。")
            })
        }
        other => other,
    }
}

async fn query_teach_list(
    mut notifications: impl Stream<Item = ValueNotification> + Unpin,
    lifetime: &mut watch::Receiver<()>,
) -> Result<Vec<TeachAction>, String> {
    let mut received_notification = false;
    let mut received_teach_fragment = false;
    let mut assembler = TeachListAssembler::default();
    let result = during(lifetime, 6, async {
        while let Some(value) = notifications.next().await {
            if value.uuid != NOTIFY {
                continue;
            }
            received_notification = true;
            if matches!(value.value.as_slice(), [0x55, 0xaa, _, 0x23, ..]) {
                received_teach_fragment = true;
            }
            if let Some(list) = assembler.push(&value.value, Instant::now()) {
                return list;
            }
        }
        Err("Bumi 蓝牙连接已中断。".into())
    })
    .await;
    match result {
        Err(error) if error == TIMED_OUT => Err(if received_teach_fragment {
            "已收到部分示教动作列表分片，但未在 6 秒内收齐。请重试或开启蓝牙消息监听排查。".into()
        } else if received_notification {
            "已收到蓝牙通知，但 6 秒内未收到示教动作列表回包（0x23）。可开启监听查看原始帧。".into()
        } else {
            "已发送动作库查询，6 秒内未收到 Bumi 的蓝牙通知。".into()
        }),
        other => other,
    }
}

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
    fn only_the_session_that_sent_the_posture_can_use_a_fresh_ready_status() {
        use super::{ensure_ready_for_voice, needs_voice_status};
        let (_first, first) = tokio::sync::watch::channel(false);
        let (_new, new) = tokio::sync::watch::channel(false);
        assert_eq!(needs_voice_status(false, true, None, &first), Ok(false));
        assert_eq!(
            needs_voice_status(false, false, Some(&first), &first),
            Ok(true)
        );
        assert!(needs_voice_status(true, true, Some(&first), &first).is_err());
        assert!(needs_voice_status(false, false, None, &first).is_err());
        assert!(needs_voice_status(false, false, Some(&first), &new).is_err());
        for code in [1, 2, 3] {
            assert!(ensure_ready_for_voice(Some(code)).is_ok());
        }
        for status in [None, Some(0), Some(26), Some(30), Some(99)] {
            assert!(ensure_ready_for_voice(status).is_err());
        }
    }

    #[test]
    fn unconfirmed_spoken_gait_allows_another_utterance_but_never_a_step() {
        use super::{confirm_voice_gait, needs_voice_status};
        let (_tx, session) = tokio::sync::watch::channel(false);
        for (matched, status) in [
            (false, Ok(())),
            (false, Err("读取超时".to_owned())),
            (true, Err("会话已失效".to_owned())),
        ] {
            let mut mode = Some(LocomotionMode::Run);
            let mut confirmed = matched;
            assert!(confirm_voice_gait(&mut mode, &mut confirmed, status).is_err());
            assert!(!confirmed);
            assert_eq!(mode, None);
            assert!(prepare_locomotion_mode(
                &mut mode,
                &Command::Move {
                    vx: 40,
                    vy: 0,
                    vyaw: 0
                }
            )
            .is_err());
            assert_eq!(
                needs_voice_status(false, confirmed, Some(&session), &session),
                Ok(true)
            );
        }
        let mut mode = Some(LocomotionMode::Walk);
        let mut confirmed = true;
        assert!(confirm_voice_gait(&mut mode, &mut confirmed, Ok(())).is_ok());
        assert_eq!(mode, Some(LocomotionMode::Walk));
        assert!(confirmed);
    }

    #[tokio::test(start_paused = true)]
    async fn battery_query_distinguishes_silence_other_notifications_and_invalid_readings() {
        use super::{query_reading, Reading, ValueNotification, NOTIFY, SERVICE};
        use futures_util::{stream, StreamExt};

        let status = vec![0x55, 0xaa, 6, 0x51, 2, 6];
        let invalid = vec![0x55, 0xaa, 6, 0x26, 255, 6];
        let extended = vec![0x55, 0xaa, 7, 0x26, 83, 42, 7];
        let (_owner, mut lifetime) = tokio::sync::watch::channel(());
        for (frames, expected) in [
            (vec![], Err("未收到 Bumi 的蓝牙通知")),
            (vec![status.clone()], Err("已收到蓝牙通知")),
            (vec![invalid.clone(), status.clone()], Err("255 超出")),
            (vec![status, invalid, extended], Ok(Reading::Battery(83))),
        ] {
            let notifications = stream::iter(frames.into_iter().map(|value| ValueNotification {
                uuid: NOTIFY,
                service_uuid: SERVICE,
                value,
            }))
            .chain(stream::pending());
            let result = query_reading(notifications, &Command::Battery, &mut lifetime).await;
            match expected {
                Ok(reading) => assert_eq!(result, Ok(reading)),
                Err(message) => assert!(result.unwrap_err().contains(message)),
            }
        }
    }

    #[tokio::test]
    async fn cancel_interrupts_a_pending_bluetooth_operation() {
        use super::super::ConnectionAttempts;
        use futures_util::FutureExt;

        let mut attempts = ConnectionAttempts::default();
        let mut lifetime = attempts.start("scanning").unwrap();
        let work = super::during(
            &mut lifetime,
            20,
            std::future::pending::<Result<(), String>>(),
        );
        tokio::pin!(work);
        assert!(work.as_mut().now_or_never().is_none());
        attempts.cancel("scanning");
        assert!(work.await.is_err());
    }

    #[tokio::test]
    async fn disconnect_latches_for_the_selected_robot_even_if_it_reconnects() {
        use super::{wait_for_link_loss, CentralEvent, PeripheralId};
        use futures_util::{stream, FutureExt, StreamExt};
        #[cfg(target_os = "macos")]
        fn id(value: u8) -> PeripheralId {
            uuid::Uuid::from_bytes([value; 16]).into()
        }
        #[cfg(windows)]
        fn id(value: u8) -> PeripheralId {
            btleplug::api::BDAddr::from([value; 6]).into()
        }
        let selected = id(1);
        let (cancel, rx) = tokio::sync::watch::channel(());
        let other =
            stream::iter([CentralEvent::DeviceDisconnected(id(2))]).chain(stream::pending());
        assert!(wait_for_link_loss(other, rx.clone(), selected.clone())
            .now_or_never()
            .is_none());
        let reconnected = [
            CentralEvent::DeviceDisconnected(selected.clone()),
            CentralEvent::DeviceConnected(selected.clone()),
        ];
        let same_robot = stream::iter(reconnected).chain(stream::pending());
        assert_eq!(
            wait_for_link_loss(same_robot, rx.clone(), selected.clone()).now_or_never(),
            Some(true)
        );
        assert!(wait_for_link_loss(stream::empty(), rx.clone(), selected.clone()).await);
        drop(cancel);
        assert!(!wait_for_link_loss(stream::empty(), rx, selected).await);
    }

    #[test]
    fn movement_requires_a_successfully_written_gait_and_stop_is_always_available() {
        let mut mode = None;
        let forward = Command::Move {
            vx: 40,
            vyaw: 0,
            vy: 0,
        };
        let left = Command::Move {
            vx: 0,
            vyaw: 0,
            vy: 40,
        };
        let right = Command::Move {
            vx: 0,
            vyaw: 0,
            vy: -40,
        };
        let stop = Command::STOP;
        assert!(prepare_locomotion_mode(&mut mode, &forward).is_err());
        assert!(prepare_locomotion_mode(&mut mode, &left).is_err());
        assert!(prepare_locomotion_mode(&mut mode, &right).is_err());
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
            for command in [&forward, &left, &right, &stop, &Command::Status] {
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
            Command::StartTeach,
            Command::StopTeach,
            Command::SaveTeach {
                name: "挥臂".into(),
            },
            Command::PlayTeach { id: 1 },
        ] {
            mode = Some(LocomotionMode::Run);
            assert_eq!(prepare_locomotion_mode(&mut mode, &action), Ok(None));
            assert_eq!(mode, None);
            assert!(prepare_locomotion_mode(&mut mode, &forward).is_err());
        }
        mode = Some(LocomotionMode::Walk);
        assert_eq!(
            prepare_locomotion_mode(&mut mode, &Command::TeachList),
            Ok(Some(LocomotionMode::Walk))
        );
        assert_eq!(
            prepare_locomotion_mode(&mut mode, &Command::DeleteTeach { id: 1 }),
            Ok(Some(LocomotionMode::Walk))
        );
    }

    #[test]
    fn teach_recording_blocks_motion_and_actions_until_stopped() {
        use super::check_teach_recording;

        assert!(check_teach_recording(true, &Command::StopTeach).is_ok());
        assert!(check_teach_recording(
            true,
            &Command::SaveTeach {
                name: "摆臂".into(),
            }
        )
        .is_ok());
        assert!(check_teach_recording(true, &Command::STOP).is_ok());
        assert!(check_teach_recording(true, &Command::Battery).is_ok());
        for blocked in [
            Command::Walk,
            Command::Run,
            Command::Wave,
            Command::StartTeach,
            Command::TeachList,
            Command::PlayTeach { id: 1 },
            Command::DeleteTeach { id: 1 },
            Command::Move {
                vx: 40,
                vyaw: 0,
                vy: 0,
            },
        ] {
            assert!(check_teach_recording(true, &blocked).is_err());
            assert!(check_teach_recording(false, &blocked).is_ok());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn teach_list_query_reassembles_fragments_and_reports_timeouts() {
        use super::{query_teach_list, TeachAction, ValueNotification, NOTIFY, SERVICE};
        use futures_util::{stream, StreamExt};

        fn frame(index: u8, total: u8, chunk: &[u8]) -> ValueNotification {
            let len = (chunk.len() + 7) as u8;
            let mut value = vec![0x55, 0xaa, len, 0x23, index, total];
            value.extend_from_slice(chunk);
            value.push(len);
            ValueNotification {
                uuid: NOTIFY,
                service_uuid: SERVICE,
                value,
            }
        }

        let payload = r#"{"cmd":"teach_list","data":{"1":{"teach_id":1,"teach_name":"招手","teach_duration":6}}}"#.as_bytes();
        let split = payload.len() / 2;
        let (_owner, mut lifetime) = tokio::sync::watch::channel(());
        let good = stream::iter([
            ValueNotification {
                uuid: NOTIFY,
                service_uuid: SERVICE,
                value: vec![0x55, 0xaa, 6, 0x51, 1, 6],
            },
            frame(0, 2, &payload[..split]),
            frame(1, 2, &payload[split..]),
        ])
        .chain(stream::pending());
        assert_eq!(
            query_teach_list(good, &mut lifetime).await.unwrap(),
            vec![TeachAction {
                id: 1,
                name: "招手".into(),
                duration: Some(6),
                time: None,
            }]
        );

        let partial = stream::iter([frame(0, 2, &payload[..split])]).chain(stream::pending());
        assert!(query_teach_list(partial, &mut lifetime)
            .await
            .unwrap_err()
            .contains("部分示教动作列表分片"));

        let silent = stream::pending::<ValueNotification>();
        assert!(query_teach_list(silent, &mut lifetime)
            .await
            .unwrap_err()
            .contains("未收到 Bumi 的蓝牙通知"));
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
