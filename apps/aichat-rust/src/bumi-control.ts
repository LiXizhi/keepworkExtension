import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createBumiNavigation } from "./bumi-navigation";

interface Device { id: string; name: string; rssi: number | null }
type LocomotionMode = "walk" | "run";
type PostureAction = LocomotionMode | "dance" | "wave" | "handshake" | "cheer" | "standUp" | "standToFall";
interface Snapshot {
  available: boolean;
  devices: Device[];
  connected: Device | null;
  connectionId?: string | null;
  battery: number | null;
  status: number | null;
  moving: boolean;
  walkMode: boolean;
  locomotionMode?: LocomotionMode | null;
  remoteMotionVersion?: number;
  remoteVoiceCommandVersion?: number;
  guidedMotionVersion?: number;
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
  | ({ action: "move" } & Motion)
  | { action: "speak"; text: string };
type Request =
  | { operation: "status" | "disconnect" }
  | { operation: "listen"; enabled: boolean }
  | { operation: "send"; command: Command; remoteCaptureId?: number; voiceId?: number };
interface Motion { vx: number; vyaw: number; vy?: number }

const picker = document.getElementById("device-picker") as HTMLSelectElement;
const volume = document.getElementById("volume") as HTMLInputElement;
const speech = document.getElementById("speech-text") as HTMLInputElement;
const actionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-command]"));
const queryButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-query]"));
const moveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-move]"));
const pad = document.getElementById("direction-pad")!;
const stick = document.getElementById("motion-stick") as HTMLButtonElement;
const stickHorizontal = document.getElementById("stick-horizontal") as HTMLSelectElement;
const commandLabels: Record<string, string> = {
  battery: "电量已更新", status: "状态已更新", dance: "跳舞指令已发送",
  wave: "挥手指令已发送", handshake: "握手指令已发送", cheer: "欢呼指令已发送",
  standUp: "一键起身指令已发送", standToFall: "一键收纳指令已发送，请在完成后扶稳机器人。",
  walk: "行走模式指令已发送。",
  run: "全身行走模式指令已发送。",
  volume: "音量指令已发送", speak: "说话指令已发送",
};
// The remote and jog buttons use a fixed step. The virtual stick scales to ±127.
const DIGITAL_AXIS = 80;
const moveVectors: Record<string, Motion> = {
  forward: { vx: DIGITAL_AXIS, vyaw: 0 }, backward: { vx: -DIGITAL_AXIS, vyaw: 0 },
  left: { vx: 0, vyaw: DIGITAL_AXIS }, right: { vx: 0, vyaw: -DIGITAL_AXIS },
};
const zeroMotion = (): Motion => ({ vx: 0, vyaw: 0 });
const MOTION_REFRESH_MS = 100;
// BLE status labels used by NOETIX Run 3.2.2 for the gait and power states.
const bleStatusLabels: Record<number, string> = {
  0: "未启动", 1: "准备", 2: "行走", 3: "全身行走", 26: "保护", 30: "失能",
};
let snapshot: Snapshot = { available: true, devices: [], connected: null, battery: null, status: null, moving: false, walkMode: false, listening: false };
let pending = false;
const CONNECT_RETRY_MS = 20_000;
const MAX_CONNECT_RETRIES = 3;
const connectionPageId = Math.random().toString(36).slice(2);
let nextAttempt = 0;
interface ConnectionAttempt { id: string; retryTimer?: number }
let connectionAttempt: ConnectionAttempt | null = null;
let motionBusy = false;
let motionFailed = false;
let disconnecting = false;
let stopQueued = false;
let refreshTimer: number | undefined;
let grip: { pointerId: number; x: number; y: number; radius: number } | null = null;
let stickKey: string | null = null;
let desiredMotion = zeroMotion();
let sentMotion = zeroMotion();
const connectionHint = "查找设备约需 20 秒，未连接时最多自动重试 3 次。";
let operation = connectionHint;
let error = "";
let deviceList = "";
let messages: BluetoothMessage[] = [];
let sentFrames = 0;
let receivedFrames = 0;
let eventsRegistered = false;

type Direction = "up" | "down" | "left" | "right";
interface RemoteSample {
  keys: Direction[]; sampledAt: number; error?: string;
  voiceCommand?: string; voiceError?: string; voiceId?: number;
}
interface RemoteSession {
  id: number;
  drive: boolean;
  ready: boolean;
  lastSample: number;
  held: string | null;
  blocked: boolean;
  connectionId: string | null | undefined;
  lastVoiceId: number;
  watchdog?: number;
}
const remoteDirections: Record<Direction, string> = { up: "上", down: "下", left: "左", right: "右" };
const REMOTE_TIMEOUT_MS = 500;
let remote: RemoteSession | null = null;
let nextCapture = Date.now();
let remoteNote = "可先检查按键，诊断期间不会发送运动指令。";
let lostConnectionId: string | null = null;
let disconnectMonitor: Promise<void> | undefined;
type LegDirection = "forward" | "left" | "right";
type HeldLeg = { session: RemoteSession; pressId: number; timer?: number; writing: boolean };
let heldLeg: HeldLeg | null = null;
let stoppingLeg: HeldLeg | null = null;
let nextPress = 0;
const navigation = createBumiNavigation({
  startLeg, stopLeg, canGuide: () => snapshot.guidedMotionVersion === 1,
});

function acceptSnapshot(next: Snapshot) {
  // A completed GATT request can arrive after its disconnect notification.
  if (next.connectionId && next.connectionId === lostConnectionId) return;
  snapshot = next;
}

function button(id: string) { return document.getElementById(id) as HTMLButtonElement; }
function text(id: string, value: string) {
  const element = document.getElementById(id)!;
  if (element.textContent !== value) element.textContent = value;
}
function sameMotion(left: Motion, right: Motion) {
  return left.vx === right.vx && left.vyaw === right.vyaw && (left.vy ?? 0) === (right.vy ?? 0);
}
function isZero(motion: Motion) { return motion.vx === 0 && motion.vyaw === 0 && !motion.vy; }
function moving() { return snapshot.moving || !isZero(desiredMotion) || !!grip || !!stickKey || !!heldLeg || !!stoppingLeg; }
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
  text("device-help", snapshot.connected ? `当前设备：${snapshot.connected.name || "Bumi"}` : "开启机器人并退出手机 App，可连接 Bumi 或 NTXB 设备。");
  const showChoice = !connected && !pending && snapshot.devices.length > 1;
  document.getElementById("device-choice")!.hidden = !showChoice;
  picker.disabled = !showChoice || unavailable;
  button("connect").disabled = pending || unavailable || (showChoice && !picker.value);
  button("connect").hidden = connected;
  button("cancel-connect").hidden = !connectionAttempt;
  text("connect", pending && !connected ? "请稍候…" : showChoice ? "连接所选机器人" : "连接机器人");
  button("rescan").hidden = !showChoice;
  button("rescan").disabled = pending || unavailable;
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
  const motionDisabled = !!remote || !connected || unavailable || !mode || disconnecting || motionFailed || (pending && !motionBusy);
  stick.disabled = motionDisabled || (isMoving && !grip && !stickKey);
  const supportsLateral = snapshot.remoteMotionVersion === 1 || snapshot.remoteMotionVersion === 2;
  if (!supportsLateral || !connected) stickHorizontal.value = "yaw";
  stickHorizontal.disabled = !supportsLateral || motionDisabled || isMoving || motionBusy || stopQueued;
  for (const control of moveButtons) {
    control.disabled = motionDisabled || !!grip || !!stickKey;
    const direction = control.dataset.move!;
    if (direction === "left" || direction === "right") {
      const label = (direction === "left" ? "左" : "右") + (stickHorizontal.value === "lateral" ? "移" : "转");
      if (control.textContent !== label) {
        control.textContent = label;
        control.setAttribute("aria-label", `按住${label}`);
      }
    }
    const active = !isZero(desiredMotion) && sameMotion(desiredMotion, padStep(direction));
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
  button("remote-toggle").disabled = remote ? !remote.drive :
    snapshot.remoteMotionVersion !== 2 || !mode || controlsBusy || motionFailed;
  button("remote-diagnose").disabled = remote ? remote.drive : unavailable || pending || disconnecting || isMoving;
  text("remote-toggle", remote?.drive ? "关闭方向键遥控" : "开启方向键遥控");
  text("remote-diagnose", remote && !remote.drive ? "结束检查" : "检查按键");
  text("remote-status", !remote && connected && snapshot.remoteMotionVersion !== 2
    ? "当前桌面接口不支持遥控器左右转向。可继续使用屏幕摇杆。" : remoteNote);
  button("listen-toggle").disabled = pending || !connected || isMoving || disconnecting;
  text("listen-toggle", snapshot.listening && eventsRegistered ? "停止监听" : "开始监听");
  renderLogStatus();
  text("operation", operation);
  text("error", error || (unavailable ? "Bumi 蓝牙控制目前支持 macOS 和 Windows 桌面版。" : ""));
  navigation.setRemoteActive(remote?.drive === true && remote.ready);
  navigation.setMoving(isMoving || motionBusy || stopQueued);
  syncRemoteShield();
}

async function pumpMotion(refresh = false) {
  if (pending || motionFailed || !snapshot.connected) return;
  if (remote?.drive && !isZero(desiredMotion) && Date.now() - remote.lastSample > REMOTE_TIMEOUT_MS) {
    endRemote("遥控器输入超时，请重新开启。");
    return;
  }
  const next = stopQueued ? zeroMotion() : { ...desiredMotion };
  const source = remote?.drive && !isZero(next) ? remote : null;
  if (!stopQueued && sameMotion(next, sentMotion) && !(refresh && !isZero(next))) return;
  stopQueued = false;
  motionBusy = true;
  pending = true;
  error = "";
  if (!refresh) operation = isZero(next) ? "正在停止移动…" : "正在发送移动指令…";
  render();
  try {
    acceptSnapshot(await invoke<Snapshot>("bumi_control", {
      request: { operation: "send", command: { action: "move", ...next },
        remoteCaptureId: source?.id } satisfies Request,
    }));
    if (!snapshot.connected) return;
    sentMotion = next;
    operation = isZero(next) ? "停止指令已发送。" : "正在发送移动指令，松开即发送停止指令。";
  } catch (cause) {
    // The native check runs immediately before the GATT write. A quick tap
    // can be released while the request is waiting for that check.
    if (source && remote === source && String(cause) === "遥控方向键已释放或遥控会话已结束。") {
      if (!stopQueued) setMotion(zeroMotion(), true);
      return;
    }
    if (remote?.drive) endRemote("机器人通信异常，遥控已关闭。请确认机器人已停稳。");
    error = String(cause);
    resetStick();
    window.clearInterval(refreshTimer);
    desiredMotion = zeroMotion();
    motionFailed = true;
    stopQueued = false;
    operation = isZero(next) ? "停止指令未确认，请立即断开连接。" : "移动指令异常，请检查连接。";
    if (!isZero(next)) {
      try {
        acceptSnapshot(await invoke<Snapshot>("bumi_control", {
          request: { operation: "send", command: { action: "move", vx: 0, vyaw: 0 } } satisfies Request,
        }));
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
    navigation.motionStarted();
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

function endRemote(note: string) {
  const session = remote;
  if (!session) return;
  remote = null;
  navigation.interruptLeg();
  window.clearInterval(session.watchdog);
  remoteNote = note;
  if (session.drive && !isZero(desiredMotion)) stopInput();
  void invoke("bumi_remote_input", { enabled: false, captureId: session.id }).catch(() => {});
  render();
}

function drivingHere(session: RemoteSession) {
  return remote === session && session.drive && session.ready && document.hasFocus() && !document.hidden &&
    !disconnecting && !!snapshot.connected && !!session.connectionId && session.connectionId === snapshot.connectionId &&
    Date.now() - session.lastSample <= REMOTE_TIMEOUT_MS;
}

function startLeg(direction: LegDirection, voiceId?: number) {
  const session = remote;
  if (!session || !drivingHere(session) || snapshot.guidedMotionVersion !== 1 || pending || moving() ||
      motionBusy || stopQueued || motionFailed || session.held !== "" || session.blocked) return false;
  const leg: HeldLeg = { session, pressId: ++nextPress, writing: false };
  heldLeg = leg;
  async function refresh() {
    if (heldLeg !== leg || leg.writing) return;
    if (!drivingHere(leg.session)) { endRemote("遥控连接已改变，导航步进已结束。"); return; }
    leg.writing = true;
    try {
      const next = await invoke<Snapshot>("bumi_control", {
        request: { operation: "guide", captureId: leg.session.id, pressId: leg.pressId, direction, voiceId },
      });
      if (heldLeg === leg && remote === leg.session) acceptSnapshot(next);
    } catch (cause) {
      if (heldLeg === leg && remote === leg.session) {
        error = String(cause);
        endRemote("导航步进未确认。请现场检查机器人并重新定位。");
      }
    } finally { leg.writing = false; }
  }
  leg.timer = window.setInterval(() => void refresh(), MOTION_REFRESH_MS);
  void refresh();
  render();
  return true;
}

function stopLeg() {
  const leg = heldLeg;
  if (!leg) return;
  heldLeg = null;
  window.clearInterval(leg.timer);
  stoppingLeg = leg;
  void invoke<Snapshot>("bumi_control", {
    request: { operation: "guide", captureId: leg.session.id, pressId: leg.pressId },
  }).then(next => {
    if (stoppingLeg === leg && snapshot.connectionId === leg.session.connectionId) acceptSnapshot(next);
  }).catch(cause => {
    motionFailed = true;
    error = String(cause);
    navigation.invalidatePose();
    if (remote === leg.session) endRemote("停止未确认，请立即断开连接并现场核对。");
  }).finally(() => {
    if (stoppingLeg === leg) stoppingLeg = null;
    render();
  });
  render();
}

// Only complete, single imperatives are executable. Questions, negations and
// compound requests must not accidentally turn into a physical action.
function remoteVoiceCommand(session: RemoteSession, sample: RemoteSample) {
  const { voiceId, voiceCommand: raw } = sample;
  if (!drivingHere(session) || snapshot.remoteVoiceCommandVersion !== 1 || !voiceId ||
      !Number.isSafeInteger(voiceId) || voiceId <= session.lastVoiceId) return;
  session.lastVoiceId = voiceId;
  const feedback = (message: string) => {
    text("voice-status", message);
    text("remote-shield-voice", message);
  };
  if (typeof sample.voiceError === "string") { feedback(sample.voiceError.slice(0, 180)); return; }
  if (typeof raw !== "string" || !raw.trim() || raw.length > 120) return;
  const phrase = raw.trim().replace(/[。！!\s]+$/u, "").replace(/^(?:(?:小布米|布米|Bumi|机器人)[，,\s]*)?(?:请你|请)?/iu, "");
  if (/^(?:停止|停下|停下来|停|别走了|不要走了|取消导航)$/u.test(phrase)) {
    stopAllInput(true);
    feedback("已请求停止移动，遥控已关闭。");
    return;
  }
  if (session.held !== "" || session.blocked || pending || moving() || motionBusy || stopQueued || motionFailed) {
    feedback("请松开方向键，等机器人停稳后重新说指令。");
    return;
  }
  if (/^(?:跳舞|跳个舞|跳支舞|跳一支舞)(?:吧)?$/u.test(phrase)) {
    navigation.invalidatePose();
    feedback("正在向 Bumi 发送跳舞指令…");
    void request({ operation: "send", command: { action: "dance" }, remoteCaptureId: session.id, voiceId },
      commandLabels.dance).then(() => feedback(error || operation));
    return;
  }
  if (phrase === "执行本段" || phrase === "继续本段") {
    feedback(navigation.voiceStep(voiceId));
    return;
  }
  if (phrase === "已到位" || phrase === "已经到位") {
    feedback(navigation.confirmStep());
    return;
  }
  const destination = /^(?:走到|走去|前往|去)([^，,。！？!?]{1,16})$/u.exec(phrase);
  if (destination) {
    feedback(navigation.plan(destination[1]));
    return;
  }
  feedback("未识别这个指令。可以说“跳舞”“走到讲台”或“停止”。");
}

function remoteSample(session: RemoteSession, sample: RemoteSample) {
  if (session !== remote) return;
  if (sample.error) { endRemote(sample.error); return; }
  const age = Date.now() - sample.sampledAt;
  if (sample.voiceCommand !== undefined || sample.voiceError !== undefined) {
    if (Number.isFinite(age) && Math.abs(age) <= REMOTE_TIMEOUT_MS) remoteVoiceCommand(session, sample);
    return;
  }
  if (!Number.isFinite(age) || age < -REMOTE_TIMEOUT_MS || age > REMOTE_TIMEOUT_MS ||
      !Array.isArray(sample.keys) || sample.keys.some(key => !Object.prototype.hasOwnProperty.call(remoteDirections, key))) {
    endRemote("遥控器按键状态已失效，请重新开启。");
    return;
  }
  session.lastSample = sample.sampledAt;
  const held = sample.keys.join("+");
  if (held === session.held) return;
  const previous = session.held;
  session.held = held;
  if (held && (heldLeg || stoppingLeg)) {
    navigation.interruptLeg();
    session.blocked = true;
    remoteNote = "导航步进已中断。请松开方向键并核对机器人位置。";
    render();
    return;
  }
  if (!session.drive) {
    const names = sample.keys.map(key => remoteDirections[key]).join(" + ");
    remoteNote = names ? `检测到方向键：${names}` : "四个方向键均已释放。";
  } else if (!held) {
    session.blocked = false;
    if (!isZero(desiredMotion)) stopInput();
    if (session.ready) remoteNote = "四个方向键均已释放。";
  } else if (!session.ready || previous !== "" || sample.keys.length !== 1 || (pending && !motionBusy)) {
    session.blocked = true;
    if (!isZero(desiredMotion)) stopInput();
    remoteNote = "请松开全部方向键，再按一个方向。";
  } else if (!session.blocked) {
    const key = sample.keys[0];
    const direction = key === "up" ? "forward" : key === "down" ? "backward" : key;
    remoteNote = `方向键：${remoteDirections[key]} · 松开即停`;
    setMotion(moveVectors[direction]);
  }
  render();
}

function watchRobotDisconnect() {
  // Keep watching the BLE connection even if a failed write closes remote
  // input before the corresponding native disconnect event reaches the page.
  disconnectMonitor ??= listen<{ id: string; connectionId: string }>("bumi:disconnected", ({ payload }) => {
    if (!payload.connectionId || snapshot.connectionId !== payload.connectionId ||
        snapshot.connected?.id !== payload.id) return;
    lostConnectionId = payload.connectionId;
    navigation.invalidatePose();
    snapshot = { ...snapshot, connected: null, connectionId: null, moving: false, walkMode: false,
      locomotionMode: null, status: null, battery: null, listening: false };
    window.clearInterval(refreshTimer);
    desiredMotion = sentMotion = zeroMotion();
    stopQueued = false;
    resetStick();
    operation = "机器人蓝牙连接已断开，停止状态未知。请现场确认机器人已停稳。";
    if (remote?.drive) endRemote(operation);
    render();
  }, { target: "bumi-control" }).then(() => {}).catch(cause => {
    disconnectMonitor = undefined;
    throw cause;
  });
  return disconnectMonitor;
}

async function startRemote(drive: boolean) {
  if (remote) { endRemote("遥控器方向键已关闭。"); return; }
  if (pending || disconnecting || moving()) return;
  if (drive && (!snapshot.connected || !requestedMode() || snapshot.remoteMotionVersion !== 2)) return;
  const session: RemoteSession = {
    id: ++nextCapture, drive, ready: false, lastSample: Date.now(), held: null,
    blocked: true, connectionId: snapshot.connectionId, lastVoiceId: 0,
  };
  remote = session;
  remoteNote = drive ? "正在确认机器人当前步态…" : "正在识别已配对的小米遥控器…";
  render();
  try {
    if (drive) {
      await watchRobotDisconnect();
      if (remote !== session) return;
      await request({ operation: "send", command: { action: "status" } });
      if (remote !== session) return;
      const mode = requestedMode();
      if (error || !snapshot.connected || !mode || snapshot.status !== (mode === "walk" ? 2 : 3)) {
        endRemote("机器人尚未确认所选步态。请让它站稳并进入行走模式后重试。");
        return;
      }
    }
    const events = new Channel<RemoteSample>();
    events.onmessage = sample => remoteSample(session, sample);
    const voiceCommands = drive && snapshot.remoteVoiceCommandVersion === 1;
    const device = await invoke<string>("bumi_remote_input", { enabled: true, captureId: session.id, events, drive, voiceCommands });
    if (remote !== session) {
      await invoke("bumi_remote_input", { enabled: false, captureId: session.id });
      return;
    }
    session.ready = true;
    if (drive) text("remote-shield-voice", voiceCommands
      ? "按住小米遥控器语音键，说“跳舞”或“走到讲台”，再松开。"
      : "此版本支持方向键。语音也可以在窗口指令框手动执行。");
    if (session.held === null) session.lastSample = Date.now();
    remoteNote = drive ? `${device} · 上、下键控制前后，左、右键控制转向。` : `${device} · 请依次按下并松开四个方向键。`;
    session.watchdog = window.setInterval(() => {
      if (remote === session && Date.now() - session.lastSample > REMOTE_TIMEOUT_MS) {
        endRemote("遥控器输入超时，请重新开启。");
      }
    }, MOTION_REFRESH_MS);
    render();
  } catch (cause) {
    if (remote === session) endRemote(`无法开启遥控器方向键：${String(cause)}`);
  }
}

const remoteShield = document.getElementById("remote-shield") as HTMLDialogElement;
let shieldSyncing = false;
function syncRemoteShield() {
  const driving = remote?.drive === true;
  shieldSyncing = true;
  try {
    if (driving && !remoteShield.open) {
      remoteShield.showModal();
      remoteShield.focus();
    } else if (!driving && remoteShield.open) {
      remoteShield.close();
    }
  } finally {
    shieldSyncing = false;
  }
  text("remote-shield-status", remoteNote);
}
function swallowRemoteKeys(event: KeyboardEvent) {
  if (!remoteShield.open) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
for (const type of ["keydown", "keyup", "keypress"] as const) {
  window.addEventListener(type, swallowRemoteKeys, true);
}
remoteShield.addEventListener("cancel", event => event.preventDefault());
remoteShield.addEventListener("close", () => {
  if (!shieldSyncing && remote?.drive) endRemote("遥控器方向键已关闭。");
});
button("remote-shield-close").addEventListener("click", () => {
  if (remote?.drive) endRemote("遥控器方向键已关闭。");
});
button("remote-diagnose").addEventListener("click", () => void startRemote(false));
button("remote-toggle").addEventListener("click", () => void startRemote(true));

async function request(request: Request, success = "", activity = "") {
  if (pending || (disconnecting && request.operation !== "disconnect")) return;
  pending = true;
  error = "";
  operation = activity || (request.operation === "disconnect" ? "正在断开连接…" : "正在与 Bumi 通信…");
  render();
  try {
    if (request.operation === "listen" && request.enabled) await registerMonitorEvents();
    acceptSnapshot(await invoke<Snapshot>("bumi_control", { request }));
    if (remote?.drive && remote.ready && (!snapshot.connected ||
        snapshot.status !== (requestedMode() === "walk" ? 2 : 3) || !requestedMode())) {
      endRemote("连接或步态已改变。请确认机器人状态后重新开启遥控。");
    }
    if (request.operation === "status") {
      if (snapshot.listening) await registerMonitorEvents();
      operation = snapshot.connected ? "已读取机器人连接状态。" : connectionHint;
    } else {
      operation = success || (request.operation === "disconnect" ? "已断开连接。" : "状态已更新。");
    }
    if (request.operation === "disconnect") { resetConnectionMotion(); navigation.invalidatePose(); }
  } catch (cause) {
    error = String(cause);
    if (request.operation === "send" && request.command.action === "battery") {
      operation = "本次电量查询未完成。";
    } else {
      operation = "操作未完成，请检查机器人与蓝牙状态后重试。";
    }
  } finally {
    pending = false;
    render();
    if (stopQueued || !sameMotion(desiredMotion, sentMotion)) void pumpMotion();
  }
}

function sendPostureCommand(action: PostureAction) {
  if (pending || disconnecting || moving() || motionFailed || !snapshot.connected) return;
  if (action === "run" && snapshot.locomotionMode === undefined) return;
  if (remote) endRemote("步态或姿态已切换，请重新开启遥控。");
  navigation.invalidatePose();
  // A failed write can leave the robot's gait unknown. Require a fresh selection.
  snapshot.walkMode = false;
  if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
  void request({ operation: "send", command: { action } }, commandLabels[action]);
}

function normalizeVoice(raw: string) {
  return raw.trim().replace(/[。！？!?,，.\s]/g, "");
}
function voiceNote(message: string) { text("voice-status", message); }
function pressControl(control: HTMLButtonElement | undefined, unavailable: string) {
  if (!control || control.disabled || control.hidden) {
    voiceNote(unavailable);
    return false;
  }
  control.click();
  return true;
}
function resetConnectionMotion() {
  resetStick();
  desiredMotion = zeroMotion();
  sentMotion = zeroMotion();
  motionFailed = false;
  stopQueued = false;
}

async function readConnectedRobot() {
  if (!snapshot.connected || disconnecting) return;
  const name = snapshot.connected.name || "Bumi";
  await request(
    { operation: "send", command: { action: "battery" } },
    `已连接 ${name}。电量已更新。`,
    `已连接 ${name}。正在查询电量和状态…`,
  );
  const batteryError = error;
  if (!snapshot.connected || disconnecting) return;
  await request(
    { operation: "send", command: { action: "status" } },
    batteryError ? `已连接 ${name}。状态已更新。` : `已连接 ${name}。电量和状态已更新。`,
    `已连接 ${name}。正在查询状态…`,
  );
  if (!batteryError || !snapshot.connected || disconnecting) return;
  if (error) {
    error = `${batteryError} ${error}`;
    render();
    return;
  }
  error = batteryError;
  operation = `已连接 ${name}。状态已更新，电量查询未完成。`;
  render();
}
async function tryConnection(selectedId: string, retry = 0) {
  const attempt: ConnectionAttempt = { id: `${connectionPageId}-${++nextAttempt}` };
  const started = Date.now();
  const prefix = retry ? `第 ${retry}/${MAX_CONNECT_RETRIES} 次重试。` : "";
  connectionAttempt = attempt;
  pending = true;
  error = "";
  let id = selectedId;
  try {
    if (!id) {
      operation = prefix + "正在查找附近的 Bumi，请等待约 20 秒。";
      render();
      const found = await invoke<Snapshot>("bumi_control", { request: { operation: "scan", attemptId: attempt.id } });
      if (connectionAttempt !== attempt) return;
      acceptSnapshot(found);
      if (snapshot.devices.length > 1) {
        operation = `发现 ${snapshot.devices.length} 台设备，请选择要连接的一台。`;
        return;
      }
      id = snapshot.devices[0]?.id;
      if (!id) throw "未发现 Bumi。请确认机器人已开机，且未连接手机 App。";
    }
    operation = prefix + "正在连接并读取蓝牙服务…";
    render();
    const result = await invoke<Snapshot>("bumi_control", { request: { operation: "connect", id, attemptId: attempt.id } });
    if (connectionAttempt !== attempt) return;
    acceptSnapshot(result);
    if (!snapshot.connected) throw "未能连接 Bumi。";
    resetConnectionMotion();
    clearMessages();
  } catch (cause) {
    if (connectionAttempt !== attempt) return;
    error = String(cause);
    if (retry === MAX_CONNECT_RETRIES) {
      operation = `已重试 ${MAX_CONNECT_RETRIES} 次，仍未连接。请检查机器人和系统蓝牙后重新连接。`;
      return;
    }
    // Native discovery needs its full scan window. Wait only the remainder
    // after a fast failure, and never overlap two Bluetooth operations.
    const remaining = Math.max(0, CONNECT_RETRY_MS - (Date.now() - started));
    operation = remaining
      ? `将在 ${Math.ceil(remaining / 1000)} 秒后进行第 ${retry + 1}/${MAX_CONNECT_RETRIES} 次重试。`
      : `即将进行第 ${retry + 1}/${MAX_CONNECT_RETRIES} 次重试。`;
    attempt.retryTimer = window.setTimeout(() => {
      if (connectionAttempt === attempt) void tryConnection(selectedId, retry + 1);
    }, remaining);
    render();
    return;
  } finally {
    if (connectionAttempt === attempt && attempt.retryTimer === undefined) {
      connectionAttempt = null;
      pending = false;
      render();
    }
  }
  await readConnectedRobot();
}

async function cancelConnection() {
  const attempt = connectionAttempt;
  if (!attempt) return;
  connectionAttempt = null;
  operation = "正在取消连接…";
  error = "";
  render();
  try {
    if (attempt.retryTimer !== undefined) {
      window.clearTimeout(attempt.retryTimer);
    } else {
      acceptSnapshot(await invoke<Snapshot>("bumi_control", {
        request: { operation: "cancelConnection", attemptId: attempt.id },
      }));
    }
    operation = "已取消连接。";
  } catch (cause) {
    error = String(cause);
    operation = "已停止重试，未能确认蓝牙连接状态。";
  } finally {
    pending = false;
    render();
  }
}

function connectRobot() {
  if (pending || disconnecting || snapshot.connected || !snapshot.available) return;
  if (snapshot.devices.length > 1) {
    if (picker.value) void tryConnection(picker.value);
    return;
  }
  void tryConnection("");
}
function rescanRobots() {
  if (pending || disconnecting || snapshot.connected || !snapshot.available) return;
  picker.value = "";
  void tryConnection("");
}
function jog(direction: string) {
  if (remote) { voiceNote("请先关闭小米遥控器方向键。"); return; }
  if (!snapshot.connected || disconnecting) {
    voiceNote("请先连接机器人。");
    return;
  }
  if (!requestedMode()) {
    voiceNote("请先说“行走”或“全身行走”，并确认机器人已经站稳。");
    return;
  }
  if (grip || stickKey || moving()) {
    voiceNote("机器人正在移动。先说“停止”。");
    return;
  }
  const motion = moveVectors[direction];
  setMotion(motion);
  voiceNote("正在短距离点动，松手一样会停止。");
  window.setTimeout(() => {
    if (!grip && stickKey === null && sameMotion(desiredMotion, motion)) stopInput();
  }, 800);
}
function runVoiceCommand(raw: string) {
  const phrase = normalizeVoice(raw);
  const field = document.getElementById("voice-command") as HTMLInputElement;
  if (!phrase) {
    voiceNote("请说一个指令，例如：连接、行走、前进、停止、跳舞。");
    return;
  }
  field.value = "";
  const destination = phrase.match(/^(?:走到|走去|前往|去)(.{1,16})$/u);
  if (destination) { voiceNote(navigation.plan(destination[1])); return; }
  if (phrase === "连接" || phrase === "连接机器人") {
    if (snapshot.connected) {
      voiceNote("已经连上了。");
      return;
    }
    if (snapshot.devices.length > 1 && !picker.value) {
      voiceNote("发现多台设备，请先在列表里选择一台。");
      return;
    }
    voiceNote(snapshot.devices.length > 1 ? "正在连接所选机器人…" : "正在查找机器人，请等待约 20 秒。");
    void connectRobot();
    return;
  }
  if (phrase === "重新查找") {
    voiceNote("正在重新查找，请等待约 20 秒。");
    void rescanRobots();
    return;
  }
  const spoken = phrase.match(/^(说话|说)(.+)$/);
  if (spoken) {
    speech.value = spoken[2].slice(0, 120);
    render();
    if (pressControl(button("speak"), "现在不能让机器人说话。请先连接，并等它停稳。")) voiceNote("已提交说话指令。");
    return;
  }
  const volumeRequest = phrase.match(/^音量(\d{1,3})$/);
  if (volumeRequest) {
    const percent = Math.min(100, Number(volumeRequest[1]));
    volume.value = String(percent);
    text("volume-value", `${percent}%`);
    if (pressControl(button("set-volume"), "现在不能设置音量。")) voiceNote(`已提交音量 ${percent}%。`);
    return;
  }
  if (!snapshot.connected) {
    voiceNote("请先说“连接”，或点“连接机器人”。");
    return;
  }
  const posture = ({ 跳舞: "dance", 挥手: "wave", 握手: "handshake", 欢呼: "cheer", 起身: "standUp", 一键起身: "standUp", 收纳: "standToFall", 一键收纳: "standToFall" } as Record<string, string>)[phrase];
  if (posture) {
    const control = actionButtons.find(item => item.dataset.command === posture);
    if (pressControl(control, "现在不能执行这个动作。请先连接，并等机器人停稳。")) voiceNote("已提交动作。起身和收纳仍会要求确认。");
    return;
  }
  const query = ({ 电量: "battery", 查询电量: "battery", 状态: "status", 查询状态: "status" } as Record<string, string>)[phrase];
  if (query) {
    const control = queryButtons.find(item => item.dataset.query === query);
    if (pressControl(control, "现在不能查询。")) voiceNote("已提交查询。");
    return;
  }
  if (phrase === "行走" || phrase === "行走模式" || phrase === "进入行走模式") {
    if (pressControl(button("walk-mode"), "现在不能切换步态。")) voiceNote("已提交行走模式。");
    return;
  }
  if (phrase === "全身行走" || phrase === "全身行走模式" || phrase === "进入全身行走模式") {
    if (pressControl(button("run-mode"), "当前不能切换全身行走。")) voiceNote("已提交全身行走模式。");
    return;
  }
  if (phrase === "停止" || phrase === "停下") {
    stopAllInput(true);
    voiceNote("已发送停止。");
    return;
  }
  if (phrase === "断开" || phrase === "断开连接") {
    if (pressControl(button("disconnect"), "现在不能断开。")) voiceNote("正在断开连接…");
    return;
  }
  if (phrase === "开始监听" || phrase === "停止监听") {
    const active = snapshot.listening && eventsRegistered;
    const enable = phrase === "开始监听";
    if (active === enable) {
      voiceNote(enable ? "已经在监听。" : "监听未开启。");
      return;
    }
    if (pressControl(button("listen-toggle"), "现在不能切换监听。")) voiceNote(enable ? "已开启监听。" : "已停止监听。");
    return;
  }
  if (phrase === "清空" || phrase === "清空记录") {
    if (pressControl(button("clear-messages"), "没有可清空的记录。")) voiceNote("已清空监听记录。");
    return;
  }
  const direction = ({ 前进: "forward", 后退: "backward", 左转: "left", 右转: "right" } as Record<string, string>)[phrase];
  if (direction) {
    jog(direction);
    return;
  }
  voiceNote("不认识这个指令。可以说：连接、行走、前进、停止、跳舞、音量50、说你好。");
}
picker.addEventListener("change", () => {
  error = "";
  if (!snapshot.connected && !pending && snapshot.devices.length > 1 && picker.value) {
    connectRobot();
    return;
  }
  render();
});
button("connect").addEventListener("click", () => { void connectRobot(); });
button("cancel-connect").addEventListener("click", () => { void cancelConnection(); });
button("rescan").addEventListener("click", () => { void rescanRobots(); });
const voiceCommand = document.getElementById("voice-command") as HTMLInputElement;
voiceCommand.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    runVoiceCommand(voiceCommand.value);
  }
});
button("voice-run").addEventListener("click", () => runVoiceCommand(voiceCommand.value));
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
  stopAllInput();
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
  setMotion(stickVector(signedAxis(-y), signedAxis(-x)));
});
function stickVector(vx: number, horizontal: number): Motion {
  return stickHorizontal.value === "lateral" ? { vx, vyaw: 0, vy: horizontal } : { vx, vyaw: horizontal };
}
function padStep(direction: string): Motion {
  const { vx, vyaw } = moveVectors[direction];
  return stickVector(vx, vyaw);
}
stickHorizontal.addEventListener("change", render);
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
  setMotion(padStep(direction));
});
stick.addEventListener("keyup", event => {
  if (event.key === stickKey) stopInput();
});
stick.addEventListener("blur", () => { if (grip || stickKey) stopInput(); });
stick.addEventListener("contextmenu", event => event.preventDefault());

for (const control of moveButtons) {
  const start = () => {
    if (!control.disabled) setMotion(padStep(control.dataset.move!));
  };
  const stop = () => { if (!remote) setMotion(zeroMotion()); };
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
function stopAllInput(force = false) {
  if (remote) {
    const wasMoving = !isZero(desiredMotion);
    endRemote("遥控已关闭。再次使用时请手动开启。");
    if (wasMoving) return;
  }
  stopInput(force);
}
button("stop-move").addEventListener("click", () => stopAllInput(true));
window.addEventListener("blur", () => stopAllInput());
document.addEventListener("visibilitychange", () => { if (document.hidden) stopAllInput(); });
window.addEventListener("pagehide", () => { void cancelConnection(); stopAllInput(); });
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
void request({ operation: "status" });
