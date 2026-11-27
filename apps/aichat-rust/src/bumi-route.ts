import { invoke } from "@tauri-apps/api/core";
import { runWorkspaceCmd, type ClassroomFrameSource, type ClassroomPulseProfile } from "./bumi-classroom-vision";
import { maxFrameAge, parseEmbodiedTask, usableMotionFrame, type EmbodiedTask } from "./bumi-embodied";
import { commandSentence } from "./bumi-voice-commands";
import type { Snapshot } from "./bumi-control-types";
import { readSearchView, type ClassroomCamera } from "./bumi-vision";

const instructions = new Map([
  ["left", "左转"], ["right", "右转"], ["around", "转身向后"],
  ["faceTarget", "转向目标"], ["forward", "直走"], ["stop", "停下"],
]);

export function supportsRouteWalk(snapshot: Snapshot) {
  return snapshot.singleFramePulseDirectionsVersion === 1;
}

interface RouteControls {
  command: HTMLInputElement;
  enabled(): boolean;
  render(): void;
  voiceActive(): boolean;
  note(message: string): void;
  start(task: EmbodiedTask): void;
}

export function bindRouteControls({ command, enabled, render, voiceActive, note, start }: RouteControls) {
  const walk = document.getElementById("class-route-walk") as HTMLButtonElement;
  const preview = document.getElementById("voice-run") as HTMLButtonElement;
  const help = document.getElementById("class-route-plan-help")!;
  function approach(sentence: string) {
    const task = enabled() ? parseEmbodiedTask(sentence) : null;
    return task?.mode === "approach" && !task.gesture ? task : undefined;
  }
  function updateLabel() {
    preview.textContent = approach(commandSentence(command.value)) ? "预览走法" : "执行指令";
  }
  command.addEventListener("input", updateLabel);
  document.getElementById("class-route-plan")?.addEventListener("change", render);
  walk.addEventListener("click", () => {
    if (voiceActive()) { note("请先结束或取消本次语音输入。"); return; }
    const task = approach(commandSentence(command.value));
    if (!task) { note("请输入静物目标指令，例如「走到垃圾桶旁边」。"); return; }
    start(task);
  });
  function sync(supported: boolean, local: boolean, disabled: boolean) {
    updateLabel();
    help.textContent = supported
      ? "输入「走到垃圾桶旁边」。连接机器人，进入行走模式，开启摄像头，点「单图规划并行走」。也可先预览，再执行刚才的走法。"
      : "开启摄像头，输入「走到垃圾桶旁边」，点「预览走法」查看预计步数。";
    walk.hidden = !enabled() || !supported || !local;
    walk.disabled = walk.hidden || disabled;
  }
  return { approach, sync };
}

async function readLegacyDirections(camera: ClassroomCamera, target: string): Promise<string> {
  const { imageDataUrl, capturedAt } = await runWorkspaceCmd({ cmd: "takeCameraScreenshot" }, { camera });
  if (!camera.isCurrent()) throw new Error("本次规划已取消。");
  const forwardView = readSearchView() === "dominant" || (camera.source === "forward" && !camera.calibrated);
  const { visionPose } = await invoke<{ visionPose?: { directions?: unknown; directionSteps?: unknown } }>("bumi_control", {
    request: {
      operation: "locateVision", imageDataUrl,
      inspection: { target, calibratedFloor: !forwardView && camera.calibrated, directionsOnly: true },
      ...(forwardView ? { searchView: "dominant" } : {}),
    },
  });
  if (!camera.isCurrent()) throw new Error("本次规划已取消。");
  camera.showInputFrame(imageDataUrl, capturedAt);
  const steps = visionPose?.directions;
  if (!Array.isArray(steps) || steps.length > 10 || steps.some(step => !instructions.has(step))) {
    throw new Error("未收到有效路线。");
  }
  if (!steps.length) return "未识别到路线";
  const estimates = visionPose?.directionSteps;
  const counts = Array.isArray(estimates) && estimates.length === steps.length ? estimates : [];
  return steps.map((direction, index) => {
    const count = counts[index];
    if (direction === "forward" && Number.isSafeInteger(count) && count > 0) return `直走约 ${count} 步`;
    return instructions.get(direction);
  }).join(" → ");
}

type RouteDirection = "forward" | "left" | "right";
// Matches Pulse::for_profile in the native classroom controller.
const pulseDurationMs: Record<ClassroomPulseProfile, number> = { gentle: 400, standard: 800, strong: 1000 };
export const classroomSettleMs = 700;
interface PulseSegment { direction: RouteDirection; count: number }
interface PulsePlan {
  segments: PulseSegment[];
  summary: string;
  noRoute: boolean;
}
interface PulsePhoto {
  plan: PulsePlan;
  capturedAt: number;
  imageDataUrl: string;
}
interface CachedPhoto {
  photo: PulsePhoto;
  target: string;
  link: string;
  profile?: ClassroomPulseProfile;
  forwardView: boolean;
  matchesSource(): boolean;
}

export function createRoutePreviewCache() {
  let generation = 0;
  let entry: CachedPhoto | undefined;
  let timer: number | undefined;
  function clear() {
    generation++;
    entry = undefined;
    window.clearTimeout(timer);
    timer = undefined;
  }
  function beginPreview() {
    clear();
    const id = generation;
    return (preview: CachedPhoto) => {
      const now = Date.now();
      if (id !== generation || !usableMotionFrame(preview.photo.capturedAt, now)) return;
      entry = preview;
      timer = window.setTimeout(clear, preview.photo.capturedAt + maxFrameAge - now + 1);
    };
  }
  function take(target: string, link: string, profile: ClassroomPulseProfile | undefined, forwardView: boolean) {
    const previous = entry;
    clear();
    if (previous && previous.link === link && previous.target === target && previous.profile === profile &&
        previous.forwardView === forwardView && usableMotionFrame(previous.photo.capturedAt, Date.now()) &&
        previous.matchesSource()) return previous.photo;
    return undefined;
  }
  return { clear, beginPreview, take };
}
interface RouteContext {
  cache: ReturnType<typeof createRoutePreviewCache>;
  link: string;
}
interface PreviewContext extends RouteContext {
  profile?: ClassroomPulseProfile;
  local: boolean;
}

interface PulseReply {
  directions?: unknown;
  directionSteps?: unknown;
  pulseDirections?: unknown;
}
function readPulsePlan(reply?: PulseReply): PulsePlan {
  const segments: PulseSegment[] = [];
  const displayed = reply?.directions;
  const counts = reply?.directionSteps;
  const pulses = reply?.pulseDirections;
  const invalid = "未收到有效的单图动作序列。";
  if (!Array.isArray(pulses) || !Array.isArray(displayed) || !Array.isArray(counts) ||
      pulses.length > 10 || counts.length !== displayed.length) throw new Error(invalid);
  if (!displayed.length && !pulses.length) return { segments, summary: "未识别到路线", noRoute: true };
  if (displayed.length !== pulses.length + 1 || displayed[pulses.length] !== "stop" || counts[pulses.length] !== null) {
    throw new Error(invalid);
  }
  let total = 0;
  for (const [i, part] of pulses.entries()) {
    if (!part || !["left", "right", "forward"].includes(part.direction) ||
        !Number.isSafeInteger(part.count) || part.count < 1 || total + part.count > 10 ||
        displayed[i] !== part.direction || counts[i] !== part.count) throw new Error(invalid);
    total += part.count;
    segments.push({ direction: part.direction, count: part.count });
  }
  const labels = segments.map(({ direction, count }) =>
    `${instructions.get(direction)} ${count} ${direction === "forward" ? "步" : "次"}`);
  return { segments, summary: [...labels, "停下"].join(" → "), noRoute: false };
}

const isForwardView = (camera: ClassroomCamera) => camera.source === "forward" || readSearchView() === "dominant";
async function photographDirections(camera: ClassroomCamera, target: string, forwardView: boolean): Promise<PulsePhoto> {
  const { imageDataUrl, capturedAt } = await runWorkspaceCmd({ cmd: "takeCameraScreenshot" }, { camera });
  if (!camera.isCurrent()) throw new Error("本次规划已取消。");
  const { visionPose } = await invoke<{ visionPose?: PulseReply }>("bumi_control", {
    request: { operation: "locateVision", imageDataUrl,
      inspection: { target, directionsOnly: true, pulseDirections: true, calibratedFloor: false },
      ...(forwardView ? { searchView: "dominant" } : {}),
    },
  });
  if (!camera.isCurrent() || isForwardView(camera) !== forwardView) throw new Error("摄像头或寻找视角已变化。");
  camera.showInputFrame(imageDataUrl, capturedAt);
  return { plan: readPulsePlan(visionPose), capturedAt, imageDataUrl };
}

export async function planDirections(camera: ClassroomCamera, target: string, context?: PreviewContext): Promise<string> {
  if (!context) return readLegacyDirections(camera, target);
  const publish = context.cache.beginPreview();
  const forwardView = isForwardView(camera);
  const photo = await photographDirections(camera, target, forwardView);
  if (context.local && context.link) {
    publish({ photo, target, link: context.link, profile: context.profile, forwardView, matchesSource: camera.matchesSource });
  }
  return photo.plan.summary;
}

export async function executeSingleFrameRoute(current: () => ClassroomFrameSource, target: string,
  pulse: (direction: RouteDirection, checkFrame: () => void) => Promise<void>, say: (message: string) => void,
  profile: ClassroomPulseProfile | undefined, context: RouteContext): Promise<string> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("请先开启摄像头。");
  const forwardView = isForwardView(camera);
  let photo = context.cache.take(target, context.link, profile, forwardView);
  if (photo) {
    camera.showInputFrame(photo.imageDataUrl, photo.capturedAt);
  } else {
    say("正在用当前照片规划走法…");
    photo = await photographDirections(camera, target, forwardView);
  }
  current();
  const { plan, capturedAt } = photo;
  if (!usableMotionFrame(capturedAt, Date.now())) throw new Error("单图走法已过期，请重新规划。");
  if (plan.noRoute) throw new Error(plan.summary);
  if (!plan.segments.length) return "画面显示已在目标旁。";
  const total = plan.segments.reduce((sum, part) => sum + part.count, 0);
  const scheduledStepMs = pulseDurationMs[profile ?? "gentle"] + classroomSettleMs;
  let done = 0;
  for (const part of plan.segments) {
    for (let i = 0; i < part.count; i++) {
      // Only completed pulses and their normal settling time extend the original photo's deadline.
      const deadline = capturedAt + maxFrameAge + done * scheduledStepMs;
      const checkFrame = () => {
        if (current() !== run || !camera.isCurrent() || isForwardView(camera) !== forwardView) {
          throw new Error("单图行走任务或摄像头已变化。");
        }
        const now = Date.now();
        if (!(now >= capturedAt && now <= deadline)) throw new Error(`已执行 ${done}/${total} 次点动，照片已过期。请重新规划。`);
      };
      checkFrame();
      say(`${plan.summary} · 正在${instructions.get(part.direction)}（${done + 1}/${total}）`);
      await pulse(part.direction, checkFrame);
      done++;
    }
  }
  current();
  return `已执行：${plan.summary}。`;
}
