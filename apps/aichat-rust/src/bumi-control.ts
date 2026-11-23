import { invoke } from "@tauri-apps/api/core";

interface Device { id: string; name: string; rssi: number | null }
interface Snapshot {
  available: boolean;
  devices: Device[];
  connected: Device | null;
  battery: number | null;
  status: number | null;
  moving: boolean;
  walkMode: boolean;
}
type Command =
  | { action: "battery" | "status" | "dance" | "wave" | "handshake" | "cheer" | "standUp" | "standToFall" | "walk" }
  | { action: "volume"; percent: number }
  | { action: "move"; vx: number; vyaw: number }
  | { action: "speak"; text: string };
type Request =
  | { operation: "status" | "scan" | "disconnect" }
  | { operation: "connect"; id: string }
  | { operation: "send"; command: Command };
interface Motion { vx: number; vyaw: number }

const picker = document.getElementById("device-picker") as HTMLSelectElement;
const volume = document.getElementById("volume") as HTMLInputElement;
const speech = document.getElementById("speech-text") as HTMLInputElement;
const actionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-command]"));
const queryButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-query]"));
const moveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-move]"));
const commandLabels: Record<string, string> = {
  battery: "电量已更新", status: "状态已更新", dance: "跳舞指令已发送",
  wave: "挥手指令已发送", handshake: "握手指令已发送", cheer: "欢呼指令已发送",
  standUp: "一键起身指令已发送", standToFall: "一键收纳指令已发送，请在完成后扶稳机器人。", walk: "已进入行走模式，可按住方向键移动。", volume: "音量指令已发送", speak: "说话指令已发送",
};
const moveVectors: Record<string, Motion> = {
  forward: { vx: 40, vyaw: 0 }, backward: { vx: -40, vyaw: 0 },
  left: { vx: 0, vyaw: 40 }, right: { vx: 0, vyaw: -40 },
};
const zeroMotion = (): Motion => ({ vx: 0, vyaw: 0 });
let snapshot: Snapshot = { available: true, devices: [], connected: null, battery: null, status: null, moving: false, walkMode: false };
let pending = false;
let motionBusy = false;
let motionFailed = false;
let desiredMotion = zeroMotion();
let sentMotion: Motion | null = zeroMotion();
let operation = "点击“扫描设备”开始。";
let error = "";
let deviceList = "";

function button(id: string) { return document.getElementById(id) as HTMLButtonElement; }
function text(id: string, value: string) {
  const element = document.getElementById(id)!;
  if (element.textContent !== value) element.textContent = value;
}
function sameMotion(left: Motion, right: Motion) { return left.vx === right.vx && left.vyaw === right.vyaw; }
function isZero(motion: Motion) { return motion.vx === 0 && motion.vyaw === 0; }
function moving() { return snapshot.moving || !isZero(desiredMotion); }

function renderDevices() {
  const selected = picker.value;
  const serialized = JSON.stringify(snapshot.devices);
  if (serialized !== deviceList) {
    deviceList = serialized;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = snapshot.devices.length ? "请选择机器人…" : "未发现 Bumi 设备";
    picker.replaceChildren(placeholder);
    for (const device of snapshot.devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = `${device.name}${device.rssi === null ? "" : ` · ${device.rssi} dBm`}`;
      picker.appendChild(option);
    }
  }
  if (snapshot.devices.some(device => device.id === selected)) picker.value = selected;
  const device = snapshot.devices.find(item => item.id === picker.value);
  text("device-id", device ? `设备 ID：${device.id}` : "");
}

function render() {
  renderDevices();
  const connected = snapshot.connected !== null;
  const unavailable = !snapshot.available;
  const isMoving = moving();
  const connectionState = document.getElementById("connection-state")!;
  connectionState.dataset.state = connected ? "connected" : pending ? "working" : "offline";
  text("connection-state", connected ? isMoving ? "移动中" : "已连接" : pending ? "处理中" : "未连接");
  picker.disabled = pending || connected || unavailable || !snapshot.devices.length;
  button("scan").disabled = pending || connected || unavailable;
  text("scan", pending && !connected ? "请稍候…" : "扫描设备");
  button("connect").disabled = pending || connected || unavailable || !picker.value;
  button("connect").hidden = connected;
  button("disconnect").hidden = !connected;
  button("disconnect").disabled = !connected;
  for (const control of [...actionButtons, ...queryButtons]) control.disabled = pending || !connected || isMoving;
  button("walk-mode").disabled = pending || !connected || isMoving || snapshot.walkMode;
  text("walk-mode", snapshot.walkMode ? "行走模式已开启" : "进入行走模式");
  for (const control of moveButtons) {
    control.disabled = !connected || unavailable || !snapshot.walkMode;
    const active = !isZero(desiredMotion) && sameMotion(desiredMotion, moveVectors[control.dataset.move!]);
    control.setAttribute("aria-pressed", String(active));
  }
  button("stop-move").disabled = !connected || unavailable;
  volume.disabled = pending || !connected || isMoving;
  button("set-volume").disabled = pending || !connected || isMoving;
  speech.disabled = pending || !connected || isMoving;
  button("speak").disabled = pending || !connected || isMoving || !speech.value.trim();
  text("battery", snapshot.battery === null ? "—" : `${snapshot.battery}%`);
  text("robot-status", snapshot.status === null ? "—" : `状态码 ${snapshot.status}`);
  text("operation", operation);
  text("error", error || (unavailable ? "Bumi 蓝牙控制目前支持 macOS 和 Windows 桌面版。" : ""));
}

async function pumpMotion() {
  if (motionBusy || pending || motionFailed || !snapshot.connected || (sentMotion && sameMotion(desiredMotion, sentMotion))) return;
  const next = { ...desiredMotion };
  motionBusy = true;
  pending = true;
  error = "";
  operation = isZero(next) ? "正在停止移动…" : "正在发送低速移动指令…";
  render();
  try {
    snapshot = await invoke<Snapshot>("bumi_control", {
      request: { operation: "send", command: { action: "move", ...next } } satisfies Request,
    });
    sentMotion = next;
    operation = isZero(next) ? "已停止移动。" : "正在低速移动；松开方向键即停止。";
  } catch (cause) {
    error = String(cause);
    desiredMotion = zeroMotion();
    motionFailed = true;
    operation = isZero(next) ? "停止指令未确认，请立即断开连接。" : "移动指令异常，请检查连接。";
    if (!isZero(next)) {
      try {
        snapshot = await invoke<Snapshot>("bumi_control", {
          request: { operation: "send", command: { action: "move", vx: 0, vyaw: 0 } } satisfies Request,
        });
        sentMotion = zeroMotion();
        operation = "移动指令异常，已尝试停止。";
      } catch {
        operation = "移动状态未确认，请立即断开连接。";
      }
    }
  } finally {
    motionBusy = false;
    pending = false;
    render();
    if (!motionFailed && sentMotion && !sameMotion(desiredMotion, sentMotion)) void pumpMotion();
  }
}

function setMotion(next: Motion, force = false) {
  desiredMotion = { ...next };
  motionFailed = false;
  if (force) sentMotion = null;
  render();
  void pumpMotion();
}

async function request(request: Request, success = "") {
  if (pending) return;
  pending = true;
  error = "";
  operation = request.operation === "scan" ? "正在扫描附近的 Bumi，稀疏广播可能需要约 20 秒…"
    : request.operation === "connect" ? "正在连接并读取蓝牙服务…"
      : request.operation === "disconnect" ? "正在断开连接…" : "正在与 Bumi 通信…";
  render();
  try {
    snapshot = await invoke<Snapshot>("bumi_control", { request });
    operation = success || (request.operation === "scan"
      ? snapshot.devices.length ? `发现 ${snapshot.devices.length} 台设备，请选择并连接。` : "未发现 Bumi。请确认机器人已开机，且未连接手机 App。"
      : request.operation === "connect" ? `已连接 ${snapshot.connected?.name || "Bumi"}。`
        : request.operation === "disconnect" ? "已断开连接。" : "状态已更新。");
    if (request.operation === "connect" || request.operation === "disconnect") {
      desiredMotion = zeroMotion();
      sentMotion = zeroMotion();
      motionFailed = false;
    }
  } catch (cause) {
    error = String(cause);
    operation = "操作未完成，请检查机器人与蓝牙状态后重试。";
  } finally {
    pending = false;
    render();
    if (snapshot.connected && sentMotion && !sameMotion(desiredMotion, sentMotion)) void pumpMotion();
  }
}

picker.addEventListener("change", () => { error = ""; render(); });
button("scan").addEventListener("click", () => void request({ operation: "scan" }));
button("connect").addEventListener("click", () => {
  if (picker.value) void request({ operation: "connect", id: picker.value });
});
button("walk-mode").addEventListener("click", () => {
  void request({ operation: "send", command: { action: "walk" } }, commandLabels.walk);
});
button("disconnect").addEventListener("click", () => {
  desiredMotion = zeroMotion();
  operation = "正在停止移动并断开连接…";
  render();
  const disconnect = async () => {
    while (pending) await new Promise(resolve => setTimeout(resolve, 25));
    await request({ operation: "disconnect" });
  };
  void disconnect();
});
for (const control of actionButtons) {
  control.addEventListener("click", () => {
    const action = control.dataset.command!;
    if (action === "standUp" && !window.confirm("请确认 Bumi 已开机并正面朝上平躺，四肢自然放在腰部两侧、双腿伸直；地面平坦不打滑，脚底无异物，周围 3m × 3m 内没有杂物或行人。\n\n确定执行一键起身吗？")) return;
    if (action === "standToFall" && !window.confirm("请确认 Bumi 当前处于站立姿态，地面平坦不打滑，周围没有杂物或行人。收纳完成后需要立即将机器人扶稳并坐于地面。\n\n确定执行一键收纳吗？")) return;
    void request({ operation: "send", command: { action: action as "dance" | "wave" | "handshake" | "cheer" | "standUp" | "standToFall" } }, commandLabels[action]);
  });
}
for (const control of queryButtons) {
  control.addEventListener("click", () => {
    const action = control.dataset.query as "battery" | "status";
    void request({ operation: "send", command: { action } }, commandLabels[action]);
  });
}
for (const control of moveButtons) {
  const start = () => {
    if (snapshot.connected) setMotion(moveVectors[control.dataset.move!]);
  };
  const stop = () => setMotion(zeroMotion());
  control.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    control.setPointerCapture(event.pointerId);
    start();
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) control.addEventListener(event, stop);
  control.addEventListener("keydown", event => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      start();
    }
  });
  control.addEventListener("keyup", event => {
    if (event.key === " " || event.key === "Enter") stop();
  });
  control.addEventListener("blur", stop);
  control.addEventListener("contextmenu", event => event.preventDefault());
}
button("stop-move").addEventListener("click", () => setMotion(zeroMotion(), true));
window.addEventListener("blur", () => setMotion(zeroMotion()));
document.addEventListener("visibilitychange", () => { if (document.hidden) setMotion(zeroMotion()); });
window.addEventListener("pagehide", () => setMotion(zeroMotion()));
volume.addEventListener("input", () => { text("volume-value", `${volume.value}%`); });
button("set-volume").addEventListener("click", () => {
  void request({ operation: "send", command: { action: "volume", percent: Number(volume.value) } }, commandLabels.volume);
});
speech.addEventListener("input", render);
speech.addEventListener("keydown", event => {
  if (event.key === "Enter" && !button("speak").disabled) button("speak").click();
});
button("speak").addEventListener("click", () => {
  void request({ operation: "send", command: { action: "speak", text: speech.value } }, commandLabels.speak);
});
render();
void request({ operation: "status" }, "点击“扫描设备”开始。");
