use super::{trusted_page, Control};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{future::join_all, stream, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{ipc::Channel, WebviewWindow};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, UdpSocket},
    sync::watch,
    time::{timeout, timeout_at, Instant},
};
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    WebSocketStream,
};

mod network;
#[cfg(test)]
mod tests;
use network::{usable_address, Interface};
mod wifi;

const HTTP_PORT: u16 = 8080;
const DISCOVERY_PORT: u16 = 8081;
const SWEEP_PARALLEL: usize = 128;
const MAX_DEVICES: usize = 32;
const MAX_JPEG: usize = 1_500_000;
const BOX_HOTSPOT: Ipv4Addr = Ipv4Addr::new(192, 168, 5, 1);
const CANCELLED: &str = "已取消盒子连接操作。";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct Device {
    ip: Ipv4Addr,
    port: u16,
    id: Option<String>,
    name: Option<String>,
    firmware: Option<String>,
    /// True when `/api/info` says this box can serve a camera stream.
    #[serde(default)]
    camera: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct Remembered {
    ip: Ipv4Addr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default)]
    requires_key: bool,
}

fn history_path() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("box_link").join("last.json"))
}

fn last_device() -> Option<Remembered> {
    let mut data = Vec::new();
    std::fs::File::open(history_path()?)
        .ok()?
        .take(4096)
        .read_to_end(&mut data)
        .ok()?;
    let last: Remembered = serde_json::from_slice(&data).ok()?;
    usable_address(last.ip).then_some(last)
}

#[derive(Default)]
pub(super) struct Link {
    operation: Option<watch::Sender<()>>,
    connected: Option<Device>,
    /// Pairing key for this connection. It stays in memory so the camera
    /// request can send `X-Box-Key`, and reset clears it with the link.
    key: String,
    camera_stream: Option<watch::Sender<()>>,
    disconnect_reason: Option<&'static str>,
}

impl Link {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    fn begin(&mut self) -> Result<watch::Receiver<()>, String> {
        if self.operation.is_some() {
            return Err("盒子连接操作正在进行。".into());
        }
        let (operation, cancelled) = watch::channel(());
        self.operation = Some(operation);
        self.disconnect_reason = None;
        Ok(cancelled)
    }

    fn owns(&self, cancelled: &watch::Receiver<()>) -> bool {
        self.operation
            .as_ref()
            .is_some_and(|operation| operation.subscribe().same_channel(cancelled))
    }

    fn stop_camera(&mut self) {
        self.camera_stream = None;
    }

    fn begin_camera(&mut self) -> Result<(Ipv4Addr, String, watch::Receiver<()>), String> {
        let device = self.connected.as_ref().ok_or("请先连接视频语音盒子。")?;
        if !device.camera {
            return Err("这个盒子的摄像头还不可用。".into());
        }
        self.camera_stream = None;
        let (stream, cancelled) = watch::channel(());
        self.camera_stream = Some(stream);
        Ok((device.ip, self.key.clone(), cancelled))
    }

    fn owns_camera(&self, cancelled: &watch::Receiver<()>) -> bool {
        self.camera_stream
            .as_ref()
            .is_some_and(|stream| stream.subscribe().same_channel(cancelled))
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(in crate::app) enum Request {
    Status,
    Scan,
    ScanWifi,
    Connect {
        #[serde(default)]
        ip: Option<Ipv4Addr>,
        #[serde(default)]
        key: String,
        expected_id: Option<String>,
        // Search this computer's networks when no address is given or no box answers there.
        #[serde(default)]
        lan: bool,
    },
    Disconnect,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(in crate::app) enum Reply {
    #[serde(rename_all = "camelCase")]
    Status {
        last: Option<Remembered>,
        connected: Option<Device>,
        disconnect_reason: Option<&'static str>,
    },
    Devices(Vec<Device>),
    Networks(Vec<wifi::Network>),
    Connected(Device),
    Disconnected,
}

#[tauri::command]
pub(in crate::app) async fn bumi_box_link(
    window: WebviewWindow,
    control: tauri::State<'_, Arc<Control>>,
    request: Request,
) -> Result<Reply, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口连接视频语音盒子。".into());
    }
    let mut cancelled = {
        let owner = control.window.lock().unwrap();
        if owner.is_none() {
            return Err("Bumi 控制窗口已关闭。".into());
        }
        let mut link = control.box_link.lock().unwrap();
        match request {
            Request::Status => {
                return Ok(Reply::Status {
                    last: last_device(),
                    connected: link.connected.clone(),
                    disconnect_reason: link.disconnect_reason,
                })
            }
            Request::Disconnect => {
                link.reset();
                return Ok(Reply::Disconnected);
            }
            _ => link.begin()?,
        }
    };

    let result = match request {
        Request::Scan => tokio::select! {
            _ = cancelled.changed() => Err(CANCELLED.into()),
            devices = discover(last_device().map(|device| device.ip)) => devices.map(Reply::Devices),
        },
        Request::ScanWifi => {
            struct StopOnDrop(Arc<AtomicBool>);
            impl Drop for StopOnDrop {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
            let stop = StopOnDrop(Arc::new(AtomicBool::new(false)));
            let worker_stop = Arc::clone(&stop.0);
            let scanning = tauri::async_runtime::spawn_blocking(move || wifi::scan(&worker_stop));
            tokio::select! {
                _ = cancelled.changed() => {
                    stop.0.store(true, Ordering::Relaxed);
                    Err(CANCELLED.into())
                }
                found = scanning => found
                    .map_err(|_| "Wi-Fi 热点扫描失败，请重试。".to_string())?
                    .map(Reply::Networks),
            }
        }
        Request::Connect {
            ip,
            key,
            expected_id,
            lan,
        } => {
            let result = tokio::select! {
                _ = cancelled.changed() => Err(CANCELLED.into()),
                result = dial(ip, &key, expected_id.as_deref(), lan) => result,
            };
            match result {
                Ok(Dial::Linked(device, socket)) => {
                    let mut link = control.box_link.lock().unwrap();
                    if !link.owns(&cancelled) {
                        return Err(CANCELLED.into());
                    }
                    let last = Remembered {
                        ip: device.ip,
                        id: device.id.clone(),
                        requires_key: !key.is_empty(),
                    };
                    if let Some(path) = history_path() {
                        let _ = crate::files::atomic_json_write(&path, &last);
                    }
                    link.connected = Some(device.clone());
                    link.key = key.to_string();
                    tauri::async_runtime::spawn(monitor(
                        Arc::clone(control.inner()),
                        socket,
                        cancelled,
                    ));
                    return Ok(Reply::Connected(device));
                }
                // Several boxes are on the network and the user has to choose one.
                Ok(Dial::Choices(devices)) => Ok(Reply::Devices(devices)),
                Err(error) => Err(error),
            }
        }
        _ => unreachable!(),
    };
    let mut link = control.box_link.lock().unwrap();
    if link.owns(&cancelled) {
        link.operation = None;
        result
    } else {
        Err(CANCELLED.into())
    }
}

fn interfaces() -> BTreeSet<Interface> {
    network::interfaces().into_iter().collect()
}

async fn discover(known: Option<Ipv4Addr>) -> Result<Vec<Device>, String> {
    discover_in(&interfaces(), network::arp_addresses().await, known).await
}

async fn discover_in(
    interfaces: &BTreeSet<Interface>,
    peers: Vec<Ipv4Addr>,
    known: Option<Ipv4Addr>,
) -> Result<Vec<Device>, String> {
    let known = known.filter(|ip| reachable(*ip, interfaces));
    if interfaces.is_empty() && known.is_none() {
        return Err("未检测到可用的 IPv4 网络。请加入路由器或热点后重试。".into());
    }
    let mut beacons = Vec::new();
    for &interface in interfaces {
        let mut targets: BTreeSet<_> = peers
            .iter()
            .copied()
            .filter(|ip| interface.peer(*ip))
            .take(128)
            .collect();
        targets.extend(interface.broadcast());
        targets.insert(Ipv4Addr::BROADCAST);
        targets.extend(known);
        targets.extend(interface.peer(BOX_HOTSPOT).then_some(BOX_HOTSPOT));
        beacons.push(probe(interface, targets, known));
    }
    // The sweep reaches a box that sends no beacon and runs alongside the beacon window,
    // so a network is covered in about three seconds either way.
    let (heard, swept) = tokio::join!(join_all(beacons), sweep(interfaces, known));
    Ok(assemble(heard.into_iter().flatten().collect(), swept?))
}

// A box heard on UDP and read over HTTP is one device: the page knows firmware and
// camera facts, the beacon knows the id that survives a change of network.
fn assemble(heard: Vec<Device>, swept: Vec<Device>) -> Vec<Device> {
    let mut by_address: BTreeMap<Ipv4Addr, Device> = heard
        .into_iter()
        .map(|device| (device.ip, device))
        .collect();
    for read in swept {
        by_address
            .entry(read.ip)
            .and_modify(|heard| *heard = merge(heard.clone(), read.clone()))
            .or_insert(read);
    }
    let mut devices: BTreeMap<String, Device> = BTreeMap::new();
    for device in by_address.into_values() {
        let key = device.id.clone().unwrap_or_else(|| device.ip.to_string());
        devices.entry(key).or_insert(device);
    }
    devices.into_values().take(MAX_DEVICES).collect()
}

fn merge(heard: Device, read: Device) -> Device {
    Device {
        id: read.id.clone().or(heard.id),
        name: read.name.clone().or(heard.name),
        firmware: read.firmware.clone().or(heard.firmware),
        camera: read.camera || heard.camera,
        ..read
    }
}

// Asks every address of these networks which of them is a box.
async fn sweep(
    interfaces: &BTreeSet<Interface>,
    known: Option<Ipv4Addr>,
) -> Result<Vec<Device>, String> {
    let mut candidates = BTreeSet::new();
    for interface in interfaces {
        candidates.extend(interface.scan_addresses());
    }
    candidates.retain(|ip| !interfaces.iter().any(|interface| interface.ip == *ip));
    let mut preferred: BTreeSet<_> = known.into_iter().collect();
    if interfaces
        .iter()
        .any(|interface| interface.peer(BOX_HOTSPOT))
    {
        preferred.insert(BOX_HOTSPOT);
    }
    candidates.retain(|ip| !preferred.contains(ip));
    let client = info_client(Duration::from_millis(250))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut probes = stream::iter(
        preferred
            .into_iter()
            .chain(candidates)
            .map(|ip| identify(&client, ip, "", Duration::from_millis(1200))),
    )
    .buffer_unordered(SWEEP_PARALLEL);
    let mut devices = Vec::new();
    while let Ok(Some(result)) = timeout_at(deadline, probes.next()).await {
        if let Ok(device) = result {
            devices.push(device);
            if devices.len() == MAX_DEVICES {
                break;
            }
        }
    }
    Ok(devices)
}

async fn probe(
    interface: Interface,
    targets: BTreeSet<Ipv4Addr>,
    known: Option<Ipv4Addr>,
) -> Vec<Device> {
    let socket = match UdpSocket::bind((interface.ip, DISCOVERY_PORT)).await {
        Ok(socket) => socket,
        Err(_) => match UdpSocket::bind((interface.ip, 0)).await {
            Ok(socket) => socket,
            Err(_) => return Vec::new(),
        },
    };
    if socket.set_broadcast(true).is_err() {
        return Vec::new();
    }
    // Unix may deliver subnet broadcasts only to a socket bound to that broadcast address.
    #[cfg(unix)]
    let broadcast = match interface.broadcast() {
        Some(ip) => UdpSocket::bind((ip, DISCOVERY_PORT)).await.ok(),
        None => None,
    };
    #[cfg(not(unix))]
    let broadcast: Option<UdpSocket> = None;

    for target in targets {
        let _ = socket
            .send_to(br#"{"t":"box?"}"#, (target, DISCOVERY_PORT))
            .await;
    }
    let deadline = Instant::now() + Duration::from_millis(2500);
    let (active, passive, ()) = tokio::join!(
        receive_beacons(&socket, interface, known, deadline),
        async {
            match broadcast {
                Some(socket) => receive_beacons(&socket, interface, known, deadline).await,
                None => Vec::new(),
            }
        },
        repeat(&socket, interface, known, deadline),
    );
    active.into_iter().chain(passive).collect()
}

// A broadcast is easy to miss on Wi-Fi, so it goes out again during the listen window.
async fn repeat(
    socket: &UdpSocket,
    interface: Interface,
    known: Option<Ipv4Addr>,
    deadline: Instant,
) {
    let mut again: Vec<Ipv4Addr> = interface
        .broadcast()
        .into_iter()
        .chain([Ipv4Addr::BROADCAST])
        .collect();
    again.extend(known);
    for _ in 0..3 {
        let until = std::cmp::min(deadline, Instant::now() + Duration::from_millis(600));
        tokio::time::sleep_until(until).await;
        if deadline <= Instant::now() {
            break;
        }
        for target in &again {
            let _ = socket
                .send_to(br#"{"t":"box?"}"#, (*target, DISCOVERY_PORT))
                .await;
        }
    }
}

async fn receive_beacons(
    socket: &UdpSocket,
    interface: Interface,
    known: Option<Ipv4Addr>,
    deadline: Instant,
) -> Vec<Device> {
    let mut found = BTreeMap::new();
    let mut buffer = [0; 2049];
    while let Ok(Ok((size, from))) = timeout_at(deadline, socket.recv_from(&mut buffer)).await {
        if let Some(device) = parse_beacon(&buffer[..size], from, interface, known) {
            let key = device.id.clone().unwrap_or_else(|| device.ip.to_string());
            found.entry(key).or_insert(device);
            if found.len() == MAX_DEVICES {
                break;
            }
        }
    }
    found.into_values().collect()
}

fn parse_beacon(
    bytes: &[u8],
    from: SocketAddr,
    interface: Interface,
    known: Option<Ipv4Addr>,
) -> Option<Device> {
    #[derive(Deserialize)]
    struct Beacon {
        t: String,
        ip: Ipv4Addr,
        port: u16,
        id: Option<String>,
        name: Option<String>,
        fw: Option<String>,
    }
    if bytes.len() > 2048 {
        return None;
    }
    let beacon: Beacon = serde_json::from_slice(bytes).ok()?;
    if beacon.t != "beacon"
        || beacon.port != HTTP_PORT
        || from.ip() != beacon.ip
        || (known != Some(beacon.ip) && !interface.peer(beacon.ip))
    {
        return None;
    }
    Some(Device {
        ip: beacon.ip,
        port: beacon.port,
        id: beacon.id,
        name: beacon.name,
        firmware: beacon.fw,
        camera: false,
    })
}

fn reachable(ip: Ipv4Addr, interfaces: &BTreeSet<Interface>) -> bool {
    usable_address(ip)
        && !interfaces
            .iter()
            .any(|interface| interface.ip == ip || interface.broadcast() == Some(ip))
        && (ip.is_private() || interfaces.iter().any(|interface| interface.peer(ip)))
}

fn info_client(connect_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_timeout)
        .build()
        .map_err(|_| "无法初始化盒子网络连接。".into())
}

// `absent` marks an address no box answers at, so a LAN search may move past it.
#[derive(Debug)]
struct Failure {
    message: String,
    absent: bool,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            absent: false,
        }
    }

    fn absent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            absent: true,
        }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

async fn identify(
    client: &reqwest::Client,
    ip: Ipv4Addr,
    key: &str,
    deadline: Duration,
) -> Result<Device, Failure> {
    read_info(
        client,
        &format!("http://{ip}:{HTTP_PORT}/api/info"),
        ip,
        key,
        deadline,
    )
    .await
}

async fn read_info(
    client: &reqwest::Client,
    url: &str,
    ip: Ipv4Addr,
    key: &str,
    deadline: Duration,
) -> Result<Device, Failure> {
    let mut request = client.get(url).timeout(deadline);
    if !key.is_empty() {
        request = request.header("X-Box-Key", key);
    }
    let mut response = request.send().await.map_err(|_| {
        Failure::absent(format!("无法访问盒子 {ip}:{HTTP_PORT}。请检查网络和地址。"))
    })?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(Failure::new("盒子需要正确的配对码。")),
        status => {
            return Err(Failure::absent(format!(
                "盒子的设备信息接口返回 HTTP {status}。"
            )))
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::new("无法读取盒子的设备信息。"))?
    {
        if body.len() + chunk.len() > 8192 {
            return Err(Failure::new("盒子的设备信息超出大小限制。"));
        }
        body.extend_from_slice(&chunk);
    }
    parse_info(ip, &body).ok_or_else(|| Failure::absent("该地址没有返回有效的 Box Link 设备信息。"))
}

fn parse_info(ip: Ipv4Addr, bytes: &[u8]) -> Option<Device> {
    #[derive(Deserialize)]
    struct Info {
        id: Option<String>,
        name: String,
        fw: String,
        caps: Vec<String>,
        #[serde(default)]
        camera: Option<bool>,
    }
    let info: Info = serde_json::from_slice(bytes).ok()?;
    if info.name.trim().is_empty() || info.fw.trim().is_empty() || info.caps.is_empty() {
        return None;
    }
    let camera = info
        .camera
        .unwrap_or_else(|| info.caps.iter().any(|cap| cap == "mjpeg"));
    Some(Device {
        ip,
        port: HTTP_PORT,
        id: info.id,
        name: Some(info.name),
        firmware: Some(info.fw),
        camera,
    })
}

async fn connect(
    ip: Ipv4Addr,
    key: &str,
    expected_id: Option<&str>,
) -> Result<(Device, WebSocketStream<TcpStream>), Failure> {
    if !reachable(ip, &interfaces()) {
        return Err(Failure::new("请输入盒子所在局域网的 IPv4 地址。"));
    }
    if key.len() > 256 || !key.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err(Failure::new("配对码无效。"));
    }
    let client = info_client(Duration::from_secs(2))?;
    let mut device = identify(&client, ip, key, Duration::from_secs(3)).await?;
    // Some firmware keeps the id out of `/api/info`; a beacon's id then names the box,
    // which is what finds it again after it moves to another network.
    if device.id.is_none() {
        device.id = expected_id.map(str::to_owned);
    }
    if let (Some(expected), Some(actual)) = (expected_id, device.id.as_deref()) {
        if actual != expected {
            return Err(Failure::new("此地址上的设备已变更，请重新扫描或手动连接。"));
        }
    }
    let tcp = timeout(Duration::from_secs(2), TcpStream::connect((ip, HTTP_PORT)))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| Failure::new("盒子的 WebSocket 连接失败。"))?;
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(10))
        .with_interval(Duration::from_secs(3));
    let _ = socket2::SockRef::from(&tcp).set_tcp_keepalive(&keepalive);
    let config = WebSocketConfig {
        max_message_size: Some(64 * 1024),
        max_frame_size: Some(64 * 1024),
        ..Default::default()
    };
    let (mut socket, _) = timeout(
        Duration::from_secs(3),
        client_async_with_config(format!("ws://{ip}:{HTTP_PORT}/ws"), tcp, Some(config)),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .ok_or_else(|| Failure::new("盒子的 WebSocket 握手失败。"))?;
    timeout(Duration::from_secs(3), hello(&mut socket, key))
        .await
        .map_err(|_| Failure::new("盒子未确认连接。请确认固件和网络状态。"))??;
    Ok((device, socket))
}

enum Dial {
    Linked(Device, WebSocketStream<TcpStream>),
    Choices(Vec<Device>),
}

// Connects to `target`. With `lan`, an address no box answers at, or no address at
// all, moves the search to this computer's networks, which is where a box on a
// router lives.
async fn dial(
    target: Option<Ipv4Addr>,
    key: &str,
    expected_id: Option<&str>,
    lan: bool,
) -> Result<Dial, String> {
    let Some(ip) = target else {
        return if lan {
            search(None, key, expected_id).await
        } else {
            Err("请输入盒子的 IPv4 地址。".into())
        };
    };
    let interfaces = interfaces();
    // An address on none of this computer's networks can only answer through a router;
    // when nothing answers there it costs its whole timeout, so the search starts alongside.
    let routed =
        reachable(ip, &interfaces) && !interfaces.iter().any(|interface| interface.peer(ip));
    if !lan || !routed {
        return match connect(ip, key, expected_id).await {
            Err(failure) if lan && failure.absent => search(Some(ip), key, expected_id).await,
            result => linked(result),
        };
    }
    let mut search = Box::pin(discover(Some(ip)));
    enum First {
        Direct(Result<(Device, WebSocketStream<TcpStream>), Failure>),
        Search(Result<Vec<Device>, String>),
    }
    let first = tokio::select! {
        result = &mut search => First::Search(result),
        result = connect(ip, key, expected_id) => First::Direct(result),
    };
    match first {
        First::Direct(Ok((device, socket))) => Ok(Dial::Linked(device, socket)),
        First::Direct(Err(failure)) if failure.absent => {
            after_search(search.await?, Some(ip), key, expected_id).await
        }
        First::Direct(Err(failure)) => Err(failure.message),
        // The search ended before the attempt did, so the attempt still decides.
        First::Search(found) => match connect(ip, key, expected_id).await {
            Err(failure) if failure.absent => {
                after_search(found?, Some(ip), key, expected_id).await
            }
            result => linked(result),
        },
    }
}

async fn search(
    missed: Option<Ipv4Addr>,
    key: &str,
    expected_id: Option<&str>,
) -> Result<Dial, String> {
    let devices = discover(missed).await?;
    after_search(devices, missed, key, expected_id).await
}

async fn after_search(
    devices: Vec<Device>,
    missed: Option<Ipv4Addr>,
    key: &str,
    expected_id: Option<&str>,
) -> Result<Dial, String> {
    match pick(&devices, expected_id) {
        Picked::One(device) => {
            linked(connect(device.ip, key, device.id.as_deref().or(expected_id)).await)
        }
        Picked::Many => Ok(Dial::Choices(devices)),
        Picked::Missed => Err(no_box(missed)),
    }
}

fn linked(result: Result<(Device, WebSocketStream<TcpStream>), Failure>) -> Result<Dial, String> {
    result
        .map(|(device, socket)| Dial::Linked(device, socket))
        .map_err(|failure| failure.message)
}

enum Picked<'a> {
    One(&'a Device),
    Many,
    Missed,
}

// The remembered box wins; a single box needs no choice.
fn pick<'a>(devices: &'a [Device], expected_id: Option<&str>) -> Picked<'a> {
    if expected_id.is_some() {
        if let Some(device) = devices
            .iter()
            .find(|device| device.id.as_deref() == expected_id)
        {
            return Picked::One(device);
        }
    }
    match devices {
        [device] => Picked::One(device),
        [] => Picked::Missed,
        _ => Picked::Many,
    }
}

fn no_box(missed: Option<Ipv4Addr>) -> String {
    let scope = match missed {
        Some(ip) => format!(" {ip} 或局域网中"),
        None => "局域网中".to_owned(),
    };
    // macOS 15 asks once before an app may talk to devices on its own network.
    let access = if cfg!(target_os = "macos") {
        "，并允许 Keepwork 访问本地网络"
    } else {
        ""
    };
    format!("未在{scope}发现盒子。请确认电脑与盒子连接同一路由器{access}，或先加入盒子的 xiaozhi-box-XXXX 热点。")
}

async fn hello<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    key: &str,
) -> Result<(), String> {
    let greeting = json!({ "t": "hello", "v": 1, "key": key, "client": "keepwork-desktop" });
    socket
        .send(Message::Text(greeting.to_string()))
        .await
        .map_err(|_| "无法发送盒子连接请求。")?;
    while let Some(Ok(message)) = socket.next().await {
        if let Message::Text(text) = message {
            let Ok(reply) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match reply.get("t").and_then(Value::as_str) {
                Some("hello_ok") => return Ok(()),
                Some("err") => return Err("盒子拒绝连接，请检查配对码。".into()),
                _ => {}
            }
        }
    }
    Err("盒子在确认连接前已断开。".into())
}

async fn monitor(
    control: Arc<Control>,
    mut socket: WebSocketStream<TcpStream>,
    mut cancelled: watch::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = cancelled.changed() => {
                let _ = timeout(Duration::from_millis(300), socket.close(None)).await;
                return;
            },
            message = socket.next() => match message {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            }
        }
    }
    let mut link = control.box_link.lock().unwrap();
    if link.owns(&cancelled) {
        link.reset();
        link.disconnect_reason = Some("盒子连接已断开。请检查网络后重新连接。");
    }
}

#[derive(Clone, Serialize)]
pub(in crate::app) struct CameraMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    jpeg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended: Option<String>,
}

#[tauri::command]
pub(in crate::app) async fn bumi_box_camera(
    window: WebviewWindow,
    control: tauri::State<'_, Arc<Control>>,
    enabled: bool,
    frames: Channel<CameraMessage>,
) -> Result<(), String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口使用盒子摄像头。".into());
    }
    if !enabled {
        control.box_link.lock().unwrap().stop_camera();
        return Ok(());
    }
    let (ip, key, mut cancelled) = control.box_link.lock().unwrap().begin_camera()?;
    let opened = tokio::select! {
        _ = cancelled.changed() => Err(CANCELLED.into()),
        response = open_camera(ip, &key) => response,
    };
    let response = match opened {
        Ok(response) => response,
        Err(error) => {
            let mut link = control.box_link.lock().unwrap();
            if link.owns_camera(&cancelled) {
                link.stop_camera();
            }
            return Err(error);
        }
    };
    if !control.box_link.lock().unwrap().owns_camera(&cancelled) {
        return Err(CANCELLED.into());
    }
    tauri::async_runtime::spawn(read_camera(response, frames, cancelled));
    Ok(())
}

async fn open_camera(ip: Ipv4Addr, key: &str) -> Result<reqwest::Response, String> {
    let client = info_client(Duration::from_secs(3))?;
    let url = format!("http://{ip}:{HTTP_PORT}/api/stream.mjpg?w=640&fps=10");
    let mut request = client.get(url);
    if !key.is_empty() {
        request = request.header("X-Box-Key", key);
    }
    let response = timeout(Duration::from_secs(5), request.send())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| format!("无法打开盒子摄像头 {ip}:{HTTP_PORT}。"))?;
    match response.status().as_u16() {
        200 => Ok(response),
        401 | 403 => Err("盒子需要正确的配对码。".into()),
        status => Err(format!("盒子摄像头返回 HTTP {status}。")),
    }
}

/// Pull complete JPEG frames out of an MJPEG body. Bytes before the next SOI
/// are discarded. An unfinished frame stays in `buffer` until it is complete
/// or exceeds `max_jpeg`.
fn take_jpegs(buffer: &mut Vec<u8>, max_jpeg: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    loop {
        let Some(start) = buffer.windows(2).position(|pair| pair == [0xFF, 0xD8]) else {
            if buffer.last() == Some(&0xFF) {
                buffer.clear();
                buffer.push(0xFF);
            } else {
                buffer.clear();
            }
            break;
        };
        if start > 0 {
            buffer.drain(..start);
        }
        let Some(end_rel) = buffer[2..].windows(2).position(|pair| pair == [0xFF, 0xD9]) else {
            if buffer.len() > max_jpeg {
                buffer.drain(..2);
                continue;
            }
            break;
        };
        let end = 2 + end_rel + 2;
        if end > max_jpeg {
            buffer.drain(..2);
            continue;
        }
        frames.push(buffer.drain(..end).collect());
    }
    frames
}

async fn read_camera(
    mut response: reqwest::Response,
    frames: Channel<CameraMessage>,
    mut cancelled: watch::Receiver<()>,
) {
    let mut buffer = Vec::new();
    let mut remote_closed = None;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancelled.changed() => break,
            chunk = timeout(Duration::from_secs(8), response.chunk()) => chunk,
        };
        let bytes = match chunk {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) => {
                remote_closed = Some("盒子摄像头已断开。");
                break;
            }
            Ok(Err(_)) => {
                remote_closed = Some("盒子摄像头传输中断。");
                break;
            }
            Err(_) => {
                remote_closed = Some("盒子摄像头没有继续返回画面。");
                break;
            }
        };
        if buffer.len().saturating_add(bytes.len()) > MAX_JPEG * 2 {
            buffer.clear();
        }
        buffer.extend_from_slice(&bytes);
        for jpeg in take_jpegs(&mut buffer, MAX_JPEG) {
            if frames
                .send(CameraMessage {
                    jpeg: Some(STANDARD.encode(jpeg)),
                    ended: None,
                })
                .is_err()
            {
                return;
            }
        }
    }
    if let Some(reason) = remote_closed {
        let _ = frames.send(CameraMessage {
            jpeg: None,
            ended: Some(reason.into()),
        });
    }
}
