import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Device { id: string; name: string; rssi: number | null }
type LocomotionMode = "walk" | "run";
type PostureAction = LocomotionMode | "dance" | "wave" | "handshake" | "cheer" | "standUp" | "standToFall";
interface Snapshot {
  available: boolean;
  devices: Device[];
  connected: Device | null;
  battery: number | null;
  status: number | null;
  moving: boolean;
  walkMode: boolean;
  locomotionMode?: LocomotionMode | null;
  listening: boolean;
}
interface BluetoothMessage {
  direction?: "tx" | "rx";
  receivedAt: string;
  size: number;
  truncated: boolean;
  hex: string;
  opcode: number | null;
  summary: string;
  text: string | null;
}
type Command =
  | { action: "battery" | "status" | PostureAction }
  | { action: "volume"; percent: number }
  | { action: "move"; vx: number; vyaw: number }
  | { action: "speak"; text: string };
type Request =
  | { operation: "status" | "scan" | "disconnect" }
  | { operation: "connect"; id: string }
  | { operation: "listen"; enabled: boolean }
  | { operation: "send"; command: Command };
interface Motion { vx: number; vyaw: number }

const picker = document.getElementById("device-picker") as HTMLSelectElement;
const volume = document.getElementById("volume") as HTMLInputElement;
const speech = document.getElementById("speech-text") as HTMLInputElement;
const actionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-command]"));
const queryButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-query]"));
const moveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-move]"));
const pad = document.getElementById("direction-pad")!;
const stick = document.getElementById("motion-stick") as HTMLButtonElement;
const commandLabels: Record<string, string> = {
  battery: "电量已更新", status: "状态已更新", dance: "跳舞指令已发送",
  wave: "挥手指令已发送", handshake: "握手指令已发送", cheer: "欢呼指令已发送",
  standUp: "一键起身指令已发送", standToFall: "一键收纳指令已发送，请在完成后扶稳机器人。",
  walk: "行走模式指令已发送。",
  run: "全身行走模式指令已发送。",
  volume: "音量指令已发送", speak: "说话指令已发送",
};
// The controls use the SDK's longitudinal and turning axes.
const moveVectors: Record<string, Motion> = {
  forward: { vx: 40, vyaw: 0 }, backward: { vx: -40, vyaw: 0 },
  left: { vx: 0, vyaw: 40 }, right: { vx: 0, vyaw: -40 },
};
const zeroMotion = (): Motion => ({ vx: 0, vyaw: 0 });
const MOTION_REFRESH_MS = 100;
// BLE status labels used by NOETIX Run 3.2.2 for the gait and power states.
const bleStatusLabels: Record<number, string> = {
  0: "未启动", 1: "准备", 2: "行走", 3: "全身行走", 26: "保护", 30: "失能",
};
let snapshot: Snapshot = { available: true, devices: [], connected: null, battery: null, status: null, moving: false, walkMode: false, listening: false };
let pending = false;
let motionBusy = false;
let motionFailed = false;
let disconnecting = false;
let stopQueued = false;
let refreshTimer: number | undefined;
let grip: { pointerId: number; x: number; y: number; radius: number } | null = null;
let stickKey: string | null = null;
let desiredMotion = zeroMotion();
let sentMotion = zeroMotion();
let operation = "点击“扫描设备”开始。";
let error = "";
let deviceList = "";
let messages: BluetoothMessage[] = [];
let sentFrames = 0;
let receivedFrames = 0;
let eventsRegistered = false;

function button(id: string) { return document.getElementById(id) as HTMLButtonElement; }
function text(id: string, value: string) {
  const element = document.getElementById(id)!;
  if (element.textContent !== value) element.textContent = value;
}
function sameMotion(left: Motion, right: Motion) { return left.vx === right.vx && left.vyaw === right.vyaw; }
function isZero(motion: Motion) { return motion.vx === 0 && motion.vyaw === 0; }
function moving() { return snapshot.moving || !isZero(desiredMotion) || !!grip || !!stickKey; }
function requestedMode(): LocomotionMode | null {
  if (snapshot.locomotionMode === undefined) return snapshot.walkMode ? "walk" : null;
  return snapshot.locomotionMode === "walk" || snapshot.locomotionMode === "run" ? snapshot.locomotionMode : null;
}

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

function renderLogStatus() {
  text("listener-status", snapshot.listening && eventsRegistered
    ? `监听中 · 发送 ${sentFrames} 条 · 接收 ${receivedFrames} 条`
    : messages.length ? `监听已停止 · 保留 ${messages.length} 条` : "未开启监听");
  button("clear-messages").disabled = !messages.length;
}

function clearMessages() {
  messages = [];
  sentFrames = receivedFrames = 0;
  const empty = document.createElement("p");
  empty.className = "log-empty";
  empty.textContent = "开启监听后，点“查询电量”可检查蓝牙收发。";
  document.getElementById("message-log")!.replaceChildren(empty);
  renderLogStatus();
}

function appendMessage(message: BluetoothMessage) {
  const log = document.getElementById("message-log")!;
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  if (!messages.length) log.replaceChildren();
  messages.push(message);
  if (message.direction === "tx") sentFrames++;
  else receivedFrames++;
  const received = new Date(message.receivedAt);
  const item = document.createElement("article");
  item.className = "message-item";
  const heading = document.createElement("div");
  heading.className = "message-heading";
  const time = document.createElement("time");
  time.textContent = `${received.toLocaleTimeString("zh-CN", { hour12: false })}.${String(received.getMilliseconds()).padStart(3, "0")}`;
  const summary = document.createElement("strong");
  summary.textContent = `${message.direction === "tx" ? "发送" : "接收"} · ${message.summary}`;
  heading.append(time, summary);
  const hex = document.createElement("code");
  hex.className = "message-hex";
  hex.textContent = message.hex.trim();
  const meta = document.createElement("span");
  meta.className = "message-meta";
  meta.textContent = `${message.size} 字节${message.truncated ? " · 显示已截断" : ""}`;
  item.append(heading, hex, meta);
  if (message.text) {
    const content = document.createElement("p");
    content.className = "message-text";
    content.textContent = message.text;
    item.appendChild(content);
  }
  log.appendChild(item);
  if (messages.length > 200) {
    messages.shift();
    log.firstElementChild?.remove();
  }
  renderLogStatus();
  if (follow) log.scrollTop = log.scrollHeight;
}

function render() {
  renderDevices();
  const connected = snapshot.connected !== null;
  const unavailable = !snapshot.available;
  const isMoving = moving();
  const connectionState = document.getElementById("connection-state")!;
  connectionState.dataset.state = connected ? "connected" : pending ? "working" : "offline";
  text("connection-state", connected ? isMoving ? "移动控制中" : "已连接" : pending ? "处理中" : "未连接");
  picker.disabled = pending || connected || unavailable || !snapshot.devices.length;
  button("scan").disabled = pending || connected || unavailable;
  text("scan", pending && !connected ? "请稍候…" : "扫描设备");
  button("connect").disabled = pending || connected || unavailable || !picker.value;
  button("connect").hidden = connected;
  button("disconnect").hidden = !connected;
  button("disconnect").disabled = !connected || disconnecting;
  const controlsBusy = pending || !connected || disconnecting || isMoving;
  for (const control of queryButtons) control.disabled = controlsBusy;
  for (const control of actionButtons) control.disabled = controlsBusy || motionFailed;
  const mode = requestedMode();
  const legacyHost = snapshot.locomotionMode === undefined;
  button("run-mode").hidden = legacyHost;
  const modeDisabled = controlsBusy || motionFailed;
  button("walk-mode").disabled = modeDisabled;
  button("run-mode").disabled = legacyHost || modeDisabled;
  text("walk-mode", mode === "walk" ? "重发行走模式指令" : "进入行走模式");
  text("run-mode", mode === "run" ? "重发全身行走模式指令" : "进入全身行走模式");
  const motionDisabled = !connected || unavailable || !mode || disconnecting || motionFailed || (pending && !motionBusy);
  stick.disabled = motionDisabled || (isMoving && !grip && !stickKey);
  for (const control of moveButtons) {
    control.disabled = motionDisabled || !!grip || !!stickKey;
    const active = !isZero(desiredMotion) && sameMotion(desiredMotion, moveVectors[control.dataset.move!]);
    control.setAttribute("aria-pressed", String(active));
  }
  button("stop-move").disabled = !connected || unavailable;
  volume.disabled = pending || !connected || isMoving;
  button("set-volume").disabled = pending || !connected || isMoving;
  speech.disabled = pending || !connected || isMoving;
  button("speak").disabled = pending || !connected || isMoving || !speech.value.trim();
  text("battery", snapshot.battery === null ? "—" : `${snapshot.battery}%`);
  const status = snapshot.status;
  text("robot-status", status === null ? "—" : `${bleStatusLabels[status] ?? "状态码"}（${status}）`);
  button("listen-toggle").disabled = pending || !connected || isMoving || disconnecting;
  text("listen-toggle", snapshot.listening && eventsRegistered ? "停止监听" : "开始监听");
  renderLogStatus();
  text("operation", operation);
  text("error", error || (unavailable ? "Bumi 蓝牙控制目前支持 macOS 和 Windows 桌面版。" : ""));
}

async function pumpMotion(refresh = false) {
  if (pending || motionFailed || !snapshot.connected) return;
  const next = stopQueued ? zeroMotion() : { ...desiredMotion };
  if (!stopQueued && sameMotion(next, sentMotion) && !(refresh && !isZero(next))) return;
  stopQueued = false;
  motionBusy = true;
  pending = true;
  error = "";
  if (!refresh) operation = isZero(next) ? "正在停止移动…" : "正在发送移动指令…";
  render();
  try {
    snapshot = await invoke<Snapshot>("bumi_control", {
      request: { operation: "send", command: { action: "move", ...next } } satisfies Request,
    });
    sentMotion = next;
    operation = isZero(next) ? "停止指令已发送。" : "正在发送移动指令，松开即发送停止指令。";
  } catch (cause) {
    error = String(cause);
    resetStick();
    window.clearInterval(refreshTimer);
    desiredMotion = zeroMotion();
    motionFailed = true;
    stopQueued = false;
    operation = isZero(next) ? "停止指令未确认，请立即断开连接。" : "移动指令异常，请检查连接。";
    if (!isZero(next)) {
      try {
        snapshot = await invoke<Snapshot>("bumi_control", {
          request: { operation: "send", command: { action: "move", vx: 0, vyaw: 0 } } satisfies Request,
        });
        sentMotion = zeroMotion();
        motionFailed = false;
        operation = "移动指令异常，已尝试停止。";
      } catch {
        operation = "移动状态未确认，请立即断开连接。";
      }
    }
  } finally {
    motionBusy = false;
    pending = false;
    render();
    if (!motionFailed && snapshot.connected && (stopQueued || (isZero(sentMotion) && !isZero(desiredMotion)))) void pumpMotion();
  }
}

function setMotion(next: Motion, force = false) {
  if (!snapshot.connected || (!force && sameMotion(next, desiredMotion))) return;
  if (!isZero(next) && (disconnecting || motionFailed || !requestedMode() || (pending && !motionBusy))) return;
  const starting = isZero(desiredMotion);
  if (isZero(next)) {
    window.clearInterval(refreshTimer);
    stopQueued = true;
  } else if (starting) {
    refreshTimer = window.setInterval(() => void pumpMotion(true), MOTION_REFRESH_MS);
  }
  desiredMotion = { ...next };
  motionFailed = false;
  render();
  if (starting || stopQueued) void pumpMotion();
}

function resetStick() {
  grip = null;
  stickKey = null;
  stick.style.transform = "";
}

function stopInput(force = false) {
  resetStick();
  setMotion(zeroMotion(), force);
  render();
}

async function request(request: Request, success = "") {
  if (pending || (disconnecting && request.operation !== "disconnect")) return;
  pending = true;
  error = "";
  operation = request.operation === "scan" ? "正在扫描附近的 Bumi，稀疏广播可能需要约 20 秒…"
    : request.operation === "connect" ? "正在连接并读取蓝牙服务…"
      : request.operation === "disconnect" ? "正在断开连接…" : "正在与 Bumi 通信…";
  render();
  try {
    if (request.operation === "listen" && request.enabled) await registerMonitorEvents();
    snapshot = await invoke<Snapshot>("bumi_control", { request });
    if (request.operation === "status" && snapshot.listening) await registerMonitorEvents();
    operation = success || (request.operation === "scan"
      ? snapshot.devices.length ? `发现 ${snapshot.devices.length} 台设备，请选择并连接。` : "未发现 Bumi。请确认机器人已开机，且未连接手机 App。"
      : request.operation === "connect" ? `已连接 ${snapshot.connected?.name || "Bumi"}。`
        : request.operation === "disconnect" ? "已断开连接。" : "状态已更新。");
    if (request.operation === "connect") clearMessages();
    if (request.operation === "connect" || request.operation === "disconnect") {
      resetStick();
      desiredMotion = zeroMotion();
      sentMotion = zeroMotion();
      motionFailed = false;
      stopQueued = false;
    }
  } catch (cause) {
    error = String(cause);
    operation = "操作未完成，请检查机器人与蓝牙状态后重试。";
  } finally {
    pending = false;
    render();
    if (stopQueued || !sameMotion(desiredMotion, sentMotion)) void pumpMotion();
  }
}

function sendPostureCommand(action: PostureAction) {
  if (pending || disconnecting || moving() || motionFailed || !snapshot.connected) return;
  if (action === "run" && snapshot.locomotionMode === undefined) return;
  // A failed write can leave the robot's gait unknown. Require a fresh selection.
  snapshot.walkMode = false;
  if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
  void request({ operation: "send", command: { action } }, commandLabels[action]);
}

picker.addEventListener("change", () => { error = ""; render(); });
button("scan").addEventListener("click", () => void request({ operation: "scan" }));
button("connect").addEventListener("click", () => {
  if (picker.value) void request({ operation: "connect", id: picker.value });
});
button("listen-toggle").addEventListener("click", () => {
  const enabled = !(snapshot.listening && eventsRegistered);
  void request({ operation: "listen", enabled }, enabled ? "蓝牙消息监听已开启。" : "蓝牙消息监听已停止。");
});
button("clear-messages").addEventListener("click", clearMessages);
button("walk-mode").addEventListener("click", () => sendPostureCommand("walk"));
button("run-mode").addEventListener("click", () => sendPostureCommand("run"));
button("disconnect").addEventListener("click", () => {
  if (disconnecting) return;
  disconnecting = true;
  stopInput();
  operation = "正在停止移动并断开连接…";
  render();
  const disconnect = async () => {
    while (pending) await new Promise(resolve => setTimeout(resolve, 25));
    await request({ operation: "disconnect" });
    disconnecting = false;
    render();
  };
  void disconnect();
});
for (const control of actionButtons) {
  control.addEventListener("click", () => {
    const action = control.dataset.command!;
    if (action === "standUp" && !window.confirm("请确认 Bumi 已开机并正面朝上平躺，四肢自然放在腰部两侧、双腿伸直；地面平坦不打滑，脚底无异物，周围 3m × 3m 内没有杂物或行人。\n\n确定执行一键起身吗？")) return;
    if (action === "standToFall" && !window.confirm("请确认 Bumi 当前处于站立姿态，地面平坦不打滑，周围没有杂物或行人。收纳完成后需要立即将机器人扶稳并坐于地面。\n\n确定执行一键收纳吗？")) return;
    sendPostureCommand(action as PostureAction);
  });
}
for (const control of queryButtons) {
  control.addEventListener("click", () => {
    const action = control.dataset.query as "battery" | "status";
    void request({ operation: "send", command: { action } }, commandLabels[action]);
  });
}
stick.addEventListener("pointerdown", event => {
  if (event.button !== 0 || stick.disabled || grip || stickKey || moving()) return;
  const radius = (pad.getBoundingClientRect().width - stick.getBoundingClientRect().width) / 2;
  if (radius <= 0) return;
  event.preventDefault();
  stick.setPointerCapture(event.pointerId);
  grip = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, radius };
  render();
});
stick.addEventListener("pointermove", event => {
  if (!grip || event.pointerId !== grip.pointerId) return;
  const dx = event.clientX - grip.x;
  const dy = event.clientY - grip.y;
  const scale = Math.max(grip.radius, Math.hypot(dx, dy));
  const x = dx / scale;
  const y = dy / scale;
  stick.style.transform = `translate(${x * grip.radius}px, ${y * grip.radius}px)`;
  // NOETIX Run's portrait stick drives longitudinal speed and yaw together.
  setMotion({ vx: signedAxis(-y), vyaw: signedAxis(-x) });
});
function signedAxis(value: number) {
  const magnitude = Math.round(Math.abs(value) * 127);
  return value < 0 && magnitude > 0 ? -magnitude : magnitude;
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  stick.addEventListener(type, event => {
    if (grip?.pointerId === event.pointerId) stopInput();
  });
}
const arrowDirections: Record<string, string> = {
  ArrowUp: "forward", ArrowDown: "backward", ArrowLeft: "left", ArrowRight: "right",
};
stick.addEventListener("keydown", event => {
  const direction = arrowDirections[event.key];
  if (!direction) return;
  event.preventDefault();
  if (stick.disabled || grip || stickKey || event.repeat) return;
  stickKey = event.key;
  setMotion(moveVectors[direction]);
});
stick.addEventListener("keyup", event => {
  if (event.key === stickKey) stopInput();
});
stick.addEventListener("blur", () => { if (grip || stickKey) stopInput(); });
stick.addEventListener("contextmenu", event => event.preventDefault());

for (const control of moveButtons) {
  const start = () => {
    if (!control.disabled) setMotion(moveVectors[control.dataset.move!]);
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
button("stop-move").addEventListener("click", () => stopInput(true));
window.addEventListener("blur", () => stopInput());
document.addEventListener("visibilitychange", () => { if (document.hidden) stopInput(); });
window.addEventListener("pagehide", () => stopInput());
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
async function registerMonitorEvents() {
  if (eventsRegistered) return;
  const options = { target: "bumi-control" };
  const unlisten = await listen<BluetoothMessage>("bumi:message", event => appendMessage(event.payload), options);
  try {
    await listen<{ active: boolean }>("bumi:listener", event => {
      snapshot = { ...snapshot, listening: event.payload.active };
      render();
    }, options);
    eventsRegistered = true;
  } catch (cause) {
    await unlisten();
    throw cause;
  }
}
render();
void request({ operation: "status" }, "点击“扫描设备”开始。");
