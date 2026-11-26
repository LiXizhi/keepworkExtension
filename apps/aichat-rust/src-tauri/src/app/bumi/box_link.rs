use super::{trusted_page, Control};
use futures_util::{stream, stream::FuturesUnordered, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tauri::WebviewWindow;
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

const HTTP_PORT: u16 = 8080;
const DISCOVERY_PORT: u16 = 8081;
const MAX_DEVICES: usize = 32;
const BOX_HOTSPOT: Ipv4Addr = Ipv4Addr::new(192, 168, 5, 1);
const CANCELLED: &str = "已取消盒子连接操作。";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct Device {
    ip: Ipv4Addr,
    port: u16,
    id: Option<String>,
    name: Option<String>,
    firmware: Option<String>,
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
    Connect {
        ip: Ipv4Addr,
        #[serde(default)]
        key: String,
        expected_id: Option<String>,
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
        Request::Connect {
            ip,
            key,
            expected_id,
        } => {
            let result = tokio::select! {
                _ = cancelled.changed() => Err(CANCELLED.into()),
                result = connect(ip, &key, expected_id.as_deref()) => result,
            };
            match result {
                Ok((device, socket)) => {
                    let mut link = control.box_link.lock().unwrap();
                    if !link.owns(&cancelled) {
                        return Err(CANCELLED.into());
                    }
                    let last = Remembered {
                        ip,
                        id: device.id.clone(),
                        requires_key: !key.is_empty(),
                    };
                    if let Some(path) = history_path() {
                        let _ = crate::files::atomic_json_write(&path, &last);
                    }
                    link.connected = Some(device.clone());
                    tauri::async_runtime::spawn(monitor(
                        Arc::clone(control.inner()),
                        socket,
                        cancelled,
                    ));
                    return Ok(Reply::Connected(device));
                }
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
    let interfaces = interfaces();
    let known = known.filter(|ip| reachable(*ip, &interfaces));
    if interfaces.is_empty() && known.is_none() {
        return Err("未检测到可用的 IPv4 网络。请加入路由器或热点后重试。".into());
    }
    let peers = network::arp_addresses().await;
    let mut replies = FuturesUnordered::new();
    for &interface in &interfaces {
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
        replies.push(probe(interface, targets, known));
    }
    let mut devices = BTreeMap::new();
    while let Some(found) = replies.next().await {
        for device in found {
            let key = device.id.clone().unwrap_or_else(|| device.ip.to_string());
            devices.entry(key).or_insert(device);
        }
    }
    if !devices.is_empty() {
        return Ok(devices.into_values().take(MAX_DEVICES).collect());
    }

    let mut candidates = BTreeSet::new();
    for interface in &interfaces {
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
    let client = info_client(Duration::from_millis(300))?;
    let mut probes = stream::iter(
        preferred
            .into_iter()
            .chain(candidates)
            .map(|ip| identify(&client, ip, "", Duration::from_millis(1200))),
    )
    .buffer_unordered(64);
    let deadline = Instant::now() + Duration::from_secs(6);
    while let Ok(Some(result)) = timeout_at(deadline, probes.next()).await {
        if let Ok(device) = result {
            let key = device.id.clone().unwrap_or_else(|| device.ip.to_string());
            devices.entry(key).or_insert(device);
            if devices.len() == MAX_DEVICES {
                break;
            }
        }
    }
    Ok(devices.into_values().collect())
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
    let (active, passive) = tokio::join!(
        receive_beacons(&socket, interface, known, deadline),
        async {
            match broadcast {
                Some(socket) => receive_beacons(&socket, interface, known, deadline).await,
                None => Vec::new(),
            }
        },
    );
    active.into_iter().chain(passive).collect()
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

async fn identify(
    client: &reqwest::Client,
    ip: Ipv4Addr,
    key: &str,
    deadline: Duration,
) -> Result<Device, String> {
    let mut request = client
        .get(format!("http://{ip}:{HTTP_PORT}/api/info"))
        .timeout(deadline);
    if !key.is_empty() {
        request = request.header("X-Box-Key", key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| format!("无法访问盒子 {ip}:{HTTP_PORT}。请检查网络和地址。"))?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err("盒子需要正确的配对码。".into()),
        status => return Err(format!("盒子的设备信息接口返回 HTTP {status}。")),
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "无法读取盒子的设备信息。")?
    {
        if body.len() + chunk.len() > 8192 {
            return Err("盒子的设备信息超出大小限制。".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_info(ip, &body).ok_or_else(|| "该地址没有返回有效的 Box Link 设备信息。".into())
}

fn parse_info(ip: Ipv4Addr, bytes: &[u8]) -> Option<Device> {
    #[derive(Deserialize)]
    struct Info {
        id: Option<String>,
        name: String,
        fw: String,
        caps: Vec<String>,
    }
    let info: Info = serde_json::from_slice(bytes).ok()?;
    if info.name.trim().is_empty() || info.fw.trim().is_empty() || info.caps.is_empty() {
        return None;
    }
    Some(Device {
        ip,
        port: HTTP_PORT,
        id: info.id,
        name: Some(info.name),
        firmware: Some(info.fw),
    })
}

async fn connect(
    ip: Ipv4Addr,
    key: &str,
    expected_id: Option<&str>,
) -> Result<(Device, WebSocketStream<TcpStream>), String> {
    if !reachable(ip, &interfaces()) {
        return Err("请输入盒子所在局域网的 IPv4 地址。".into());
    }
    if key.len() > 256 || !key.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err("配对码无效。".into());
    }
    let client = info_client(Duration::from_secs(2))?;
    let device = identify(&client, ip, key, Duration::from_secs(3)).await?;
    if let (Some(expected), Some(actual)) = (expected_id, device.id.as_deref()) {
        if actual != expected {
            return Err("此地址上的设备已变更，请重新扫描或手动连接。".into());
        }
    }
    let tcp = timeout(Duration::from_secs(2), TcpStream::connect((ip, HTTP_PORT)))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or("盒子的 WebSocket 连接失败。")?;
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
    .ok_or("盒子的 WebSocket 握手失败。")?;
    timeout(Duration::from_secs(3), hello(&mut socket, key))
        .await
        .map_err(|_| "盒子未确认连接。请确认固件和网络状态。")??;
    Ok((device, socket))
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
