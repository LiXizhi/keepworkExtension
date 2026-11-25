import { invoke } from "@tauri-apps/api/core";
import { defaultSceneConfidence, maxFrameAge, usableMotionFrame, recognitionDelayMessage, validPoint, verifyWalkDisplacement, type CountedWalk, type EmbodiedCalibration,
  type EmbodiedObservation, type WalkPose } from "./bumi-embodied";
import type { ClassroomCamera, ClassroomInspection } from "./bumi-vision";
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

async function recognizeFresh<T>(current: () => ClassroomFrameSource,
  recognize: (image: string) => Promise<{ result: T; timingMs?: VisionTiming }>,
  options: { after?: number; stopReason?: (result: T) => string | undefined } = {}) {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("课堂摄像头未就绪。");
  run.motionFrameAt = undefined;
  const checkOwner = () => {
    if (current() !== run || !camera.isCurrent() || run.camera !== camera) throw new Error("课堂任务或摄像头已变化。");
  };
  const requested = Date.now();
  let frame: CameraScreenshot | undefined;
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
      const timing = recognitionDelayMessage(now - captured) + timingDetail(timingMs);
      const deadline = now - captured > maxFrameAge ? `超过 ${maxFrameAge / 1000} 秒的行走识别时限。` : "";
      throw new Error(timing + deadline + (reason ? reason + " " : "") + "可查看本次识别原图。");
    }
    run.motionFrameAt = captured;
    return { ...frame, result };
  } catch (cause) {
    checkOwner();
    if (frame) camera.showInputFrame(frame.imageDataUrl, frame.capturedAt);
    else camera.clearObservation(true);
    throw cause;
  }
}

export type ClassroomPulseProfile = "gentle" | "standard" | "strong";
export function createPulseSettings() {
  const select = document.getElementById("class-pulse-profile") as HTMLSelectElement | null;
  const field = document.getElementById("class-pulse-setting");
  let measuredFor: string | undefined;
  const selected = (): ClassroomPulseProfile => select?.value === "gentle" || select?.value === "strong" ? select.value : "standard";
  const clearMeasurements = () => {
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
      if (!device) return;
      const key = JSON.stringify([device, supported]);
      if (measuredFor !== undefined && measuredFor !== key) clearMeasurements();
      measuredFor = key;
    },
  };
}

function readOptionalNumber(id: string): number | undefined {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const raw = el?.value.trim() ?? "";
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
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
  const hasManual = calibratedCamera
    && widthM !== undefined && heightM !== undefined && stepM !== undefined && turnDeg !== undefined;
  if (hasManual) {
    return {
      auto: false, widthM, heightM, stepM, turnDeg, greetingM,
      ...(backwardM !== undefined ? { backwardM } : {}),
      ...(leftDeg !== undefined ? { leftDeg } : {}),
    };
  }
  return {
    auto: true,
    greetingM,
    ...(stepM !== undefined && stepM > 0 ? { stepM } : {}),
    ...(backwardM !== undefined && backwardM > 0 ? { backwardM } : {}),
    ...(turnDeg !== undefined && turnDeg > 0 && turnDeg < 180 ? { turnDeg } : {}),
    ...(leftDeg !== undefined && leftDeg > 0 && leftDeg < 180 ? { leftDeg } : {}),
  };
}

export async function observeClassroom(current: () => ClassroomFrameSource, target: string,
  estimates?: Pick<EmbodiedCalibration, "stepM" | "backwardM">): Promise<EmbodiedObservation> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("请先开启教室摄像头，等画面出现后再观察目标。");
  try {
    const { auto, widthM, heightM, greetingM, minConfidence = defaultSceneConfidence } = run.calibration;
    const { stepM, backwardM } = estimates ?? run.calibration;
    const sceneScale = auto
      ? {
          auto: true,
          calibratedFloor: camera.calibrated,
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
      } });
      if (!next.visionPose?.scene) throw new Error("桌面视觉接口没有返回课堂观察结果。");
      return { result: next.visionPose.scene, timingMs: next.visionPose.timingMs };
    }, { stopReason: scene => {
      if (scene.status === "ambiguous" || (scene.status === "ready" && scene.pathClear === true)) return undefined;
      const fallback = { lost: "未找到目标", uncertain: "无法可靠识别现场",
        blocked: "通路受阻", ready: "未能确认通路畅通" };
      return scene.reason || fallback[scene.status] || "无法可靠识别现场";
    } });
    current();
    const scene = { ...result, capturedAt, frameId: ++run.frames };
    camera.showObservation(target, scene, imageDataUrl, minConfidence);
    return scene;
  } catch (cause) {
    camera.clearObservation();
    throw cause;
  }
}

interface WalkPath extends WalkPose { clear: boolean; reason?: string }
interface WalkFrame extends WalkPath { capturedAt: number; frameId: number }

export async function observeWalkPath(current: () => ClassroomFrameSource, direction: CountedWalk["direction"],
  previous?: WalkFrame, needsAnotherStep = true): Promise<WalkFrame> {
  const run = current();
  const camera = run.camera;
  if (!camera) throw new Error("连续点动前，请开启教室摄像头。");
  const backward = direction === "backward";
  const stepM = backward ? run.calibration.backwardM : run.calibration.stepM;
  if (!stepM || !Number.isFinite(stepM) || stepM <= 0 || stepM > 100) {
    throw new Error(`请先填写当前档位${backward ? "后退" : "前进"}一步的实测距离，再连续走多步。`);
  }
  try {
    const { imageDataUrl, capturedAt, result: path } = await recognizeFresh(current, async image => {
      const next = await invoke<{ visionPose?: { walkPath?: WalkPath; timingMs?: VisionTiming } }>("bumi_control", { request: {
        operation: "locateVision", imageDataUrl: image, walkPath: { direction, stepM, calibratedFloor: camera.calibrated },
      } });
      const path = next.visionPose?.walkPath;
      if (!path || !validPoint(path.robot) || !validPoint(path.headingPoint)
        || Math.hypot(path.robot.x - path.headingPoint.x, path.robot.y - path.headingPoint.y) < 0.005) {
        throw new Error("无法确认机器人双脚位置或机身朝向。");
      }
      if (previous) verifyWalkDisplacement(direction, previous, path, run.calibration, stepM);
      if (needsAnotherStep && path.clear !== true) {
        throw new Error(path.reason || `无法确认机器人${backward ? "后方" : "前方"}有一个实测步幅的净空。`);
      }
      return { result: path, timingMs: next.visionPose?.timingMs };
    }, { after: previous?.capturedAt });
    current();
    camera.showInspection("", { robot: path.robot, headingPoint: path.headingPoint, capturedAt }, imageDataUrl);
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
    "bumi_control", { request: { operation: "locateVision", imageDataUrl, inspection: { target, calibratedFloor: camera.calibrated } } },
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
