import { invoke } from "@tauri-apps/api/core";
import { defaultSceneConfidence, maxFrameAge, usableMotionFrame, recognitionDelayMessage, validPoint, verifyDominantGroundShift, verifyWalkDisplacement, type CountedWalk, type EmbodiedCalibration,
  type EmbodiedObservation, type WalkPose } from "./bumi-embodied";
import { readSearchView, type ClassroomCamera, type ClassroomInspection, type WalkIssueMarker } from "./bumi-vision";
interface CameraScreenshot {
  imageDataUrl: string;
  capturedAt: number;
}
interface VisionTiming { headers: number; body: number }
function timingDetail(timing?: VisionTiming): string {
  if (!timing || !Number.isSafeInteger(timing.headers) || !Number.isSafeInteger(timing.body)
    || timing.headers < 0 || timing.body < 0) return "";
  return `发出请求到收到响应头 ${(timing.headers / 1000).toFixed(2)} 秒，接收结果 ${(timing.body / 1000).toFixed(2)} 秒。`;
}
interface ClassroomCameraSource {
  camera?: ClassroomCamera;
  frame?: Promise<CameraScreenshot>;
}
export interface ClassroomFrameSource extends ClassroomCameraSource {
  calibration: EmbodiedCalibration;
  automaticWalkClearance: boolean;
  walkFloorScale: boolean;
  supportsSearchView: boolean;
  frames: number;
  motionFrameAt?: number;
}

// Both the main-chat screenshot tool and the foreground navigation loop dispatch
// this command against the classroom's leased camera, including on every recheck.
export function runWorkspaceCmd(request: { cmd: "takeCameraScreenshot" }, source: ClassroomCameraSource): Promise<CameraScreenshot> {
  if (request.cmd !== "takeCameraScreenshot") throw new Error("不支持该课堂摄像头命令。");
  const camera = source.camera;
  if (!camera?.isCurrent()) throw new Error("课堂摄像头未就绪或已更换。");
  // Concurrent readers share only an in-flight exposure and its timestamp.
  source.frame ??= camera.captureFreshFrame().then(imageDataUrl => {
    if (!camera.isCurrent()) throw new Error("课堂摄像头已更换。");
    return { imageDataUrl, capturedAt: Date.now() };
  }).finally(() => { source.frame = undefined; });
  return source.frame;
}

export async function recognizeFresh<T>(current: () => ClassroomFrameSource,
  recognize: (image: string) => Promise<{ result: T; timingMs?: VisionTiming }>,
  options: { after?: number; stopReason?: (result: T) => string | undefined;
    stopMarker?: (result: T) => WalkIssueMarker | undefined } = {}) {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("课堂摄像头未就绪。");
  run.motionFrameAt = undefined;
  const checkOwner = () => {
    if (current() !== run || !camera.isCurrent() || run.camera !== camera) throw new Error("课堂任务或摄像头已变化。");
  };
  const requested = Date.now();
  let frame: CameraScreenshot | undefined;
  let marker: WalkIssueMarker | undefined;
  try {
    frame = await runWorkspaceCmd({ cmd: "takeCameraScreenshot" }, run);
    checkOwner();
    const captured = frame.capturedAt;
    if (!Number.isFinite(captured) || captured < requested || captured > Date.now()) {
      throw new Error("摄像头画面的拍摄时间异常，请确认预览在更新后重试。");
    }
    if (options.after !== undefined && captured <= options.after) throw new Error("摄像头没有提供更新的画面，请检查预览后重试。");
    const { result, timingMs } = await recognize(frame.imageDataUrl);
    checkOwner();
    const now = Date.now();
    if (now < captured) throw new Error("摄像头画面的拍摄时间异常，请检查系统时间后重试。");
    const reason = options.stopReason?.(result);
    if (reason || !usableMotionFrame(captured, now)) {
      if (reason && usableMotionFrame(captured, now)) marker = options.stopMarker?.(result);
      const timing = recognitionDelayMessage(now - captured) + timingDetail(timingMs);
      const deadline = now - captured > maxFrameAge ? `超过 ${maxFrameAge / 1000} 秒的行走识别时限。` : "";
      throw new Error(timing + deadline + (reason ? reason + " " : "") +
        (marker ? "位置已标在「本次通路判断」中。" : "可查看本次识别原图。"));
    }
    run.motionFrameAt = captured;
    return { ...frame, result };
  } catch (cause) {
    checkOwner();
    if (frame) camera.showInputFrame(frame.imageDataUrl, frame.capturedAt, marker);
    else camera.clearObservation(true);
    throw cause;
  }
}

export type ClassroomPulseProfile = "gentle" | "standard" | "strong";

// Only convert measurements entered by the operator. This control never issues a pulse.
function bindPulseEstimate() {
  const input = (name: string) => document.getElementById("class-estimate-" + name) as HTMLInputElement;
  const direction = document.getElementById("class-estimate-direction") as HTMLSelectElement;
  const count = input("count"), total = input("total");
  const apply = document.getElementById("class-estimate-apply") as HTMLButtonElement;
  const result = document.getElementById("class-estimate-result")!;
  const unit = document.getElementById("class-estimate-unit")!;
  const turning = () => direction.value === "left" || direction.value === "turn";
  function reset() {
    total.value = "";
    result.textContent = "";
    unit.textContent = turning() ? "累计转角（度）" : "总位移（厘米）";
  }
  direction.addEventListener("change", reset);
  function average(): number | string {
    const pulses = Number(count.value);
    const sum = Number(total.value);
    if (!Number.isSafeInteger(pulses) || pulses < 1 || !Number.isFinite(sum) || sum <= 0) {
      return "请填写实际点动次数（正整数），以及大于零的累计测量值。";
    }
    const angle = turning();
    const mean = sum / pulses / (angle ? 1 : 100);
    if (angle ? mean < 0.1 || mean > 179 : mean < 0.001 || mean > 100) {
      return angle ? "平均转角须在 0.1 到 179 度之间，请核对次数和累计转角。"
        : "平均步幅超出范围，请核对次数和总位移（厘米）。";
    }
    return Number(mean.toFixed(angle ? 1 : 3));
  }
  const describe = (value: number) => {
    const name = { step: "前进", backward: "后退", left: "左转", turn: "右转" }[direction.value];
    return `${name}一次约 ${value} ${turning() ? "度" : "米"}`;
  };
  for (const control of [count, total]) control.addEventListener("input", () => {
    const value = average();
    result.textContent = typeof value === "number" ? `预计${describe(value)}` : "";
  });
  apply.addEventListener("click", () => {
    if (apply.disabled) return;
    const value = average();
    if (typeof value === "string") {
      result.textContent = value;
      return;
    }
    const target = document.getElementById("class-" + direction.value) as HTMLInputElement;
    target.value = String(value);
    result.textContent = `已填入${describe(value)}。`;
  });
  return { reset, setBusy(busy: boolean) { direction.disabled = apply.disabled = busy; } };
}

export function createPulseSettings() {
  const select = document.getElementById("class-pulse-profile") as HTMLSelectElement | null;
  const field = document.getElementById("class-pulse-setting");
  const estimate = bindPulseEstimate();
  let measuredFor: string | undefined;
  const selected = (): ClassroomPulseProfile => select?.value === "gentle" || select?.value === "strong" ? select.value : "standard";
  const clearMeasurements = () => {
    estimate.reset();
    for (const id of ["class-step", "class-backward", "class-left", "class-turn"]) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) input.value = "";
    }
  };
  select?.addEventListener("change", clearMeasurements);
  return {
    request(version?: number): {pulseProfile?: ClassroomPulseProfile} {
      return version === 1 ? {pulseProfile: selected()} : {};
    },
    sync(device: string | undefined, version: number | undefined, busy: boolean) {
      const supported = version === 1;
      if (field) field.hidden = !supported;
      if (select) select.disabled = !supported || busy;
      estimate.setBusy(busy);
      if (!device) return;
      const key = JSON.stringify([device, supported]);
      if (measuredFor !== undefined && measuredFor !== key) clearMeasurements();
      measuredFor = key;
    },
  };
}

function readOptionalNumber(id: string): number | undefined {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el?.validity?.badInput) return NaN;
  const raw = el?.value.trim() ?? "";
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function dominantRequest(): { searchView: "dominant" } | Record<string, never> {
  return readSearchView() === "dominant" ? { searchView: "dominant" } : {};
}

export function readCalibration(calibratedCamera = false): EmbodiedCalibration {
  const widthM = readOptionalNumber("class-width");
  const heightM = readOptionalNumber("class-height");
  const stepM = readOptionalNumber("class-step");
  const backwardM = readOptionalNumber("class-backward");
  const leftDeg = readOptionalNumber("class-left");
  const turnDeg = readOptionalNumber("class-turn");
  const rawGreeting = readOptionalNumber("class-greeting");
  const greetingM = rawGreeting !== undefined && Number.isFinite(rawGreeting) && rawGreeting > 0 ? rawGreeting : 0.8;
  const hasFloor = readSearchView() !== "dominant" && calibratedCamera
    && widthM !== undefined && heightM !== undefined;
  return {
    auto: !(hasFloor && stepM !== undefined),
    ...(hasFloor ? { widthM, heightM } : {}),
    stepM, backwardM, turnDeg, leftDeg, greetingM,
  };
}

export async function observeClassroom(current: () => ClassroomFrameSource, target: string,
  estimates?: Pick<EmbodiedCalibration, "stepM" | "backwardM">): Promise<EmbodiedObservation> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("请先开启教室摄像头，等画面出现后再观察目标。");
  const dominant = readSearchView() === "dominant";
  try {
    const { auto, widthM, heightM, greetingM, minConfidence = defaultSceneConfidence } = run.calibration;
    const { stepM, backwardM } = estimates ?? run.calibration;
    const sceneScale = auto
      ? {
          auto: true,
          calibratedFloor: dominant ? false : camera.calibrated,
          greetingM,
          ...(stepM ? { stepM } : {}),
          ...(backwardM ? { backwardM } : {}),
        }
      : {
          widthM: widthM as number,
          heightM: heightM as number,
          greetingM,
          stepM: stepM as number,
          ...(backwardM ? { backwardM } : {}),
        };
    const { imageDataUrl, capturedAt, result } = await recognizeFresh(current, async image => {
      const next = await invoke<{ visionPose?: { scene?: EmbodiedObservation; timingMs?: VisionTiming } }>("bumi_control", { request: {
        operation: "locateVision", imageDataUrl: image, sceneTarget: target,
        sceneScale: minConfidence === defaultSceneConfidence ? sceneScale : { ...sceneScale, minConfidence },
        ...dominantRequest(),
      } });
      if (!next.visionPose?.scene) throw new Error("桌面视觉接口没有返回课堂观察结果。");
      return { result: next.visionPose.scene, timingMs: next.visionPose.timingMs };
    }, { stopReason: scene => {
      if (scene.status === "ambiguous" || (scene.status === "ready" && scene.pathClear === true)) return undefined;
      if (dominant && scene.status === "lost") return undefined;
      const fallback = { lost: "未找到目标", uncertain: "无法可靠识别现场",
        blocked: "通路受阻", ready: "未能确认通路畅通" };
      return scene.reason || fallback[scene.status] || "无法可靠识别现场";
    } });
    current();
    const scene = { ...result, capturedAt, frameId: ++run.frames, ...(dominant ? { searchView: "dominant" as const } : {}) };
    camera.showObservation(target, scene, imageDataUrl, minConfidence);
    return scene;
  } catch (cause) {
    camera.clearObservation();
    throw cause;
  }
}

interface WalkPath extends WalkPose {
  clear: boolean;
  reason?: string;
  issueKind?: WalkIssueMarker["kind"] | "uncertain";
  issuePoint?: WalkIssueMarker["point"];
}
interface WalkFrame extends WalkPath { capturedAt: number; frameId: number }

export async function observeWalkPath(current: () => ClassroomFrameSource, direction: CountedWalk["direction"],
  previous?: WalkFrame, needsAnotherStep = true): Promise<WalkFrame> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("连续点动前，请开启教室摄像头。");
  const backward = direction === "backward";
  const stepM = backward ? run.calibration.backwardM : run.calibration.stepM;
  if (stepM === undefined && !run.automaticWalkClearance) {
    throw new Error(`当前桌面宿主需要${backward ? "后退" : "前进"}步幅。请填写当前档位的一步距离，或分次发出单步指令。`);
  }
  if (stepM !== undefined && (!Number.isFinite(stepM) || stepM <= 0 || stepM > 100)) {
    throw new Error("当前步幅超出范围。");
  }
  const forwardCamera = camera.source === "forward" && !camera.calibrated;
  if (forwardCamera && !run.supportsSearchView) {
    throw new Error("当前桌面宿主无法用机载前摄核对连续步数，请选择固定教室摄像头。");
  }
  const dominant = forwardCamera || readSearchView() === "dominant";
  const { widthM, heightM } = run.calibration;
  const floorSizeM = run.walkFloorScale && camera.calibrated && !dominant &&
    widthM !== undefined && widthM > 0 && widthM <= 1000 &&
    heightM !== undefined && heightM > 0 && heightM <= 1000
    ? { width: widthM, depth: heightM } : undefined;
  try {
    const { imageDataUrl, capturedAt, result: path } = await recognizeFresh(current, async image => {
      const next = await invoke<{ visionPose?: { walkPath?: WalkPath; timingMs?: VisionTiming } }>("bumi_control", { request: {
        operation: "locateVision", imageDataUrl: image,
        walkPath: {
          direction, ...(stepM !== undefined ? { stepM } : {}), calibratedFloor: dominant ? false : camera.calibrated,
          ...(floorSizeM ? { floorSizeM } : {}),
          ...(dominant && previous ? { priorAnchor: { x: previous.robot.x, y: previous.robot.y } } : {}),
        },
        ...(dominant ? { searchView: "dominant" } : {}),
      } });
      const path = next.visionPose?.walkPath;
      if (!path || !validPoint(path.robot) || !validPoint(path.headingPoint)
        || Math.hypot(path.robot.x - path.headingPoint.x, path.robot.y - path.headingPoint.y) < 0.005) {
        throw new Error(dominant ? "无法确认主导视角中的地面参照或前进方向。" : "无法确认机器人双脚位置或机身朝向。");
      }
      if (previous) {
        if (dominant) verifyDominantGroundShift(direction, previous, path);
        else verifyWalkDisplacement(direction, previous, path, run.calibration, stepM);
      }
      return { result: path, timingMs: next.visionPose?.timingMs };
    }, {
      after: previous?.capturedAt,
      stopReason: path => needsAnotherStep && (path.clear !== true || path.issueKind != null)
        ? path.reason || `无法确认机器人${backward ? "后方" : "前方"}有足够的行走净空。` : undefined,
      stopMarker: path => (path.issueKind === "obstacle" || path.issueKind === "occluded") && validPoint(path.issuePoint)
        ? { kind: path.issueKind, point: path.issuePoint } : undefined,
    });
    current();
    if (dominant) camera.showInputFrame(imageDataUrl, capturedAt);
    else camera.showInspection("", { robot: path.robot, headingPoint: path.headingPoint, capturedAt }, imageDataUrl);
    return { ...path, capturedAt, frameId: ++run.frames };
  } catch (cause) {
    camera.clearObservation();
    throw cause;
  }
}

export async function inspectClassroom(camera: ClassroomCamera, target: string): Promise<string> {
  const { imageDataUrl, capturedAt } = await runWorkspaceCmd({ cmd: "takeCameraScreenshot" }, { camera });
  const result = await invoke<{ visionPose?: { inspection?: Omit<ClassroomInspection, "capturedAt"> & { reason?: string };
    timingMs?: VisionTiming } }>(
    "bumi_control", { request: { operation: "locateVision", imageDataUrl, inspection: { target, calibratedFloor: readSearchView() === "dominant" ? false : camera.calibrated }, ...dominantRequest() } },
  );
  if (!camera.isCurrent()) throw new Error("摄像头已变化，请重新识别。");
  const marks = result.visionPose?.inspection;
  if (!marks) throw new Error("视觉接口没有返回这次标记结果。");
  camera.showInspection(target, { ...marks, capturedAt }, imageDataUrl);
  const elapsed = Math.max(0, Date.now() - capturedAt);
  const timing = `从拍摄到识别返回用时 ${(elapsed / 1000).toFixed(2)} 秒。` + timingDetail(result.visionPose?.timingMs);
  if (marks.robot && marks.target) return `已识别小布米和“${target}”。` + timing;
  const found = marks.robot ? "只识别到小布米。" : marks.target ? `只识别到“${target}”。` : "未识别到可确认的位置。";
  return found + (marks.reason ? marks.reason + " " : "") + timing;
}

export interface WalkContinueVerdict { proceed: boolean; reason?: string; capturedAt: number }

// After a settled forward pulse, capture one fresh frame from the camera in use
// and let the model decide whether another forward pulse is reasonable. The
// passive view is the fixed classroom camera; the dominant view is the robot's
// own forward camera. A "continue" verdict leaves a fresh motion frame behind.
export async function observeWalkContinue(current: () => ClassroomFrameSource, after?: number): Promise<WalkContinueVerdict> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("请先开启摄像头，再让 AI 判断是否继续行走。");
  // When using the built-in forward box camera (uncalibrated) or explicit dominant view,
  // treat the frame as the robot's forward view; otherwise use the fixed classroom camera view.
  const dominant = readSearchView() === "dominant" || (camera.source === "forward" && !camera.calibrated);
  const stepM = run.calibration.stepM;
  try {
    const { imageDataUrl, capturedAt, result } = await recognizeFresh(current, async image => {
      const next = await invoke<{ visionPose?: { walkContinue?: { continue?: unknown; reason?: string }; timingMs?: VisionTiming } }>(
        "bumi_control", { request: {
          operation: "locateVision", imageDataUrl: image,
          walkContinue: { calibratedFloor: dominant ? false : camera.calibrated, ...(stepM && stepM > 0 ? { stepM } : {}) },
          ...(dominant ? { searchView: "dominant" as const } : {}),
        } });
      const verdict = next.visionPose?.walkContinue;
      if (!verdict || typeof verdict.continue !== "boolean") throw new Error("视觉接口没有返回是否继续行走的判断。");
      return { result: { proceed: verdict.continue, reason: typeof verdict.reason === "string" ? verdict.reason : undefined },
        timingMs: next.visionPose?.timingMs };
    }, { after });
    current();
    ++run.frames;
    camera.showInputFrame(imageDataUrl, capturedAt);
    if (!result.proceed) run.motionFrameAt = undefined;
    return { ...result, capturedAt };
  } catch (cause) {
    camera.clearObservation();
    throw cause;
  }
}
