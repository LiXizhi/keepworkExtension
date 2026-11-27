import type { BluetoothMessage, Gesture, LocomotionMode, Motion, PostureAction, Request, Snapshot, TeachAction } from "./bumi-control-types";
import { bindSectionShortcuts, bindStickHorizontal, bleStatusLabels, commandLabels, renderDevices } from "./bumi-workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createBumiVision } from "./bumi-vision";
import { createEmbodiedController, defaultSceneConfidence, parseEmbodiedTask, usableMotionFrame, type CountedWalk, type EmbodiedTask, type EmbodiedDirection } from "./bumi-embodied";
import { createChatHandoff, reportChat, isLiveChat, type ChatTask } from "./bumi-chat";
import { executeCountedWalk, executeForwardContinueWalk, verifyWalkIntent } from "./bumi-walk";
import { bindRouteControls, classroomSettleMs, createRoutePreviewCache, executeSingleFrameRoute, planDirections, supportsRouteWalk } from "./bumi-route";
import { createPulseSettings, inspectClassroom, observeClassroom, readCalibration, type ClassroomFrameSource } from "./bumi-classroom-vision";
import { createBumiVoiceControl } from "./bumi-voice-control";

import { commandSentence, inspectionTarget, isStopCommand, normalizeVoice, observationRequest, parseSpokenSteps, remoteVoiceExamples, withoutAddress, type SpokenWalkIntent, type StepDirection } from "./bumi-voice-commands";

const spokenGestures = new Map<string, Gesture>([
  ["跳舞", "dance"], ["挥手", "wave"], ["握手", "handshake"], ["握个手", "handshake"], ["欢呼", "cheer"],
]);
const picker = document.getElementById("device-picker") as HTMLSelectElement;
const volume = document.getElementById("volume") as HTMLInputElement;
const speech = document.getElementById("speech-text") as HTMLInputElement;
const teachName = document.getElementById("teach-name") as HTMLInputElement;
const actionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-command]"));
const queryButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-query]"));
const moveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-move]"));

bindSectionShortcuts();
const pad = document.getElementById("direction-pad")!;
const stick = document.getElementById("motion-stick") as HTMLButtonElement;
const stickHorizontal = bindStickHorizontal(render);
// The remote and jog buttons use a fixed step. The virtual stick scales to ±127.
const DIGITAL_AXIS = 80;
const moveVectors: Record<string, Motion> = {
  forward: { vx: DIGITAL_AXIS, vyaw: 0 }, backward: { vx: -DIGITAL_AXIS, vyaw: 0 },
  left: { vx: 0, vyaw: DIGITAL_AXIS }, right: { vx: 0, vyaw: -DIGITAL_AXIS },
};
const zeroMotion = (): Motion => ({ vx: 0, vyaw: 0 });
const MOTION_REFRESH_MS = 100;
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
let messages: BluetoothMessage[] = [];
let sentFrames = 0;
let receivedFrames = 0;
let eventsRegistered = false;
const TEACH_MAX_SECONDS = 60;
let teachTimer: number | undefined;
let teachRemaining = 0;
let namingTeach = false;
let awaitingTeach: { name: string; previousIds: Set<number> } | null = null;
let teachNote = "";
let teachListKey = "";

type RemoteKey = "up" | "down" | "left" | "right" | "menu";
interface RemoteSample {
  keys: RemoteKey[]; sampledAt: number; error?: string; strafe?: boolean;
  voiceCommand?: string; voiceError?: string; voiceId?: number;
}
interface RemoteSession {
  id: number;
  drive: boolean;
  menuSwitch: boolean;
  strafe: boolean;
  ready: boolean;
  gaitReady: boolean;
  stopping: boolean;
  lastSample: number;
  held: string | null;
  blocked: boolean;
  connectionId: string | null | undefined;
  lastVoiceId: number;
  watchdog?: number;
}
const remoteKeys: Record<RemoteKey, string> = { up: "上", down: "下", left: "左", right: "右", menu: "菜单" };
const REMOTE_TIMEOUT_MS = 500;
let remote: RemoteSession | null = null;
let remotePaused = false;
let nextCapture = Date.now();
let remoteNote = "可先检查按键，诊断期间不会发送运动指令。";
let lostConnectionId: string | null = null;
let disconnectMonitor: Promise<void> | undefined;
type HeldLeg = { session: RemoteSession; pressId: number; timer?: number; deadline?: number; writing: boolean; pulse: SinglePulse };
let heldLeg: HeldLeg | null = null;
let stoppingLeg: HeldLeg | null = null;
let nextPress = 0;
interface ClassroomRun extends ClassroomFrameSource {
  directionsOnly: boolean;
  id: string;
  link: string;
  session?: RemoteSession;
  chat?: ChatTask;
  sequence: number;
  halt?: Promise<void>;
  begin?: Promise<Snapshot>;
  interpreting?: boolean;
}
let classroom: ClassroomRun | undefined;
let classroomClosing: Promise<void> | undefined;
let nextClassroomId = 0;

const voiceCommand = document.getElementById("voice-command") as HTMLInputElement;
const routePreview = createRoutePreviewCache();
const vision = createBumiVision({
  onTrackingReset: routePreview.clear,
  inspectClassroom,
  inspectionTarget: () => inspectionTarget(voiceCommand.value),
  canInspectClassroom() {
    if (snapshot.sceneInspectionVersion !== 1) return "当前桌面宿主不支持只识别。";
    if (classroom || classroomClosing) return "请先结束当前课堂任务。";
    if (moving() || motionBusy || stopQueued || disconnecting) return "请等机器人停稳后再识别。";
    return true;
  },
});

const voiceInput = createBumiVoiceControl({ note: voiceNote, refreshTarget: vision.refreshTarget });
const routeControls = bindRouteControls({
  command: voiceCommand, enabled: vision.routePlanEnabled, render, voiceActive: voiceInput.active, note: voiceNote,
  start: task => { void startClassroom({ singleFrameWalk: task }); },
});

const chatHandoff = createChatHandoff({
  connection: () => snapshot.connected && !disconnecting ? snapshot.connectionId ?? undefined : undefined,
  run: () => classroom,
  busy: () => !!(classroom || classroomClosing || remote),
  moving: () => moving() || motionBusy || stopQueued,
  getCamera: () => vision.acquireClassroomCamera(() => {}),
  watch: watchRobotDisconnect, say: classroomNote, render,
  async stop(reason, link) {
    const run = classroom;
    stopAllInput(true, reason);
    await run?.halt?.catch(() => {});
    if (snapshot.connectionId !== link || disconnecting) throw new Error("原机器人连接已改变。");
    await invoke("bumi_chat_handoff", {request: {operation: "stopConnection", connectionId: link}});
  },
  handshake: () => settledHandshake(),
  clarify: answer => embodied.clarify(answer),
  start: (task, owner) => startClassroom(task, undefined, undefined, owner),
});

interface SinglePulse {
  session?: RemoteSession;
  stopped: Promise<boolean>;
  finish(confirmed: boolean): void;
}
let singlePulse: SinglePulse | undefined;
let jogPulse: SinglePulse | undefined;
function beginSinglePulse(session?: RemoteSession) {
  let resolve!: (confirmed: boolean) => void;
  const stopped = new Promise<boolean>(done => { resolve = done; });
  const pulse: SinglePulse = { session, stopped, finish(confirmed) {
    if (singlePulse === pulse) singlePulse = undefined;
    if (jogPulse === pulse) jogPulse = undefined;
    resolve(confirmed);
  } };
  singlePulse?.finish(false);
  singlePulse = pulse;
  return pulse;
}

function classroomNote(message: string) {
  voiceNote(message);
  const task = classroom?.chat;
  if (task?.result.status === "running") reportChat(task, "running", message);
}
function classroomRequest(request: Request) {
  return invoke<Snapshot>("bumi_control", { request });
}
function classroomStop() {
  const run = classroom;
  if (!run || run.directionsOnly || run.link !== snapshot.connectionId) return;
  if (run.halt) return run.halt;
  run.halt = classroomRequest({ operation: "classroomStop", taskId: run.id, sequence: run.sequence })
    .then(next => {
      if (next.connectionId !== run.link || next.moving) throw new Error("原机器人未确认零速。");
      if (classroom === run) acceptSnapshot(next);
    })
    .catch(cause => {
      if (snapshot.connectionId === run.link) {
        error = `停止指令未确认，请现场确认机器人已停稳。${String(cause)}`;
        motionFailed = true;
        render();
      }
      throw cause;
    });
  // A stop can be the final operation with no subsequent gesture to await it.
  void run.halt.catch(() => {});
  return run.halt;
}
function releaseClassroom() {
  const run = classroom;
  if (!run) return;
  classroom = undefined;
  run.camera?.release();
  if (run.directionsOnly) {
    render();
    return Promise.resolve(true);
  }
  const end = () => classroomRequest({ operation: "endClassroom", taskId: run.id });
  // classroomStop interrupts a pulse immediately. Keep ownership until its
  // zero-speed write finishes. End can also revoke a not-yet-delivered begin.
  const closing = run.begin ? end() : (run.halt ?? Promise.resolve()).then(end, end);
  let confirmed = true;
  classroomClosing = closing.then(() => {}, cause => {
    confirmed = false;
    if (snapshot.connectionId === run.link) error = `结束课堂控制会话未获确认。${String(cause)}`;
  }).finally(() => {
    classroomClosing = undefined;
    render();
  });
  render();
  return classroomClosing.then(() => confirmed);
}
function cancelClassroom(reason: string, preserveFailureFrame = false) {
  if (!classroom) return;
  if (!preserveFailureFrame) classroom.camera?.clearObservation(true);
  if (classroom.directionsOnly) {
    const task = classroom.chat;
    if (task && isLiveChat(task) && task.result.status !== "stopping") reportChat(task, "stopped", "规划已取消。");
    classroomNote("规划已取消。");
    void releaseClassroom();
    return;
  }
  singlePulse?.finish(false);
  if (embodied.isActive()) embodied.stop(reason);
  else {
    const task = classroom.chat;
    const notify = task && isLiveChat(task) && task.result.status !== "stopping";
    if (notify) reportChat(task, "stopping", reason);
    const halt = classroomStop();
    classroomNote(reason);
    const closing = releaseClassroom();
    if (notify) void Promise.all([halt, closing]).then(([, closed]) => {
      const confirmed = !!halt && closed && snapshot.connectionId === task.link;
      reportChat(task, confirmed ? "stopped" : "failed", reason + (confirmed ? " 原连接已确认零速。" : " 停止写入未获确认。"));
    }, cause => reportChat(task, "failed", reason + " 停止写入未获确认。" + String(cause)));
  }
}
function currentClassroom(run?: ClassroomRun): ClassroomRun {
  if (!run || run !== classroom || run.link !== (snapshot.connectionId ?? "") || disconnecting ||
      motionFailed || !document.hasFocus() || document.hidden || (run.camera && !run.camera.isCurrent()) ||
      (run.session && !drivingHere(run.session))) throw new Error("课堂任务或摄像头已停止。");
  return run;
}
async function classroomAction(action: EmbodiedDirection | "handshake" | "wave" | "greet" | "askDoorOrLectern" | "askWhich", run = currentClassroom(classroom), requireFrame: boolean | (() => void) = true) {
  if (run.directionsOnly) throw new Error("单图指路只显示走法。");
  await run.halt;
  currentClassroom(run);
  const pulse = action === "forward" || action === "backward" || action === "left" || action === "right";
  if (requireFrame === true && run.camera && (pulse || action === "handshake" || action === "wave")) {
    const captured = run.motionFrameAt;
    if (captured === undefined || !usableMotionFrame(captured, Date.now())) throw new Error("动作前的画面已失效，请重新观察。");
    run.motionFrameAt = undefined;
  }
  if (pulse) run.camera?.clearObservation();
  run.halt = undefined;
  if (typeof requireFrame === "function") requireFrame();
  const next = await classroomRequest({ operation: "classroomStep", taskId: run.id, sequence: ++run.sequence, action });
  currentClassroom(run);
  if (next.connectionId !== run.link || next.moving) throw new Error("未能确认原机器人已停止移动。");
  acceptSnapshot(next);
  if (run.session && !requestedMode()) run.session.gaitReady = false;
  render();
  if (pulse) {
    await new Promise<void>(resolve => window.setTimeout(resolve, classroomSettleMs));
    currentClassroom(run);
  }
}
const embodied = createEmbodiedController({
  calibration: () => currentClassroom(classroom).calibration,
  observe(target, estimates) {
    const run = currentClassroom(classroom);
    return observeClassroom(() => currentClassroom(run), target, estimates);
  },
  ask: async doorAndLectern => {
    if (snapshot.sceneSpokenChoice) await classroomAction(doorAndLectern ? "askDoorOrLectern" : "askWhich");
  },
  state(status, message) {
    const task = classroom?.chat;
    if (task && !task.paused && task.result.status !== "stopping") reportChat(task, status, message);
  },
  pulse: classroomAction, gesture: classroomAction, greet: () => classroomAction("greet"),
  say: classroomNote, stop: classroomStop, ended: releaseClassroom,
});
async function startClassroom(command: EmbodiedTask | { singleFrameWalk: EmbodiedTask } | CountedWalk | SpokenWalkIntent | EmbodiedDirection | "wave" | "greet" | "trialForward", session?: RemoteSession, voiceId?: number, chat?: ChatTask) {
  function declined(message: string) {
    classroomNote(message);
    if (chat) reportChat(chat, "failed", message);
  }
  const intent = typeof command === "object" && "walkText" in command ? command : undefined;
  const routeWalk = typeof command === "object" && "singleFrameWalk" in command;
  const normalized = routeWalk ? command.singleFrameWalk : command === "trialForward" ? "forward" : command;
  const task = typeof normalized === "object" && "walkText" in normalized
    ? (normalized.expected.count === 1 ? normalized.expected.direction : normalized.expected) : normalized;
  if (intent && snapshot.walkIntentVersion !== 1) { declined("当前桌面不支持 AI 理解步数，请直接说“向前走三步”或“向后走两步”。"); return; }
  if (typeof task === "object" && "count" in task && snapshot.sceneWalkPathVersion !== 1) { declined("当前桌面宿主不支持逐步观察通路，请分次发出单步指令。"); return; }
  const directionsOnly = !routeWalk && typeof task === "object" && "target" in task && task.mode === "approach" && !task.gesture
    && vision.routePlanEnabled();
  if (routeWalk && (!supportsRouteWalk(snapshot) || !vision.routePlanEnabled())) { declined("当前未启用单图行走。"); return; }
  const pulseDirections = (routeWalk || directionsOnly) && supportsRouteWalk(snapshot);
  if (directionsOnly && !pulseDirections && snapshot.singleFrameDirectionsVersion !== 1) { declined("当前桌面不支持单图指路。"); return; }
  if (!directionsOnly && !routeWalk && snapshot.sceneVisionVersion !== 1) { declined("当前桌面宿主没有课堂目标跟随能力。"); return; }
  if (!directionsOnly && (!snapshot.connectionId || !snapshot.connected || requestedMode() !== "walk")) {
    declined("请连接 Bumi，进入行走模式并等它站稳。"); return;
  }
  if (classroom || classroomClosing || remote !== (session ?? null) ||
      pending || moving() || motionBusy || stopQueued || motionFailed || teaching() || disconnecting ||
      !document.hasFocus() || document.hidden || (!directionsOnly && session && !session.gaitReady)) {
    declined("请先结束当前控制，等机器人停稳后再执行。"); return;
  }
  let minConfidence: number | undefined;
  if (!directionsOnly && !routeWalk && typeof task === "object" && "target" in task) {
    try { minConfidence = vision.readConfidenceThreshold(); }
    catch (cause) { declined(cause instanceof Error ? cause.message : String(cause)); return; }
    if (minConfidence !== defaultSceneConfidence && snapshot.sceneConfidenceVersion !== 1) {
      declined("当前桌面宿主仅支持 0.75 的行走置信度阈值，请在行走设置中恢复 0.75 后重试。"); return;
    }
  }
  const profile = pulseSettings.request(snapshot.classroomPulseVersion);
  const run: ClassroomRun = { id: connectionPageId + "-" + ++nextClassroomId, link: snapshot.connectionId ?? "", directionsOnly,
    session, chat, interpreting: !!intent, calibration: readCalibration(false),
    automaticWalkClearance: snapshot.automaticWalkClearanceVersion === 1,
    walkFloorScale: snapshot.walkFloorScaleVersion === 1, supportsSearchView: snapshot.searchViewVersion === 1,
    frames: 0, sequence: 0 };
  classroom = run;
  if (!routeWalk) routePreview.clear();
  const autoContinueForward = command !== "trialForward" && task === "forward" && snapshot.walkContinueVersion === 1
    && vision.walkContinueEnabled() && vision.isReady();
  const pulse = typeof task === "string" && !autoContinueForward && ["forward", "backward", "left", "right"].includes(task) ? beginSinglePulse(session) : undefined;
  async function complete(note: string) {
    currentClassroom(run);
    classroomNote(note);
    const closed = await releaseClassroom();
    pulse?.finish(closed === true);
    if (chat && isLiveChat(chat) && chat.result.status !== "stopping") reportChat(chat, closed ? "completed" : "failed", closed ? note : "结束课堂会话未获确认。");
  }
  function fail(cause: unknown) {
    pulse?.finish(false);
    if (classroom !== run) return;
    const problem = cause instanceof Error ? cause.message : String(cause);
    const message = typeof task === "object" && "count" in task ? `${task.direction === "forward" ? "前进" : "后退"}${task.count}步。${problem}` : problem;
    if (chat && isLiveChat(chat) && !chat.paused && chat.result.status !== "stopping") reportChat(chat, "failed", message);
    if (directionsOnly) {
      classroomNote(message);
      void releaseClassroom();
      return;
    }
    cancelClassroom(message, true);
  }
  try {
    if (typeof task !== "string" || autoContinueForward) {
      run.camera = vision.acquireClassroomCamera(cancelClassroom, pulseDirections);
      if (!pulseDirections) run.calibration = readCalibration(run.camera.calibrated);
      run.calibration.minConfidence = minConfidence;
      if (chat) {
        if (typeof task === "object" && "target" in task) chat.description = { ...task };
        chat.sameCamera = run.camera.matchesSource;
      }
    }
    render();
    if (directionsOnly) {
      if (!run.camera) throw new Error("请先开启摄像头。");
      if (chat) reportChat(chat, "running", "正在规划…");
      classroomNote("正在规划…");
      void planDirections(run.camera, task.target, pulseDirections ? { cache: routePreview, link: run.link,
        profile: profile.pulseProfile, local: !chat && !session } : undefined).then(complete).catch(fail);
      return;
    }
    await watchRobotDisconnect();
    currentClassroom(run);
    if (intent) {
      if (chat) reportChat(chat, "running", "AI 正在核对方向和步数。");
      classroomNote("AI 正在核对方向和步数。");
      await verifyWalkIntent(intent);
      currentClassroom(run);
      if (session && session.lastVoiceId !== voiceId) throw new Error("已有新的遥控口令，请重新说出步数。");
      run.interpreting = false;
      classroomNote(`AI 已核对口令：${intent.expected.direction === "forward" ? "前进" : "后退"}${intent.expected.count}步。`);
    }
    run.begin = classroomRequest({ operation: "beginClassroom", taskId: run.id, connectionId: run.link, ...profile,
      ...(session ? { captureId: session.id, voiceId } : {}) });
    await run.begin;
    run.begin = undefined;
    currentClassroom(run);
    if (typeof task === "object" && "target" in task) {
      if (routeWalk) {
        const currentRouteRun = () => {
          if (!supportsRouteWalk(snapshot) || requestedMode() !== "walk") throw new Error("当前连接的单图行走已中断。");
          return currentClassroom(run);
        };
        const note = await executeSingleFrameRoute(currentRouteRun, task.target,
          (direction, checkRoute) => classroomAction(direction, run, checkRoute), classroomNote, profile.pulseProfile,
          { cache: routePreview, link: run.link });
        await complete(note);
        return;
      }
      embodied.start(task);
      return;
    }
    let note: string;
    if (typeof task !== "string") {
      if (chat) reportChat(chat, "running", "正在观察通路。");
      note = await executeCountedWalk(task, () => currentClassroom(run), direction => classroomAction(direction, run), classroomNote);
    } else if (autoContinueForward) {
      if (chat) reportChat(chat, "running", "正在向前移动，完成后将由 AI 判断是否继续行走。");
      note = await executeForwardContinueWalk(() => currentClassroom(run), requireFrame => classroomAction("forward", run, requireFrame), classroomNote);
    } else {
      vision.resetTracking();
      if (task === "greet") await classroomAction("wave", run);
      await classroomAction(task, run);
      note = task === "wave" ? "挥手动作指令已写入。" : task === "greet" ? "挥手和问候语指令已写入。" : "本次点动和停止指令已写入，请核对实际位移或转角。";
    }
    await complete(note);
  } catch (cause) {
    fail(cause);
  }
}
function handleSceneTask(phrase: string, session?: RemoteSession, voiceId?: number) {
  const task = parseEmbodiedTask(phrase);
  if (!task) {
    if (phrase.length > 64 && /^(?:走到|走去|前往|去|跟着|跟随|跟上)/u.test(phrase)) {
      classroomNote("请输入一个简短的目标描述（最多 64 个字符）。");
      return true;
    }
    return false;
  }
  void startClassroom(task, session, voiceId);
  return true;
}

const pulseSettings = createPulseSettings();
function acceptSnapshot(next: Snapshot) {
  // A completed GATT request can arrive after its disconnect notification.
  if (next.connectionId && next.connectionId === lostConnectionId) return;
  if (next.connectionId !== snapshot.connectionId || next.moving || !supportsRouteWalk(next)) routePreview.clear();
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
function confirmedGait(mode: LocomotionMode | null) {
  return mode !== null && requestedMode() === mode && snapshot.status === (mode === "walk" ? 2 : 3);
}
function remoteGaitHint() {
  return snapshot.remoteVoiceContinue === true
    ? "移动前，请等机器人站稳后说“进入行走模式”或“进入全身行走模式”。"
    : "当前桌面版本需先关闭遥控，重新选择步态后再开启遥控。";
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

function teaching() { return snapshot.teachRecording === true; }
function clearTeachTimer() {
  window.clearInterval(teachTimer);
  teachTimer = undefined;
}
function resetTeachState() {
  clearTeachTimer();
  teachRemaining = 0;
  namingTeach = false;
  awaitingTeach = null;
  teachName.value = "";
  teachNote = "";
  teachListKey = "";
}

function renderTeachList(disabled: boolean) {
  const container = document.getElementById("teach-list")!;
  const actions = snapshot.teachActions ?? [];
  const connected = snapshot.connected !== null;
  const key = JSON.stringify({ connected, disabled, actions });
  if (key === teachListKey) return;
  teachListKey = key;
  if (!actions.length) {
    const empty = document.createElement("p");
    empty.className = "teach-empty";
    empty.textContent = connected
      ? "暂无已加载的自定义动作。录制保存后或点“刷新动作库”查看。"
      : "连接后点击“刷新动作库”，查看或回放已录制的自定义动作。";
    container.replaceChildren(empty);
    return;
  }
  const items: HTMLElement[] = [];
  for (const action of actions) {
    const item = document.createElement("div");
    item.className = "teach-item";
    item.setAttribute("role", "listitem");
    const info = document.createElement("div");
    info.className = "teach-item-info";
    const name = document.createElement("strong");
    name.className = "teach-item-name";
    name.textContent = action.name;
    const metaParts = [`#${action.id}`];
    if (action.duration) metaParts.push(`${action.duration} 秒`);
    if (action.time) metaParts.push(action.time);
    const meta = document.createElement("span");
    meta.className = "teach-item-meta";
    meta.textContent = metaParts.join(" · ");
    info.append(name, meta);
    const buttons = document.createElement("div");
    buttons.className = "teach-item-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "secondary";
    play.textContent = "回放";
    play.disabled = disabled;
    play.dataset.teachPlay = String(action.id);
    play.addEventListener("click", () => { void playTeachAction(action); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "teach-delete";
    remove.textContent = "删除";
    remove.disabled = disabled;
    remove.dataset.teachDelete = String(action.id);
    remove.addEventListener("click", () => { void deleteTeachAction(action); });
    buttons.append(play, remove);
    item.append(info, buttons);
    items.push(item);
  }
  container.replaceChildren(...items);
}

function render() {
  renderDevices(picker, snapshot.devices);
  const connected = snapshot.connected !== null;
  const unavailable = !snapshot.available;
  const isMoving = moving();
  const isTeaching = teaching();
  const teachBusy = isTeaching || namingTeach;
  const connectionState = document.getElementById("connection-state")!;
  connectionState.dataset.state = connected ? "connected" : pending ? "working" : "offline";
  text("connection-state", connected ? isTeaching ? "示教录制中" : isMoving ? "移动控制中" : "已连接" : pending ? "处理中" : "未连接");
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
  chatHandoff.refresh(connected && !disconnecting && snapshot.sceneVisionVersion === 1);
  const classroomBusy = !!classroom || !!classroomClosing;
  pulseSettings.sync(snapshot.connected?.id, snapshot.classroomPulseVersion, classroomBusy || isMoving);
  for (const field of document.querySelectorAll<HTMLInputElement>("#classroom-settings input")) field.disabled = classroomBusy;
  vision.syncConfidenceField(snapshot.sceneConfidenceVersion === 1, classroomBusy);
  vision.syncSearchView(snapshot.searchViewVersion === 1, classroomBusy);
  vision.syncWalkContinue(snapshot.walkContinueVersion === 1, classroomBusy);
  const routeWalkSupported = supportsRouteWalk(snapshot);
  vision.syncRoutePlan(routeWalkSupported ? "walk" : snapshot.singleFrameDirectionsVersion === 1 ? "preview" : "unavailable", classroomBusy);
  const controlsBusy = classroomBusy || pending || !connected || disconnecting || isMoving || teachBusy;
  for (const control of queryButtons) control.disabled = controlsBusy;
  for (const control of actionButtons) control.disabled = controlsBusy || motionFailed;
  const supportsTeach = snapshot.teachVersion === 1;
  document.getElementById("teach-panel")!.hidden = !supportsTeach;
  if (supportsTeach) {
    button("teach-start").hidden = teachBusy;
    button("teach-start").disabled = controlsBusy || motionFailed;
    button("teach-stop").hidden = !isTeaching || namingTeach;
    button("teach-stop").disabled = pending || !connected || disconnecting;
    const timerEl = document.getElementById("teach-timer")!;
    timerEl.hidden = !isTeaching;
    text("teach-timer", isTeaching ? `录制中 · 剩余 ${teachRemaining} 秒` : "");
    document.getElementById("teach-save-box")!.hidden = !connected || !namingTeach;
    teachName.disabled = pending || !connected || disconnecting;
    button("teach-save").disabled = pending || !connected || disconnecting || !teachName.value.trim();
    button("teach-discard").disabled = pending || disconnecting;
    button("teach-refresh").disabled = controlsBusy;
    text("teach-status", teachNote);
    renderTeachList(controlsBusy || motionFailed);
  }
  const mode = requestedMode();
  const trialStep = button("class-trial-step");
  trialStep.hidden = snapshot.sceneVisionVersion !== 1 || !!remote;
  trialStep.disabled = trialStep.hidden || mode !== "walk" || !snapshot.connectionId || unavailable ||
    controlsBusy || motionFailed || motionBusy || stopQueued;
  routeControls.sync(routeWalkSupported, !remote, controlsBusy || mode !== "walk" || !snapshot.connectionId ||
    unavailable || motionFailed || motionBusy || stopQueued);
  const legacyHost = snapshot.locomotionMode === undefined;
  button("run-mode").hidden = legacyHost;
  const modeDisabled = controlsBusy || motionFailed;
  button("walk-mode").disabled = modeDisabled;
  button("run-mode").disabled = legacyHost || modeDisabled;
  text("walk-mode", mode === "walk" ? "重发行走模式指令" : "进入行走模式");
  text("run-mode", mode === "run" ? "重发全身行走模式指令" : "进入全身行走模式");
  const motionDisabled = classroomBusy || !!remote || !connected || unavailable || !mode || disconnecting || motionFailed || teachBusy || (pending && !motionBusy);
  stick.disabled = motionDisabled || (isMoving && !grip && !stickKey);
  const supportsLateral = snapshot.remoteMotionVersion === 1 || snapshot.remoteMotionVersion === 2;
  stickHorizontal.sync({ connected, supportsLateral, gaitSelected: mode !== null,
    locked: motionDisabled || isMoving || motionBusy || stopQueued });
  for (const control of moveButtons) {
    control.disabled = motionDisabled || !!grip || !!stickKey;
    const direction = control.dataset.move!;
    if (direction === "left" || direction === "right") {
      const label = (direction === "left" ? "左" : "右") + (stickHorizontal.lateral ? "移" : "转");
      if (control.textContent !== label) {
        control.textContent = label;
        control.setAttribute("aria-label", `按住${label}`);
      }
    }
    const active = !isZero(desiredMotion) && sameMotion(desiredMotion, padStep(direction));
    control.setAttribute("aria-pressed", String(active));
  }
  button("stop-move").disabled = !connected || unavailable;
  volume.disabled = classroomBusy || pending || !connected || isMoving || teachBusy;
  button("set-volume").disabled = classroomBusy || pending || !connected || isMoving || teachBusy;
  speech.disabled = classroomBusy || pending || !connected || isMoving || teachBusy;
  button("speak").disabled = classroomBusy || pending || !connected || isMoving || teachBusy || !speech.value.trim();
  text("battery", snapshot.battery === null ? "—" : `${snapshot.battery}%`);
  const status = snapshot.status;
  text("robot-status", status === null ? "—" : `${bleStatusLabels[status] ?? "状态码"}（${status}）`);
  button("remote-toggle").disabled = remote ? !remote.drive :
    snapshot.remoteMotionVersion !== 2 || !mode || controlsBusy || motionFailed;
  button("remote-diagnose").disabled = remote ? remote.drive : classroomBusy || unavailable || pending || disconnecting || isMoving;
  text("remote-toggle", remote?.drive ? "关闭方向键遥控" : "开启方向键遥控");
  text("remote-diagnose", remote && !remote.drive ? "结束检查" : "检查按键");
  const keyStatus = remote?.menuSwitch && remote.ready
    ? `左右键：${remote.strafe ? "平移" : "转向"}（菜单键切换） · ${remoteNote}` : remoteNote;
  const remoteStatus = remote?.drive && remote.ready && !remote.gaitReady ? remoteGaitHint() : keyStatus;
  text("remote-status", !remote && connected && snapshot.remoteMotionVersion !== 2
    ? "当前桌面接口不支持遥控器左右转向。可继续使用屏幕摇杆。" : remoteStatus);
  button("listen-toggle").disabled = classroomBusy || pending || !connected || isMoving || disconnecting;
  text("listen-toggle", snapshot.listening && eventsRegistered ? "停止监听" : "开始监听");
  renderLogStatus();
  text("operation", operation);
  text("error", error || (unavailable ? "Bumi 蓝牙控制目前支持 macOS 和 Windows 桌面版。" : ""));
  vision.refreshTarget();
  voiceInput.render();
  syncRemoteShield(remoteStatus);
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
    if (isZero(next)) jogPulse?.finish(true);
    if (remote && isZero(next) && !stopQueued) remote.stopping = false;
    operation = isZero(next) ? "停止指令已发送。" : "正在发送移动指令，松开即发送停止指令。";
  } catch (cause) {
    jogPulse?.finish(false);
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
    vision.resetTracking();
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

function endRemote(note: string, dismiss = false) {
  const session = remote;
  if (!session) return;
  if (singlePulse?.session === session) singlePulse.finish(false);
  cancelHandshake?.();
  cancelClassroom(note);
  remote = null;
  remotePaused = session.drive && session.ready && !dismiss;
  remoteNote = note;
  if (remotePaused) text("voice-status", note);
  stopLeg();
  window.clearInterval(session.watchdog);
  if (session.drive && !isZero(desiredMotion)) stopInput();
  void invoke("bumi_remote_input", { enabled: false, captureId: session.id }).catch(() => {});
  render();
}

function drivingHere(session: RemoteSession) {
  return remote === session && session.drive && session.ready && document.hasFocus() && !document.hidden &&
    !disconnecting && !!snapshot.connected && !!session.connectionId && session.connectionId === snapshot.connectionId &&
    Date.now() - session.lastSample <= REMOTE_TIMEOUT_MS;
}

function startLeg(direction: StepDirection, voiceId: number) {
  const session = remote;
  if (!session || !drivingHere(session) || !session.gaitReady || session.stopping || snapshot.guidedMotionVersion !== 1 || pending || moving() ||
      motionBusy || stopQueued || motionFailed || session.held !== "" || session.blocked) return false;
  const leg: HeldLeg = { session, pressId: ++nextPress, writing: false, pulse: beginSinglePulse(session) };
  vision.resetTracking();
  heldLeg = leg;
  async function refresh() {
    if (heldLeg !== leg || leg.writing) return;
    if (!drivingHere(leg.session)) { endRemote("遥控连接已改变，点动已结束。"); return; }
    leg.writing = true;
    try {
      const next = await invoke<Snapshot>("bumi_control", {
        request: { operation: "guide", captureId: leg.session.id, pressId: leg.pressId, direction, voiceId },
      });
      if (heldLeg === leg && remote === leg.session) acceptSnapshot(next);
    } catch (cause) {
      leg.pulse.finish(false);
      if (heldLeg === leg && remote === leg.session) {
        error = String(cause);
        endRemote(`点动未确认。${error} 请现场检查机器人是否停稳。`);
      }
    } finally { leg.writing = false; }
  }
  leg.timer = window.setInterval(() => void refresh(), MOTION_REFRESH_MS);
  leg.deadline = window.setTimeout(() => { if (heldLeg === leg) stopLeg(); }, 400);
  void refresh();
  render();
  return true;
}

function stopLeg() {
  const leg = heldLeg;
  if (!leg) return;
  heldLeg = null;
  window.clearInterval(leg.timer);
  window.clearTimeout(leg.deadline);
  stoppingLeg = leg;
  let confirmed = false;
  void invoke<Snapshot>("bumi_control", {
    request: { operation: "guide", captureId: leg.session.id, pressId: leg.pressId },
  }).then(next => {
    if (stoppingLeg === leg && snapshot.connectionId === leg.session.connectionId) acceptSnapshot(next);
    confirmed = stoppingLeg === leg && !next.moving && next.connectionId === leg.session.connectionId;
  }).catch(cause => {
    leg.pulse.finish(false);
    motionFailed = true;
    error = String(cause);
    vision.resetTracking();
    const note = `停止未确认。请返回控制面板断开连接并现场核对。${error}`;
    if (remote === leg.session) endRemote(note);
    else if (remotePaused && nextCapture === leg.session.id) remoteNote = note;
  }).finally(() => {
    if (stoppingLeg === leg) stoppingLeg = null;
    leg.pulse.finish(confirmed);
    render();
  });
  render();
}

function inspectFromCommand(sentence: string): boolean {
  const target = observationRequest(sentence);
  if (target === undefined) return false;
  if (target) void vision.inspectTarget(target);
  else voiceNote("请说要识别的人或物，例如“看看讲台”。");
  return true;
}

function remoteVoiceCommand(session: RemoteSession, sample: RemoteSample) {
  const { voiceId, voiceCommand: raw } = sample;
  if (!drivingHere(session) || snapshot.remoteVoiceCommandVersion !== 1 || !voiceId ||
      !Number.isSafeInteger(voiceId) || voiceId <= session.lastVoiceId) return;
  session.lastVoiceId = voiceId;
  const feedback = voiceNote;
  if (typeof sample.voiceError === "string") { feedback(sample.voiceError.slice(0, 180)); return; }
  if (typeof raw !== "string" || !raw.trim() || raw.length > 120) return;
  const phrase = commandSentence(raw);
  if (isStopCommand(phrase)) {
    singlePulse?.finish(false);
    cancelHandshake?.();
    const note = "已收到停止口令，已请求停止移动。";
    if (snapshot.remoteVoiceContinue === true) {
      if (classroom) {
        cancelClassroom(note);
        feedback(note);
        return;
      }
      session.stopping = true;
      stopLeg();
      session.blocked = session.held !== "";
      vision.resetTracking();
      stopInput(true);
    } else {
      stopAllInput(true, note);
    }
    feedback(note);
    return;
  }
  if (classroom?.interpreting) { cancelClassroom("已收到新的语音输入，先前的步数分析已取消。请重新发出指令。"); return; }
  if (inspectFromCommand(phrase)) return;
  if (singlePulse?.session === session && /^(?:握手|握个手)(?:吧)?$/u.test(phrase)
      && snapshot.remoteVoiceGestures === true && session.held === "" && !session.blocked && !session.stopping) {
    // The new voice turn supersedes renewals of an older guided voice pulse.
    // Release its lease and await the native zero before handling the new turn.
    if (heldLeg?.pulse === singlePulse) stopLeg();
    void settledHandshake(session, voiceId).then(() => feedback(commandLabels.handshake), cause => {
      if (session === remote && voiceId === session.lastVoiceId) feedback(String(cause));
    });
    return;
  }
  if (classroom) {
    if (!embodied.clarify(phrase)) feedback("课堂任务进行中，可以说“停下来”。");
    return;
  }
  if (session.held !== "" || session.blocked || session.stopping || pending || moving() || motionBusy || stopQueued || motionFailed) {
    feedback("请松开方向键，等机器人停稳后重新说指令。");
    return;
  }
  const { step, walk, intent, hint } = parseSpokenSteps(phrase);
  if (hint) { feedback(hint); return; }
  if ((step || walk || intent) && !session.gaitReady) {
    feedback(remoteGaitHint());
    return;
  }
  const walkCommand = walk ?? intent;
  if (walkCommand) { void startClassroom(walkCommand, session, voiceId); return; }
  if (step) {
    if (snapshot.classroomPulseVersion === 1 && requestedMode() === "walk" && step !== "strafeLeft" && step !== "strafeRight") {
      void startClassroom(step, session, voiceId);
      return;
    }
    const extended = step === "backward" || step === "strafeLeft" || step === "strafeRight";
    if (snapshot.guidedMotionVersion !== 1 || (extended && snapshot.remoteVoiceStepDirections !== true)) {
      feedback("当前桌面版本不支持这个语音点动方向。可使用遥控器方向键。");
      return;
    }
    feedback(startLeg(step, voiceId) ? `已请求“${phrase}”，约 0.4 秒后发送停止指令。` : "请松开方向键并确认步态已就绪。");
    return;
  }
  const gestureName = phrase.replace(/吧$/u, "").replace(/^跳(?:个|支|一支)舞$/u, "跳舞");
  const gesture = spokenGestures.get(gestureName);
  const gait = phrase === "进入行走模式" ? "walk" : phrase === "进入全身行走模式" ? "run" : null;
  const posture = gait ?? gesture;
  if (posture) {
    if (gesture && gesture !== "dance" && snapshot.remoteVoiceGestures !== true) {
      feedback(`当前桌面版本暂不支持用遥控器语音执行“${gestureName}”。可关闭遥控后点击动作按钮。`);
      return;
    }
    if (snapshot.remoteVoiceContinue !== true && (gait || !session.gaitReady)) {
      feedback(remoteGaitHint());
      return;
    }
    if (gesture === "handshake") {
      void settledHandshake(session, voiceId).then(() => feedback(commandLabels.handshake), cause => {
        if (session === remote && voiceId === session.lastVoiceId) feedback(String(cause));
      });
      return;
    }
    session.gaitReady = false;
    vision.resetTracking();
    feedback(`正在向 Bumi 发送${phrase}指令…`);
    void request({ operation: "send", command: { action: posture }, remoteCaptureId: session.id, voiceId },
      commandLabels[posture]).then(() => {
      if (remote !== session) return;
      if (session.lastVoiceId === voiceId) {
        if (gait && !error) session.gaitReady = confirmedGait(gait);
        if (error) feedback(error);
        else if (!gait) feedback(`${operation} 可继续按住语音键说下一句。`);
        else if (session.gaitReady) feedback(`已确认${gait === "walk" ? "行走" : "全身行走"}模式，可以说“向前走一步”。`);
        else feedback("所选步态尚未确认，请等机器人站稳后再说一次。");
      }
      render();
    });
    return;
  }
  if (handleSceneTask(phrase, session, voiceId)) return;
  feedback(`未识别这个指令。可以说${remoteVoiceExamples(snapshot, spokenGestures.keys())}。`);
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
      (session.menuSwitch && typeof sample.strafe !== "boolean") ||
      !Array.isArray(sample.keys) || sample.keys.some(key => !Object.prototype.hasOwnProperty.call(remoteKeys, key) ||
        (key === "menu" && !session.menuSwitch))) {
    endRemote("遥控器按键状态已失效，请重新开启。");
    return;
  }
  session.lastSample = sample.sampledAt;
  session.strafe = session.menuSwitch && sample.strafe === true;
  const held = sample.keys.join("+");
  if (held === session.held) return;
  const previous = session.held;
  session.held = held;
  if (held && cancelHandshake) {
    cancelHandshake();
    session.blocked = true;
    if (heldLeg || stoppingLeg) stopLeg();
    return;
  }
  if (held && classroom) {
    cancelClassroom("已按下方向键，课堂任务已停止。请松开按键。");
    session.blocked = true;
    return;
  }
  if (held && (heldLeg || stoppingLeg)) {
    stopLeg();
    session.blocked = true;
    remoteNote = "点动已中断，请松开方向键。";
    render();
    return;
  }
  if (!session.drive) {
    const names = sample.keys.map(key => remoteKeys[key]).join(" + ");
    remoteNote = names ? `检测到按键：${names}` : "按键均已释放。";
  } else if (!held) {
    session.blocked = false;
    if (!isZero(desiredMotion)) stopInput();
    if (session.ready) remoteNote = "按键均已释放。";
  } else if (!session.ready || !session.gaitReady || session.stopping || previous !== "" || sample.keys.length !== 1 || (pending && !motionBusy)) {
    session.blocked = true;
    if (!isZero(desiredMotion)) stopInput();
    remoteNote = "请松开全部按键，再单独按一个键。";
  } else if (!session.blocked) {
    const key = sample.keys[0];
    if (key === "menu") {
      remoteNote = "松开菜单键后，按方向键移动。";
    } else {
      const direction = key === "up" ? "forward" : key === "down" ? "backward" : key;
      const vector = moveVectors[direction];
      remoteNote = `方向键：${remoteKeys[key]} · 松开即停`;
      setMotion(session.strafe && vector.vyaw ? { vx: 0, vyaw: 0, vy: vector.vyaw } : vector);
    }
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
    singlePulse?.finish(false);
    cancelHandshake?.();
    cancelClassroom("蓝牙连接已断开，请现场确认机器人已停稳。");
    vision.resetTracking();
    resetTeachState();
    snapshot = { ...snapshot, connected: null, connectionId: null, moving: false, walkMode: false,
      locomotionMode: null, teachRecording: false, teachActions: [], status: null, battery: null, listening: false };
    window.clearInterval(refreshTimer);
    desiredMotion = sentMotion = zeroMotion();
    stopQueued = false;
    resetStick();
    operation = "机器人蓝牙连接已断开，停止状态未知。请现场确认机器人已停稳。";
    if (remote?.drive) endRemote(operation);
    else if (remotePaused) remoteNote = operation;
    render();
  }, { target: "bumi-control" }).then(() => {}).catch(cause => {
    disconnectMonitor = undefined;
    throw cause;
  });
  return disconnectMonitor;
}

async function startRemote(drive: boolean) {
  if (remotePaused) return;
  if (remote) { endRemote("遥控器方向键已关闭。", true); return; }
  if (pending || disconnecting || moving()) return;
  if (drive && (!snapshot.connected || !requestedMode() || snapshot.remoteMotionVersion !== 2)) return;
  const session: RemoteSession = {
    id: ++nextCapture, drive, ready: false, gaitReady: false, stopping: false, lastSample: Date.now(), held: null,
    menuSwitch: snapshot.remoteMenuSwitch === true, strafe: false,
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
      if (error || !snapshot.connected || !confirmedGait(requestedMode())) {
        endRemote("机器人尚未确认所选步态。请让它站稳并进入行走模式后重试。");
        return;
      }
      session.gaitReady = true;
    }
    const events = new Channel<RemoteSample>();
    events.onmessage = sample => remoteSample(session, sample);
    const voiceCommands = drive && snapshot.remoteVoiceCommandVersion === 1;
    const device = await invoke<string>("bumi_remote_input", {
      enabled: true, captureId: session.id, events, drive, voiceCommands, menuSwitch: session.menuSwitch,
    });
    if (remote !== session) {
      await invoke("bumi_remote_input", { enabled: false, captureId: session.id });
      return;
    }
    session.ready = true;
    if (drive) text("remote-shield-voice", voiceCommands
      ? `按住小米遥控器语音键，说一句指令后松开。可说${remoteVoiceExamples(snapshot, spokenGestures.keys())}。`
      : "此版本支持方向键。可以输入目标，只识别当前位置。");
    if (session.held === null) session.lastSample = Date.now();
    remoteNote = drive ? `${device} · 上、下键控制前后。` :
      `${device} · 请依次按下并松开方向键${session.menuSwitch ? "和菜单键" : ""}。`;
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
const classroomPanel = document.getElementById("classroom-panel")!;
let panelInShield = false;
function syncRemoteShield(status: string) {
  const visible = remote?.drive === true || remotePaused;
  const active = remote?.drive === true && remote.ready;
  // Keep the classroom stop beside a running task, inside the remote modal,
  // and for camera-only work when the main movement stop is disabled.
  button("classroom-stop").hidden = !active && !classroom && !button("stop-move").disabled;
  if (panelInShield !== active) {
    panelInShield = active;
    const destination = document.getElementById(active ? "classroom-shield" : "classroom-home")!;
    destination.appendChild(classroomPanel);
    // Older WebViews pause an attached video when its parent is reinserted.
    const video = document.getElementById("vision-video") as HTMLVideoElement;
    if (video?.srcObject) void video.play().catch(() => {});
  }
  text("remote-shield-title", remotePaused ? "遥控已暂停" : "小米遥控器控制 Bumi");
  text("remote-shield-close", remotePaused ? "返回控制面板" : "关闭遥控");
  text("remote-shield-help", remote?.ready && !remote.gaitReady
    ? "按住语音键说下一句，松开后执行。" : "保持此窗口在前台。按住方向键移动或转向，松开即请求停止。");
  document.getElementById("remote-shield-help")!.hidden = remotePaused;
  document.getElementById("remote-shield-voice")!.hidden = remotePaused;
  text("remote-shield-status", status);
  if (visible && !remoteShield.open) {
    remoteShield.showModal();
    remoteShield.focus();
  } else if (!visible && remoteShield.open) {
    remoteShield.close();
  }
}
function swallowRemoteKeys(event: KeyboardEvent) {
  if (!remoteShield.open || remotePaused || event.key === "Tab" || event.target === voiceCommand) return;
  if ((event.target as Element | null)?.closest?.("#classroom-panel")) return;
  if (event.target === button("classroom-stop") || event.target === button("remote-shield-close")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
for (const type of ["keydown", "keyup", "keypress"] as const) {
  window.addEventListener(type, swallowRemoteKeys, true);
}
remoteShield.addEventListener("cancel", event => {
  event.preventDefault();
  if (remotePaused) button("remote-shield-close").click();
});
remoteShield.addEventListener("contextmenu", event => {
  if (remote?.menuSwitch) event.preventDefault();
});
remoteShield.addEventListener("close", () => {
  // A close event may arrive after a new session has reopened the dialog.
  if (remoteShield.open) return;
  remotePaused = false;
  if (remote?.drive) endRemote("遥控器方向键已关闭。", true);
});
button("remote-shield-close").addEventListener("click", () => {
  if (remote?.drive) endRemote("遥控器方向键已关闭。", true);
  else { remotePaused = false; render(); }
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
    if (remote?.drive && remote.ready && (!snapshot.connected || remote.connectionId !== snapshot.connectionId ||
        (remote.gaitReady && !confirmedGait(requestedMode())))) {
      endRemote("连接或步态已改变。请确认机器人状态后重新开启遥控。");
    }
    if (request.operation === "status") {
      if (snapshot.listening) await registerMonitorEvents();
      operation = snapshot.connected ? "已读取机器人连接状态。" : connectionHint;
    } else {
      operation = success || (request.operation === "disconnect" ? "已断开连接。" : "状态已更新。");
    }
    if (request.operation === "disconnect") { resetConnectionMotion(); vision.resetTracking(); }
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

let cancelHandshake: (() => void) | undefined;
async function settledHandshake(session?: RemoteSession, voiceId?: number) {
  const pulse = singlePulse;
  if (pulse && pulse.session === session) {
    if (cancelHandshake) throw new Error("已收到握手指令，正在等本次点动结束。");
    const link = snapshot.connectionId;
    const cancel = () => { if (cancelHandshake === cancel) cancelHandshake = undefined; };
    cancelHandshake = cancel;
    classroomNote("已收到握手指令，等本次点动结束并站稳后执行。");
    const stopped = await pulse.stopped;
    const valid = stopped && cancelHandshake === cancel && link === snapshot.connectionId &&
      (!session || (drivingHere(session) && session.lastVoiceId === voiceId));
    cancel();
    if (!valid) throw new Error("点动结束未获确认或握手已取消。");
  }
  if (!snapshot.connected || remote !== (session ?? null) || classroom || classroomClosing || pending ||
      disconnecting || moving() || motionBusy || stopQueued || motionFailed || teaching() || namingTeach ||
      !document.hasFocus() || document.hidden) {
    throw new Error("请先结束当前控制，等机器人静止后再握手。");
  }
  const device = snapshot.connected.id;
  const link = snapshot.connectionId;
  const assertCurrent = (state: Snapshot) => {
    if (cancelHandshake !== release || state.connected?.id !== device || state.connectionId !== link ||
        state.moving || disconnecting || !document.hasFocus() || document.hidden ||
        (session && (!drivingHere(session) || session.lastVoiceId !== voiceId || session.held !== ""))) {
      throw new Error("握手已取消或无法确认机器人静止。");
    }
  };
  function release() {
    if (cancelHandshake !== release) return;
    cancelHandshake = undefined;
    pending = false;
    render();
  }
  cancelHandshake = release;
  pending = true;
  if (session) session.gaitReady = false;
  classroomNote("正在确认机器人停稳，再执行握手。");
  vision.resetTracking();
  render();
  try {
    const stopped = await classroomRequest({ operation: "send", command: { action: "move", vx: 0, vyaw: 0 } });
    assertCurrent(stopped);
    await new Promise<void>(resolve => window.setTimeout(resolve, 700));
    assertCurrent(snapshot);
    const ready = await classroomRequest({ operation: "send", command: { action: "status" } });
    assertCurrent(ready);
    if (ready.status === null || ![1, 2, 3].includes(ready.status)) {
      throw new Error("机器人尚未确认准备或行走姿态，已取消握手。");
    }
    // A lost handshake reply can still leave the robot in the gesture posture.
    snapshot.walkMode = false;
    if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
    const result = await classroomRequest({ operation: "send", command: { action: "handshake" },
      ...(session ? { remoteCaptureId: session.id, voiceId } : {}) });
    assertCurrent(result);
    acceptSnapshot(result);
    operation = commandLabels.handshake;
  } finally {
    release();
  }
}

function sendPostureCommand(action: PostureAction) {
  if (pending || disconnecting || moving() || motionFailed || teaching() || namingTeach || !snapshot.connected) return;
  if (action === "run" && snapshot.locomotionMode === undefined) return;
  if (remote) endRemote("步态或姿态已切换，请重新开启遥控。");
  vision.resetTracking();
  // A failed write can leave the robot's gait unknown. Require a fresh selection.
  snapshot.walkMode = false;
  if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
  void request({ operation: "send", command: { action } }, commandLabels[action]);
}

async function startTeachRecording() {
  if (pending || disconnecting || moving() || motionFailed || teaching() || namingTeach || !snapshot.connected || snapshot.teachVersion !== 1) return;
  if (remote) endRemote("已进入示教录制，遥控已关闭。");
  vision.resetTracking();
  snapshot.walkMode = false;
  if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
  void watchRobotDisconnect().catch(() => {});
  await request({ operation: "send", command: { action: "startTeach" } }, commandLabels.startTeach, "正在进入示教录制…");
  if (!error && snapshot.connected && teaching()) {
    teachRemaining = TEACH_MAX_SECONDS;
    teachNote = "示教录制中：请轻缓引导 Bumi 手臂摆动，完成后点“命名并结束录制”。";
    clearTeachTimer();
    const deadline = Date.now() + TEACH_MAX_SECONDS * 1000;
    teachTimer = window.setInterval(() => {
      if (!teaching() || !snapshot.connected) { clearTeachTimer(); render(); return; }
      teachRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (teachRemaining === 0) {
        if (!pending) void stopTeachRecording(true);
        return;
      }
      render();
    }, 1000);
    render();
  }
}

function nameTeachRecording() {
  if (pending || disconnecting || !teaching() || namingTeach) return;
  namingTeach = true;
  teachNote = "录制仍在进行。输入名称后点击“保存动作”即可结束录制，也可点击“放弃”。";
  render();
  teachName.focus();
}

async function stopTeachRecording(expired: boolean) {
  if (pending || disconnecting || !snapshot.connected || !teaching()) return;
  clearTeachTimer();
  namingTeach = true;
  await request({ operation: "send", command: { action: "stopTeach" } }, commandLabels.stopTeach, "正在停止示教录制…");
  if (!snapshot.connected) return;
  teachNote = error
    ? "未能确认录制已停止，请点击“放弃”重试停止，或断开连接。"
    : expired ? "已达到 60 秒上限并自动停止录制，请为动作命名并保存。" : "录制已停止，请为动作命名并保存。";
  render();
}

async function discardTeachRecording() {
  if (pending || disconnecting || !namingTeach || !snapshot.connected) return;
  if (teaching()) {
    await request({ operation: "send", command: { action: "stopTeach" } }, commandLabels.stopTeach);
    if (error || !snapshot.connected) return;
  }
  clearTeachTimer();
  namingTeach = false;
  teachName.value = "";
  teachNote = "已放弃保存本次示教录制。";
  render();
}

async function saveTeachAction() {
  if (pending || disconnecting || !snapshot.connected || !namingTeach) return;
  const name = teachName.value.trim();
  if (!name) {
    teachNote = "请输入动作名称。";
    render();
    return;
  }
  const previousIds = new Set((snapshot.teachActions ?? []).map(item => item.id));
  await request(
    { operation: "send", command: { action: "saveTeach", name } },
    commandLabels.saveTeach,
    "正在保存示教动作…",
  );
  if (!error && snapshot.connected) {
    clearTeachTimer();
    namingTeach = false;
    awaitingTeach = { name, previousIds };
    teachName.value = "";
    teachNote = `已发送保存指令，正在从机器人读取“${name}”…`;
    render();
    await refreshTeachList();
  }
}

async function refreshTeachList() {
  if (pending || disconnecting || moving() || teaching() || !snapshot.connected || snapshot.teachVersion !== 1) return;
  await request({ operation: "send", command: { action: "teachList" } }, commandLabels.teachList, "正在读取示教动作库…");
  if (!snapshot.connected) return;
  const actions = snapshot.teachActions ?? [];
  const expected = awaitingTeach;
  if (expected) {
    const entry = !error && actions.find(item => item.name === expected.name && !expected.previousIds.has(item.id));
    if (entry) {
      teachNote = `动作库已读到“${entry.name}”（#${entry.id}），共 ${actions.length} 个自定义动作。`;
      awaitingTeach = null;
    } else {
      teachNote = `暂未确认“${expected.name}”已保存，请稍后点击“刷新动作库”核对。`;
    }
  } else if (!error) {
    teachNote = actions.length ? `动作库已更新，共 ${actions.length} 个自定义动作。` : "动作库已更新，当前暂无已保存的自定义动作。";
  }
  render();
}

async function playTeachAction(action: TeachAction) {
  if (pending || disconnecting || moving() || motionFailed || teaching() || namingTeach || !snapshot.connected) return;
  if (remote) endRemote("已切换为自定义动作回放，请重新开启遥控。");
  vision.resetTracking();
  snapshot.walkMode = false;
  if (snapshot.locomotionMode !== undefined) snapshot.locomotionMode = null;
  await request(
    { operation: "send", command: { action: "playTeach", id: action.id } },
    `自定义动作“${action.name}”回放指令已发送。`,
    `正在回放“${action.name}”…`,
  );
  if (!error) {
    teachNote = `已发送回放：${action.name}（#${action.id}）。`;
    render();
  }
}

async function deleteTeachAction(action: TeachAction) {
  if (pending || disconnecting || moving() || teaching() || namingTeach || !snapshot.connected) return;
  if (!window.confirm(`确定删除自定义动作“${action.name}”（#${action.id}）吗？此操作无法撤销。`)) return;
  await request(
    { operation: "send", command: { action: "deleteTeach", id: action.id } },
    `自定义动作“${action.name}”已删除。`,
    `正在删除“${action.name}”…`,
  );
  if (!error) {
    teachNote = `已删除动作：${action.name}。`;
    render();
  }
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
  resetTeachState();
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
  if (classroom || classroomClosing || pending || motionBusy || motionFailed || teaching() || grip || stickKey || moving()) {
    voiceNote("机器人正在移动。先说“停止”。");
    return;
  }
  const motion = moveVectors[direction];
  setMotion(motion);
  jogPulse = beginSinglePulse();
  voiceNote("正在短距离点动，松手一样会停止。");
  window.setTimeout(() => {
    if (!grip && stickKey === null && sameMotion(desiredMotion, motion)) stopInput();
  }, 800);
}
function runVoiceCommand(raw: string) {
  if (voiceInput.active()) { voiceNote("请先结束或取消本次语音输入。"); return; }
  const sentence = commandSentence(raw);
  const phrase = normalizeVoice(sentence);
  if (!phrase) {
    voiceNote("请说一个指令，例如：连接、行走、前进、停止、跳舞。");
    return;
  }
  if (isStopCommand(sentence)) {
    stopAllInput(true); voiceNote("已请求停止。"); return;
  }
  if (inspectFromCommand(sentence)) return;
  if (remote?.drive) {
    voiceNote("遥控期间可输入目标进行识别，动作指令请按住遥控器语音键说出。");
    return;
  }
  if (!routeControls.approach(sentence)) voiceCommand.value = "";
  vision.refreshTarget();
  if (classroom?.interpreting) { cancelClassroom("先前的步数分析已取消，请重新发出指令。"); return; }
  if (classroom && singlePulse && /^(?:握手|握个手)$/u.test(sentence)) {
    void settledHandshake().then(() => voiceNote(commandLabels.handshake), cause => voiceNote(String(cause)));
    return;
  }
  if (classroom) {
    if (!embodied.clarify(sentence)) voiceNote("课堂任务进行中，可以说“停下来”。");
    return;
  }
  const spoken = withoutAddress(raw).match(/^(?:说话|说)[：:，,\s]*(.*)$/su);
  if (spoken) {
    if (!spoken[1]) { voiceNote("请在“说”后输入要播报的内容。"); return; }
    if (new TextEncoder().encode(spoken[1]).byteLength > 120) {
      voiceNote("说话内容最多 120 个 UTF-8 字节，请缩短后重试。");
      return;
    }
    speech.value = spoken[1];
    render();
    if (pressControl(button("speak"), "现在不能让机器人说话。请先连接，并等它停稳。")) voiceNote("已提交说话指令。");
    return;
  }
  const { step, walk, intent, hint } = parseSpokenSteps(sentence);
  if (hint) { voiceNote(hint); return; }
  const walkCommand = walk ?? intent;
  if (walkCommand) { void startClassroom(walkCommand); return; }
  if (handleSceneTask(sentence)) return;
  if (/[？?]/u.test(sentence)) { voiceNote("请输入要执行的指令。"); return; }
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
  if (step && step !== "strafeLeft" && step !== "strafeRight") {
    if (snapshot.sceneVisionVersion === 1) void startClassroom(step);
    else jog(step);
    return;
  }
  const posture = spokenGestures.get(phrase) ??
    ({ 起身: "standUp", 一键起身: "standUp", 收纳: "standToFall", 一键收纳: "standToFall" } as Record<string, string>)[phrase];
  if (posture) {
    if (posture === "handshake") {
      void settledHandshake().then(() => voiceNote(commandLabels.handshake), cause => voiceNote(String(cause)));
      return;
    }
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
  if (phrase === "开始示教" || phrase === "开始录制" || phrase === "示教录制") {
    if (pressControl(button("teach-start"), "当前不能开始示教录制。")) voiceNote("已提交示教录制。");
    return;
  }
  if (phrase === "停止示教" || phrase === "停止录制" || phrase === "结束示教") {
    if (teaching() && !pending && !disconnecting) {
      voiceNote("正在停止录制。");
      void stopTeachRecording(false);
    } else {
      voiceNote("当前不能停止示教录制。");
    }
    return;
  }
  if (phrase === "刷新动作库" || phrase === "动作库" || phrase === "查看动作库") {
    if (pressControl(button("teach-refresh"), "当前不能刷新动作库。")) voiceNote("正在刷新动作库…");
    return;
  }
  const replay = phrase.match(/^(?:回放|播放)(.+)$/);
  if (replay && snapshot.teachVersion === 1) {
    const matched = (snapshot.teachActions ?? []).find(item => normalizeVoice(item.name) === replay[1]);
    if (matched) {
      if (pending || disconnecting || moving() || motionFailed || teaching() || namingTeach) {
        voiceNote("现在不能回放自定义动作。请等机器人停稳。");
      } else {
        voiceNote(`正在回放自定义动作“${matched.name}”…`);
        void playTeachAction(matched);
      }
      return;
    }
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
  const direction = ({ 前进: "forward", 后退: "backward", 左转: "left", 右转: "right" } as Record<string, EmbodiedDirection>)[phrase];
  if (direction) {
    if (snapshot.classroomPulseVersion === 1 && requestedMode() === "walk") void startClassroom(direction);
    else jog(direction);
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
voiceCommand.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.repeat && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    runVoiceCommand(voiceCommand.value);
  }
});
button("voice-run").addEventListener("click", () => runVoiceCommand(voiceCommand.value));
button("class-trial-step").addEventListener("click", () => {
  if (voiceInput.active()) { voiceNote("请先结束或取消本次语音输入。"); return; }
  void startClassroom("trialForward");
});
button("vision-inspect-classroom").addEventListener("click", () => {
  if (voiceInput.active()) { voiceNote("请先结束或取消本次语音输入。"); return; }
  void vision.inspectTarget(inspectionTarget(voiceCommand.value));
});
button("listen-toggle").addEventListener("click", () => {
  const enabled = !(snapshot.listening && eventsRegistered);
  void request({ operation: "listen", enabled }, enabled ? "蓝牙消息监听已开启。" : "蓝牙消息监听已停止。");
});
button("clear-messages").addEventListener("click", clearMessages);
button("walk-mode").addEventListener("click", () => sendPostureCommand("walk"));
button("run-mode").addEventListener("click", () => sendPostureCommand("run"));
button("teach-start").addEventListener("click", () => { void startTeachRecording(); });
button("teach-stop").addEventListener("click", nameTeachRecording);
button("teach-save").addEventListener("click", () => { void saveTeachAction(); });
button("teach-discard").addEventListener("click", () => { void discardTeachRecording(); });
button("teach-refresh").addEventListener("click", () => { void refreshTeachList(); });
teachName.addEventListener("input", render);
teachName.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && !button("teach-save").disabled) button("teach-save").click();
});
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
  return stickHorizontal.lateral ? { vx, vyaw: 0, vy: horizontal } : { vx, vyaw: horizontal };
}
function padStep(direction: string): Motion {
  const { vx, vyaw } = moveVectors[direction];
  return stickVector(vx, vyaw);
}
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
function stopAllInput(force = false, note = "已请求停止移动。再次使用时请手动开启遥控。") {
  routePreview.clear();
  singlePulse?.finish(false);
  cancelHandshake?.();
  if (force) chatHandoff.clearPaused(note);
  const stoppingClassroom = !!classroom && !classroom.directionsOnly;
  cancelClassroom(note);
  if (!stoppingClassroom && vision.classroomActive()) vision.resetTracking();
  else if (!stoppingClassroom && force) vision.clearSnapshot();
  if (remote) {
    const wasMoving = !isZero(desiredMotion);
    endRemote(note);
    if (wasMoving) return;
  }
  if (!stoppingClassroom) stopInput(force);
}
button("stop-move").addEventListener("click", () => stopAllInput(true));
button("classroom-stop").addEventListener("click", () => {
  stopAllInput(true);
  voiceNote(snapshot.connected ? "已请求停止。" : "已停止当前课堂操作。");
});
function suspendClassroomForFocusLoss(note: string) {
  const task = classroom?.chat;
  // Ambiguity was reported only after a confirmed stop. Keep the question
  // without keeping a motion lease while the operator answers in main chat.
  if (task?.result.status === "awaitingChoice") task.paused = true;
  stopAllInput(false, note);
}
window.addEventListener("blur", () => {
  suspendClassroomForFocusLoss("Bumi 窗口已失去焦点。请确认机器人站稳后重新开启遥控。");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    suspendClassroomForFocusLoss("Bumi 窗口已隐藏。请确认机器人站稳后重新开启遥控。");
  }
});
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
