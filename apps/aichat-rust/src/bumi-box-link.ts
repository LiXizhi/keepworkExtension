import { Channel, invoke } from "@tauri-apps/api/core";

interface Device {
  ip: string;
  port: number;
  id?: string | null;
  name?: string | null;
  firmware?: string | null;
  camera?: boolean;
}

interface BoxCameraChoice {
  label: string;
}

interface BoxCameraMessage {
  jpeg?: string;
  ended?: string;
}

export async function openBoxCamera(
  onFrame: (jpegBase64: string) => void,
  onEnded: (reason: string) => void,
): Promise<() => void> {
  let stopped = false;
  const frames = new Channel<BoxCameraMessage>();
  frames.onmessage = message => {
    if (stopped) return;
    if (message.ended) onEnded(message.ended);
    else if (message.jpeg) onFrame(message.jpeg);
  };
  await invoke("bumi_box_camera", { enabled: true, frames });
  return () => {
    if (stopped) return;
    stopped = true;
    void invoke("bumi_box_camera", { enabled: false, frames: new Channel() }).catch(() => {});
  };
}

interface Network {
  ssid: string;
  rssi: number;
  channel: number;
  band: "unknown" | "ghz2" | "ghz5" | "ghz6";
  security: "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "wpa3Transition" | "owe" | "enterprise" | "unknown";
  isBox: boolean;
}

interface Status {
  last?: { ip: string; id?: string | null; requiresKey?: boolean } | null;
  connected?: Device | null;
  disconnectReason?: string | null;
}

type Request =
  // `lan` lets the desktop look for the box on this computer's networks when no
  // address is given or no box answers at the one given.
  | { operation: "status" | "scan" | "scanWifi" | "disconnect" }
  | { operation: "connect"; ip?: string; key: string; expectedId?: string; lan: true };

const SECURITY: Record<Network["security"], string> = {
  open: "开放", wep: "WEP", wpa: "WPA", wpa2: "WPA2", wpa3: "WPA3", wpa3Transition: "WPA2/WPA3",
  owe: "增强开放", enterprise: "企业级", unknown: "未知",
};
const BAND: Record<Network["band"], string> = { unknown: "", ghz2: "2.4G", ghz5: "5G", ghz6: "6G" };

function signal(rssi: number) {
  return rssi >= -55 ? "强" : rssi >= -70 ? "中" : "弱";
}

function validIPv4(address: string) {
  return /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(address)
    && !address.split(".").some(octet => Number(octet) > 255);
}

function boxLink<T>(request: Request): Promise<T> {
  return invoke<T>("bumi_box_link", { request });
}

export function setupBumiBoxLink() {
  const field = <T extends HTMLElement>(name: string) => document.getElementById(`box-link-${name}`) as T;
  const form = field<HTMLFormElement>("form");
  const ip = field<HTMLInputElement>("ip");
  const key = field<HTMLInputElement>("key");
  const picker = field<HTMLSelectElement>("picker");
  const choices = field("devices");
  const scanButton = field<HTMLButtonElement>("scan");
  const wifiScan = field<HTMLButtonElement>("wifi-scan");
  const wifi = field("wifi");
  const wifiTitle = field("wifi-title");
  const wifiList = field("wifi-list");
  const connectButton = field<HTMLButtonElement>("connect");
  const cancelButton = field<HTMLButtonElement>("cancel");
  const disconnectButton = field<HTMLButtonElement>("disconnect");
  const state = field("state");
  const status = field("status");
  const details = field("details");

  let busy: "loading" | "scan" | "wifi" | "connect" | "disconnect" | null = "loading";
  let device: Device | null = null;
  // Boxes listed by the last search, and the one picked from that list.
  let scanned: Device[] = [];
  let chosen: Device | null = null;
  let generation = 0;
  let interval: number | undefined;
  let polling = false;
  let boxCamera: BoxCameraChoice | null = null;
  const host = window as Window & {
    __keepworkBoxCamera?: { current: () => BoxCameraChoice | null; open: typeof openBoxCamera };
    __keepworkBoxCameraNotify?: (camera: BoxCameraChoice | null) => void;
  };
  host.__keepworkBoxCamera = { current: () => boxCamera, open: openBoxCamera };

  function publishCamera() {
    const label = device && device.camera !== false ? device.name?.trim() || "xiaozhi-box" : "";
    const next = label ? { label } : null;
    if ((boxCamera?.label ?? "") === (next?.label ?? "")) return;
    boxCamera = next;
    host.__keepworkBoxCameraNotify?.(next);
  }

  function update(message = "") {
    state.dataset.state = busy ? "working" : device ? "connected" : "offline";
    state.textContent = busy ? "处理中" : device ? "已连接" : "未连接";
    status.textContent = message;
    ip.disabled = key.disabled = picker.disabled = scanButton.disabled = wifiScan.disabled = connectButton.disabled = Boolean(busy || device);
    disconnectButton.hidden = !device;
    disconnectButton.disabled = Boolean(busy);
    cancelButton.hidden = busy !== "scan" && busy !== "wifi" && busy !== "connect";
    details.hidden = !device;
    details.textContent = device
      ? [device.name, `${device.ip}:${device.port}`, device.firmware && `固件 ${device.firmware}`].filter(Boolean).join(" · ")
      : "";
    publishCamera();
  }

  function stopPolling() {
    if (interval !== undefined) window.clearInterval(interval);
    interval = undefined;
  }

  function startPolling() {
    stopPolling();
    interval = window.setInterval(async () => {
      if (busy || !device || polling) return;
      const current = generation;
      polling = true;
      try {
        const snapshot = await boxLink<Status>({ operation: "status" });
        if (current === generation && !snapshot.connected) {
          stopPolling();
          device = null;
          update(snapshot.disconnectReason || "盒子连接已断开。");
        } else if (current === generation) {
          update();
        }
      } catch {
        if (current === generation) update("暂时无法确认盒子的连接状态。");
      } finally {
        polling = false;
      }
    }, 3000);
  }

  async function connect(expectedId?: string) {
    if (busy || device) return;
    const address = ip.value.trim();
    if (address && !validIPv4(address)) {
      update("请输入盒子的 IPv4 地址，或点击“扫描设备”。");
      ip.focus();
      return;
    }
    const current = ++generation;
    busy = "connect";
    update(address ? `正在连接盒子 ${address}，连不上时会自动在局域网中查找…` : "正在扫描局域网中的盒子…");
    let message = "";
    try {
      const found = await boxLink<Device | Device[]>({ operation: "connect", ip: address || undefined, key: key.value, expectedId, lan: true });
      if (current !== generation) return;
      if (Array.isArray(found)) {
        // Several boxes are on the network; the user has to say which one.
        showDevices(found);
        ip.value = "";
        message = `${address ? `无法访问盒子 ${address}。` : ""}局域网中有 ${found.length} 个盒子，请选择后连接。`;
      } else {
        device = found;
        key.value = "";
        startPolling();
      }
    } catch (cause) {
      message = String(cause);
    } finally {
      if (current === generation) {
        busy = null;
        update(message);
      }
    }
  }

  async function run<T>(kind: "scan" | "wifi", pending: string, request: Request, accept: (reply: T) => string) {
    const current = ++generation;
    busy = kind;
    update(pending);
    let message = "";
    try {
      const reply = await boxLink<T>(request);
      if (current !== generation) return;
      message = accept(reply);
    } catch (cause) {
      message = String(cause);
    } finally {
      if (current === generation) {
        busy = null;
        update(message);
      }
    }
  }

  function showDevices(devices: Device[]) {
    scanned = devices;
    chosen = null;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择盒子…";
    picker.replaceChildren(placeholder);
    for (const item of devices) {
      const option = document.createElement("option");
      option.value = item.ip;
      option.textContent = [item.name || item.id || "视频语音盒子", item.ip].join(" · ");
      picker.append(option);
    }
    picker.value = "";
    choices.hidden = devices.length === 0;
  }

  function showNetworks(networks: Network[]) {
    wifiTitle.textContent = `附近 Wi-Fi 热点（${networks.length}）`;
    wifiList.replaceChildren(...networks.map(network => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const meta = document.createElement("span");
      row.className = network.isBox ? "box" : "";
      name.className = "wifi-name";
      name.textContent = network.ssid;
      meta.className = "wifi-meta";
      meta.textContent = [
        network.isBox && "盒子热点",
        `${signal(network.rssi)} ${network.rssi} dBm`,
        SECURITY[network.security],
        [BAND[network.band], network.channel && `通道 ${network.channel}`].filter(Boolean).join(" "),
      ].filter(Boolean).join(" · ");
      row.replaceChildren(name, meta);
      return row;
    }));
    wifi.hidden = networks.length === 0;
  }

  function hotspotSummary(networks: Network[]) {
    const boxes = networks.filter(network => network.isBox);
    if (!networks.length) return "未发现 Wi-Fi 热点。请确认 Wi-Fi 已开启，并靠近盒子后重试。";
    if (boxes.length === 1) {
      return `发现盒子热点 ${boxes[0].ssid}（信号${signal(boxes[0].rssi)}）。请在系统 Wi-Fi 列表中加入该热点，再点击“扫描设备”。`;
    }
    if (boxes.length > 1) {
      return `发现 ${boxes.length} 个盒子热点。请在系统 Wi-Fi 列表中加入其中一个，再点击“扫描设备”。`;
    }
    return `发现 ${networks.length} 个 Wi-Fi 热点，未发现 xiaozhi-box 热点。请确认盒子已开机并靠近电脑后重试。`;
  }

  scanButton.addEventListener("click", () => {
    if (busy || device) return;
    choices.hidden = true;
    void run<Device[]>("scan", "正在扫描局域网中的盒子，约需 3 秒…", { operation: "scan" }, devices => {
      showDevices(devices);
      if (devices.length === 1) {
        ip.value = picker.value = devices[0].ip;
        return "已找到盒子，点击“连接盒子”。";
      }
      return devices.length ? "请选择盒子并连接。" : "未发现盒子。请确认电脑与盒子已联网，或手动输入盒子 IP。";
    });
  });

  wifiScan.addEventListener("click", () => {
    if (busy || device) return;
    wifi.hidden = true;
    void run<Network[]>("wifi", "正在扫描附近的 Wi-Fi 热点…如弹出定位授权，请选择「允许」以读取热点名称。", { operation: "scanWifi" }, networks => {
      showNetworks(networks);
      return hotspotSummary(networks);
    });
  });

  picker.addEventListener("change", () => {
    if (!picker.value) return;
    ip.value = picker.value;
    chosen = scanned.find(item => item.ip === picker.value) ?? null;
  });
  ip.addEventListener("input", () => {
    if (picker.value !== ip.value) picker.value = "";
    chosen = null;
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    void connect(chosen?.id ?? undefined);
  });

  async function disconnect() {
    if (busy === "disconnect") return;
    const cancelling = busy === "connect" || busy === "scan" || busy === "wifi";
    ++generation;
    busy = "disconnect";
    update(cancelling ? "正在取消…" : "正在断开盒子…");
    let message = "";
    try {
      await boxLink<null>({ operation: "disconnect" });
      stopPolling();
      device = null;
      key.value = "";
      message = cancelling ? "已取消。" : "已断开盒子。";
    } catch (cause) {
      message = String(cause);
    } finally {
      busy = null;
      update(message);
    }
  }

  cancelButton.addEventListener("click", () => { void disconnect(); });
  disconnectButton.addEventListener("click", () => { void disconnect(); });

  update();
  void boxLink<Status>({ operation: "status" }).then(snapshot => {
    busy = null;
    device = snapshot.connected ?? null;
    if (device) {
      ip.value = device.ip;
      startPolling();
      update();
    } else if (snapshot.last) {
      ip.value = snapshot.last.ip;
      if (snapshot.last.requiresKey) {
        update("请输入上次连接的盒子配对码。");
      } else {
        void connect(snapshot.last.id ?? undefined);
      }
    } else {
      update(snapshot.disconnectReason ?? "");
    }
  }).catch(cause => {
    busy = null;
    update(String(cause));
  });
}

setupBumiBoxLink();
