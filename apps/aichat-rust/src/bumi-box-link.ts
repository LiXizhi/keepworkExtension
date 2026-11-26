import { invoke } from "@tauri-apps/api/core";

interface Device {
  ip: string;
  port: number;
  id?: string | null;
  name?: string | null;
  firmware?: string | null;
}

interface Status {
  last?: { ip: string; id?: string | null; requiresKey?: boolean } | null;
  connected?: Device | null;
  disconnectReason?: string | null;
}

type Request =
  | { operation: "status" | "scan" | "disconnect" }
  | { operation: "connect"; ip: string; key: string; expectedId?: string };

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
  const connectButton = field<HTMLButtonElement>("connect");
  const cancelButton = field<HTMLButtonElement>("cancel");
  const disconnectButton = field<HTMLButtonElement>("disconnect");
  const state = field("state");
  const status = field("status");
  const details = field("details");

  let busy: "loading" | "scan" | "connect" | "disconnect" | null = "loading";
  let device: Device | null = null;
  let generation = 0;
  let interval: number | undefined;
  let polling = false;

  function update(message = "") {
    state.dataset.state = busy ? "working" : device ? "connected" : "offline";
    state.textContent = busy ? "处理中" : device ? "已连接" : "未连接";
    status.textContent = message;
    ip.disabled = key.disabled = picker.disabled = scanButton.disabled = connectButton.disabled = Boolean(busy || device);
    disconnectButton.hidden = !device;
    disconnectButton.disabled = Boolean(busy);
    cancelButton.hidden = busy !== "scan" && busy !== "connect";
    details.hidden = !device;
    details.textContent = device
      ? [device.name, `${device.ip}:${device.port}`, device.firmware && `固件 ${device.firmware}`].filter(Boolean).join(" · ")
      : "";
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
    if (!/^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(address)
      || address.split(".").some(octet => Number(octet) > 255)) {
      update("请输入盒子的 IPv4 地址，或点击“扫描设备”。");
      ip.focus();
      return;
    }
    const current = ++generation;
    busy = "connect";
    update(`正在连接盒子 ${address}…`);
    let message = "";
    try {
      const connected = await boxLink<Device>({ operation: "connect", ip: address, key: key.value, expectedId });
      if (current !== generation) return;
      device = connected;
      key.value = "";
      startPolling();
    } catch (cause) {
      message = String(cause);
    } finally {
      if (current === generation) {
        busy = null;
        update(message);
      }
    }
  }

  scanButton.addEventListener("click", async () => {
    if (busy || device) return;
    const current = ++generation;
    busy = "scan";
    choices.hidden = true;
    update("正在扫描盒子，约需 3–9 秒…");
    let message = "";
    try {
      const devices = await boxLink<Device[]>({ operation: "scan" });
      if (current !== generation) return;
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
      if (devices.length === 1) {
        ip.value = picker.value = devices[0].ip;
        message = "已找到盒子，点击“连接盒子”。";
      } else {
        message = devices.length
          ? "请选择盒子并连接。"
          : "未发现盒子。请确认电脑与盒子已联网，或手动输入盒子 IP。";
      }
    } catch (cause) {
      message = String(cause);
    } finally {
      if (current === generation) {
        busy = null;
        update(message);
      }
    }
  });

  picker.addEventListener("change", () => {
    if (picker.value) ip.value = picker.value;
  });
  ip.addEventListener("input", () => {
    if (picker.value !== ip.value) picker.value = "";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    void connect();
  });

  async function disconnect() {
    if (busy === "disconnect") return;
    const cancelling = busy === "connect" || busy === "scan";
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
