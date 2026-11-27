import { defaultSceneConfidence, sceneConfidenceAccepted, validSceneConfidenceThreshold, type EmbodiedObservation } from "./bumi-embodied";

// Classroom recognition consumes individual camera exposures. Previewing the
// camera and calibrating the floor are local operations.
export interface Point2D {
  x: number;
  y: number;
}

/** Floor corners in normalized camera coordinates, clockwise from the preview's top left. */
export type FloorQuad = [Point2D, Point2D, Point2D, Point2D];

export type Matrix3x3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface ClassroomInspection {
  robot?: Point2D;
  headingPoint?: Point2D;
  target?: Point2D;
  /** Endpoints of forward segments, ending at the planned stop. Same coordinates as robot. */
  route?: Point2D[];
  capturedAt: number;
}

export interface WalkIssueMarker {
  point: Point2D;
  kind: "obstacle" | "occluded";
}

export interface ClassroomCamera {
  readonly calibrated: boolean;
  readonly source?: "classroom" | "forward";
  captureFreshFrame(): Promise<string>;
  showObservation(target: string, scene: EmbodiedObservation, imageDataUrl?: string, minConfidence?: number): void;
  showInspection(target: string, result: ClassroomInspection, imageDataUrl: string): void;
  showInputFrame(imageDataUrl: string, capturedAt: number, issue?: WalkIssueMarker): void;
  clearObservation(clearSnapshot?: boolean): void;
  isCurrent(): boolean;
  matchesSource(): boolean;
  release(): void;
}

type CalibratedCamera = { deviceId: string; width: number; height: number };
type CameraView = CanvasImageSource & { videoWidth: number; videoHeight: number };
const BOX_CAMERA_ID = "xiaozhi-box";

interface BoxCameraChoice { label: string }
interface BoxCameraHost {
  current?: () => BoxCameraChoice | null;
  open?: (onFrame: (jpegBase64: string) => void, onEnded: (reason: string) => void) => Promise<() => void>;
}

export type SearchView = "passive" | "dominant";

interface VisionConfig {
  quad: FloorQuad;
  calibratedCamera?: CalibratedCamera;
  mirror: boolean;
  minSceneConfidence: number;
  searchView: SearchView;
  walkContinue: boolean;
}

interface ClassroomVisionBridge {
  onTrackingReset?(): void;
  inspectClassroom?(camera: ClassroomCamera, target: string): Promise<string>;
  canInspectClassroom?(): boolean | string;
  inspectionTarget?(): string;
}

const CALIBRATION_KEY = "keepwork.bumi.vision-calibration.v1";
const MARKER_MAX_AGE_MS = 5000;
const MAX_CAMERA_LONG_EDGE = 1280;
const MAX_IMAGE_DATA_URL_LEN = 700_000; // Also enforced by the native vision endpoint.
const cornerNames = ["左上", "右上", "右下", "左下"];

export const DEFAULT_FLOOR_QUAD: FloorQuad = [
  { x: 0.22, y: 0.20 },
  { x: 0.78, y: 0.20 },
  { x: 0.90, y: 0.86 },
  { x: 0.10, y: 0.86 },
];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function validPoint(point: unknown): point is Point2D {
  return !!point && typeof point === "object"
    && typeof (point as Point2D).x === "number" && Number.isFinite((point as Point2D).x)
    && typeof (point as Point2D).y === "number" && Number.isFinite((point as Point2D).y)
    && (point as Point2D).x >= 0 && (point as Point2D).x <= 1
    && (point as Point2D).y >= 0 && (point as Point2D).y <= 1;
}

function validFloorQuad(quad: FloorQuad): boolean {
  const turns = quad.map((a, i) => {
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  return turns.every(turn => turn > 0.0001) || turns.every(turn => turn < -0.0001);
}

function storedConfig(): Record<string, unknown> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CALIBRATION_KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  } catch { /* Camera operation does not require persistent storage. */ }
  return {};
}

export function readSearchView(): SearchView {
  const setting = document.getElementById("vision-search-setting");
  const select = document.getElementById("vision-search-view") as HTMLSelectElement | null;
  // Hidden means this host does not advertise the switch. A disabled control can
  // still be the active choice while a classroom task is running.
  if (!select || setting?.hidden !== false) return "passive";
  return select.value === "dominant" ? "dominant" : "passive";
}

export function loadVisionConfig(): VisionConfig {
  const candidate = storedConfig() as Partial<VisionConfig>;
  const config: VisionConfig = {
    quad: DEFAULT_FLOOR_QUAD.map(point => ({ ...point })) as FloorQuad,
    mirror: candidate.mirror === true,
    minSceneConfidence: validSceneConfidenceThreshold(candidate.minSceneConfidence) ? candidate.minSceneConfidence : defaultSceneConfidence,
    searchView: candidate.searchView === "dominant" ? "dominant" : "passive",
    walkContinue: candidate.walkContinue !== false,
  };
  if (Array.isArray(candidate.quad) && candidate.quad.length === 4 && candidate.quad.every(validPoint) && validFloorQuad(candidate.quad)) {
    config.quad = candidate.quad;
    const camera = candidate.calibratedCamera;
    if (camera && typeof camera.deviceId === "string" && camera.deviceId
      && Number.isInteger(camera.width) && camera.width > 0 && Number.isInteger(camera.height) && camera.height > 0) {
      config.calibratedCamera = { deviceId: camera.deviceId, width: camera.width, height: camera.height };
    }
  }
  return config;
}

export function saveVisionConfig(config: VisionConfig): void {
  try {
    const saved = storedConfig();
    // Legacy provider configuration may contain credentials. Only the signed-in
    // desktop service handles recognition, so never persist those fields again.
    for (const name of ["vlmPreset", "vlmEndpoint", "vlmModel", "apiKey"]) delete saved[name];
    window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify({
      ...saved, quad: config.quad, mirror: config.mirror, minSceneConfidence: config.minSceneConfidence,
      searchView: config.searchView === "dominant" ? "dominant" : "passive",
      walkContinue: config.walkContinue !== false,
      calibratedCamera: config.calibratedCamera?.deviceId ? config.calibratedCamera : undefined,
    }));
  } catch { /* Keep session calibration in memory. */ }
}

/**
 * Solves 3x3 projective homography mapping `src[i]` -> `dst[i]` via DLT + Gaussian elimination.
 */
export function solveHomography(
  src: readonly [Point2D, Point2D, Point2D, Point2D],
  dst: readonly [Point2D, Point2D, Point2D, Point2D],
): Matrix3x3 | null {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;
    rows.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, dx]);
    rows.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, dy]);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const swap = rows[col];
      rows[col] = rows[pivot];
      rows[pivot] = swap;
    }
    const divisor = rows[col][col];
    for (let j = col; j <= n; j++) rows[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return [
    rows[0][n], rows[1][n], rows[2][n],
    rows[3][n], rows[4][n], rows[5][n],
    rows[6][n], rows[7][n], 1,
  ];
}

export function projectPoint(h: Matrix3x3, point: Point2D): Point2D | null {
  const w = h[6] * point.x + h[7] * point.y + h[8];
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / w,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / w,
  };
}

const unitFloor: FloorQuad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

export function buildFloorToImageHomography(quad: FloorQuad): Matrix3x3 | null {
  return solveHomography(unitFloor, quad);
}

// Manual calibration on a mirrored preview reverses the corner winding.
function classroomCorners(quad: FloorQuad): FloorQuad {
  const [a, b, c, d] = quad;
  const winding = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  return winding < 0 ? [b, a, d, c] : quad;
}

function classroomRawRect(side: number, videoWidth: number, videoHeight: number) {
  const scale = Math.min(side / videoWidth, side / videoHeight);
  const w = Math.max(1, Math.round(videoWidth * scale)), h = Math.max(1, Math.round(videoHeight * scale));
  return { left: Math.floor((side - w) / 2), top: Math.floor((side - h) / 2), w, h };
}

// Keep the highest-resolution encoding that fits the native request. All
// attempts below use the already captured pixels, including the rectified floor.
function classroomJpeg(canvas: HTMLCanvasElement): string {
  let reduced: HTMLCanvasElement | undefined;
  for (const [scale, quality] of [[1, 0.88], [1, 0.72], [0.75, 0.8], [0.5, 0.76], [0.25, 0.72]]) {
    let frame = canvas;
    if (scale < 1) {
      reduced ??= document.createElement("canvas");
      reduced.height = Math.max(1, Math.round(canvas.height * scale));
      reduced.width = Math.max(1, Math.round(canvas.width * reduced.height / canvas.height));
      const ctx = reduced.getContext("2d");
      if (!ctx) throw new Error("摄像头截图编码失败。");
      ctx.drawImage(canvas, 0, 0, reduced.width, reduced.height);
      frame = reduced;
    }
    const jpeg = frame.toDataURL("image/jpeg", quality);
    if (!jpeg.startsWith("data:image/jpeg;base64,") || jpeg.length <= 23) throw new Error("摄像头截图编码失败。");
    if (jpeg.length <= MAX_IMAGE_DATA_URL_LEN) return jpeg;
  }
  throw new Error("摄像头截图压缩后仍超出大小上限。");
}

// One exposure supplies both views. People can be identified in the full image,
// while feet and clear floor are measured in the rectified right-hand view.
export function composeClassroomFrame(video: CameraView, canvas: HTMLCanvasElement, quad: FloorQuad): string {
  if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面尚未就绪。");
  const side = Math.min(MAX_CAMERA_LONG_EDGE, Math.max(video.videoWidth, video.videoHeight));
  canvas.width = side * 2;
  canvas.height = side;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("摄像头画面尚未就绪。");
  const { left, top, w, h } = classroomRawRect(side, video.videoWidth, video.videoHeight);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(video, left, top, w, h);
  const raw = ctx.getImageData(left, top, w, h);
  const corners = classroomCorners(quad);
  const transform = buildFloorToImageHomography(corners);
  if (!transform) throw new Error("场地四角无效，请重新标定。");
  const output = ctx.createImageData(side, side);
  const sourcePixels = new Uint32Array(raw.data.buffer, raw.data.byteOffset, w * h);
  const floorPixels = new Uint32Array(output.data.buffer, output.data.byteOffset, side * side);
  for (let y = 0; y < side; y++) {
    const fy = (y + 0.5) / side;
    for (let x = 0; x < side; x++) {
      const fx = (x + 0.5) / side;
      const weight = transform[6] * fx + transform[7] * fy + 1;
      const col = clamp(Math.floor(w * (transform[0] * fx + transform[1] * fy + transform[2]) / weight), 0, w - 1);
      const row = clamp(Math.floor(h * (transform[3] * fx + transform[4] * fy + transform[5]) / weight), 0, h - 1);
      floorPixels[y * side + x] = sourcePixels[row * w + col];
    }
  }
  ctx.putImageData(output, side, 0);
  ctx.beginPath();
  ctx.moveTo(left + corners[0].x * w, top + corners[0].y * h);
  for (const p of [...corners.slice(1), corners[0]]) ctx.lineTo(left + p.x * w, top + p.y * h);
  strokeWithOutline(ctx, 1.5);
  return classroomJpeg(canvas);
}

// Uncalibrated classroom capture: send the unmirrored camera frame preserving
// aspect ratio so the vision model can estimate robot heading, distance, and
// clearance directly from floor markers and robot scale without manual setup.
export function composeAutoClassroomFrame(video: CameraView, canvas: HTMLCanvasElement): string {
  if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面尚未就绪。");
  const scale = Math.min(1, MAX_CAMERA_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("摄像头画面尚未就绪。");
  ctx.drawImage(video, 0, 0, w, h);
  return classroomJpeg(canvas);
}

type SceneMarkers = ClassroomInspection & { name: string; approach?: Point2D };

function freshMarkers(capturedAt: number | undefined) {
  const now = Date.now();
  return capturedAt !== undefined && Number.isFinite(capturedAt) && capturedAt <= now && now - capturedAt < MARKER_MAX_AGE_MS;
}

// Both edges stay legible as the camera pans between light and dark surfaces.
function strokeWithOutline(ctx: CanvasRenderingContext2D, width: number) {
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = "#171717";
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

function drawMarker(ctx: CanvasRenderingContext2D, width: number, height: number, point: Point2D, text: string,
  placement: "above" | "below" | "left") {
  ctx.beginPath();
  ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
  strokeWithOutline(ctx, 2.5);
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const labelWidth = Math.min(width - 2, Math.ceil(ctx.measureText?.(text).width ?? text.length * 12) + 10);
  const x = clamp(placement === "left" ? point.x - labelWidth - 9 : point.x + 7, 1, width - labelWidth - 1);
  const y = clamp(point.y + (placement === "above" ? -26 : placement === "below" ? 7 : -10), 1, height - 21);
  ctx.fillStyle = "rgba(16, 16, 16, 0.90)";
  ctx.fillRect(x, y, labelWidth, 20);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 5, y + 10, labelWidth - 10);
}

function drawHeading(ctx: CanvasRenderingContext2D, from: Point2D, to: Point2D) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.1) return;
  const ux = dx / length, uy = dy / length;
  const shaft = clamp(length, 15, 32);
  const tip = { x: from.x + ux * shaft, y: from.y + uy * shaft };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x - ux * 7 - uy * 4, tip.y - uy * 7 + ux * 4);
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - ux * 7 + uy * 4, tip.y - uy * 7 - ux * 4);
  strokeWithOutline(ctx, 2.5);
}

function paintDetections(ctx: CanvasRenderingContext2D, w: number, h: number, mirror: boolean, marks: SceneMarkers) {
  const pixel = (p: Point2D) => ({ x: (mirror ? 1 - p.x : p.x) * w, y: p.y * h });
  if (marks.robot && marks.route?.length) {
    const origin = pixel(marks.robot);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    for (const waypoint of marks.route) {
      const point = pixel(waypoint);
      ctx.lineTo(point.x, point.y);
    }
    strokeWithOutline(ctx, 2.5);
    drawMarker(ctx, w, h, pixel(marks.route[marks.route.length - 1]), "计划停靠点", "left");
  }
  if (marks.approach) drawMarker(ctx, w, h, pixel(marks.approach), "停靠点", "left");
  if (marks.target) drawMarker(ctx, w, h, pixel(marks.target), "目标：" + marks.name, "below");
  if (marks.robot) {
    const robot = pixel(marks.robot);
    if (marks.headingPoint) drawHeading(ctx, robot, pixel(marks.headingPoint));
    drawMarker(ctx, w, h, robot, "小布米", "above");
  }
}

type RoutePlanMode = "walk" | "preview" | "unavailable";

export function createBumiVision(bridge: ClassroomVisionBridge) {
  const toggleBtn = document.getElementById("vision-toggle") as HTMLButtonElement | null;
  const command = document.getElementById("voice-command") as HTMLInputElement | null;
  const inspectButton = document.getElementById("vision-inspect-classroom") as HTMLButtonElement | null;
  const inspectStatus = document.getElementById("vision-inspect-status");
  const deviceSelect = document.getElementById("vision-device") as HTMLSelectElement | null;
  const mirrorToggle = document.getElementById("vision-mirror") as HTMLInputElement | null;
  const searchSelect = document.getElementById("vision-search-view") as HTMLSelectElement | null;
  const searchSetting = document.getElementById("vision-search-setting");
  const searchHelp = document.getElementById("vision-search-help");
  const walkContinueSetting = document.getElementById("class-walk-continue-setting");
  const walkContinueToggle = document.getElementById("class-walk-continue") as HTMLInputElement | null;
  const routePlanSetting = document.getElementById("class-route-plan-setting");
  const routePlanToggle = document.getElementById("class-route-plan") as HTMLInputElement | null;
  const manualCalibration = document.getElementById("class-manual-calibration");
  const confidenceField = document.getElementById("class-confidence-threshold") as HTMLInputElement | null;
  const confidenceSetting = document.getElementById("class-confidence-setting");
  const confidenceLegacyHint = document.getElementById("class-confidence-legacy");
  const calibrateBtn = document.getElementById("vision-calibrate") as HTMLButtonElement | null;
  const resetQuadBtn = document.getElementById("vision-reset-quad") as HTMLButtonElement | null;
  const video = document.getElementById("vision-video") as HTMLVideoElement | null;
  const preview = document.getElementById("vision-stage");
  const snapshot = document.getElementById("vision-snapshot");
  const snapshotCanvas = document.getElementById("vision-snapshot-canvas") as HTMLCanvasElement | null;
  const snapshotTime = document.getElementById("vision-snapshot-time");
  const snapshotLabel = document.getElementById("vision-snapshot-label");
  let snapshotGeneration = 0;
  const cornerHint = document.getElementById("vision-corner-hint");
  const overlay = document.getElementById("vision-overlay") as HTMLCanvasElement | null;
  const statusEl = document.getElementById("vision-status") as HTMLElement | null;

  if (!toggleBtn || !video || !overlay || !statusEl) {
    return {
      stop: (_reason?: string) => {},
      isActive: () => false,
      isReady: () => false,
      readConfidenceThreshold: () => defaultSceneConfidence,
      syncConfidenceField: (_supported: boolean, _busy: boolean) => {},
      syncSearchView: (_supported: boolean, _busy: boolean) => {},
      syncWalkContinue: (_supported: boolean, _busy: boolean) => {},
      walkContinueEnabled: () => false,
      syncRoutePlan: (_mode: RoutePlanMode, _busy: boolean) => {},
      routePlanEnabled: () => false,
      inspectTarget: async (_target: string) => {},
      acquireClassroomCamera: (_onInvalidated: (reason: string) => void, _rawFrame = false): ClassroomCamera => {
        throw new Error("当前窗口没有可用的课堂摄像头。");
      },
      classroomActive: () => false,
      clearSnapshot: () => {},
      resetTracking: () => {},
      refreshTarget: () => {},
    };
  }
  const videoEl = video;
  const config = loadVisionConfig();
  function syncConfidenceField(supported: boolean, busy: boolean) {
    if (!confidenceField || !confidenceSetting) return;
    confidenceSetting.hidden = !supported && Number(confidenceField.value) === defaultSceneConfidence;
    confidenceField.disabled = busy || confidenceSetting.hidden;
    if (confidenceLegacyHint) confidenceLegacyHint.hidden = supported;
  }
  function readConfidenceThreshold(): number {
    const value = confidenceField ? Number(confidenceField.value) : config.minSceneConfidence;
    if (!validSceneConfidenceThreshold(value)) throw new Error("请将行走置信度阈值设为 0.01 至 1 之间的数值。");
    return value;
  }
  if (confidenceField) {
    confidenceField.value = String(config.minSceneConfidence);
    confidenceField.addEventListener("change", () => {
      const value = Number(confidenceField.value);
      if (validSceneConfidenceThreshold(value)) {
        config.minSceneConfidence = value;
        saveVisionConfig(config);
      }
    });
  }
  let inspection: { target: string; camera: ClassroomCamera } | null = null;
  let stream: MediaStream | null = null;
  let pendingStart: symbol | null = null;
  let timer: number | undefined;
  let calibratingIndex = -1;
  let previousQuad: FloorQuad | null = null;
  let calibratedStream: MediaStream | null = null;
  let classroom: { release(reason?: string): void; checkGeometry(): boolean } | null = null;
  let sceneMarkers: SceneMarkers | null = null;
  let boxFrames: (HTMLCanvasElement & CameraView) | null = null;
  let closeBoxCamera: (() => void) | undefined;
  let boxCameraLabel = "";
  let boxSerial = 0;
  let boxSession = 0;
  let boxSize = "";
  let deviceListGeneration = 0;
  const boxWaiters = new Set<() => void>();
  if (mirrorToggle) mirrorToggle.checked = config.mirror;
  if (searchSetting) searchSetting.hidden = true;
  if (searchHelp) searchHelp.hidden = true;
  function describeSearchView() {
    if (searchHelp) searchHelp.textContent = config.searchView === "dominant"
      ? "从机器人正前方寻找目标，画面中无需出现机身。"
      : "从教室观察，让小布米和目标同时入镜。";
  }
  if (searchSelect) {
    searchSelect.value = config.searchView;
    searchSelect.disabled = true;
    describeSearchView();
    searchSelect.addEventListener("change", () => {
      bridge.onTrackingReset?.();
      config.searchView = searchSelect.value === "dominant" ? "dominant" : "passive";
      describeSearchView();
      saveVisionConfig(config);
    });
  }
  function syncSearchView(supported: boolean, busy: boolean) {
    if (searchSetting) searchSetting.hidden = !supported;
    if (searchHelp) searchHelp.hidden = !supported;
    if (!searchSelect) return;
    searchSelect.disabled = !supported || busy;
    if (searchSelect.value !== "dominant" && searchSelect.value !== "passive") searchSelect.value = config.searchView;
  }
  if (walkContinueSetting) walkContinueSetting.hidden = true;
  if (walkContinueToggle) {
    walkContinueToggle.checked = config.walkContinue;
    walkContinueToggle.disabled = true;
    walkContinueToggle.addEventListener("change", () => {
      config.walkContinue = walkContinueToggle.checked;
      saveVisionConfig(config);
    });
  }
  function syncWalkContinue(supported: boolean, busy: boolean) {
    if (walkContinueSetting) walkContinueSetting.hidden = !supported;
    if (!walkContinueToggle) return;
    walkContinueToggle.disabled = !supported || busy;
  }
  function walkContinueEnabled(): boolean {
    if (!walkContinueToggle || walkContinueSetting?.hidden !== false) return false;
    return walkContinueToggle.checked;
  }

  let routePlanMode: RoutePlanMode | undefined;
  function syncRoutePlan(mode: RoutePlanMode, busy: boolean) {
    const supported = mode !== "unavailable";
    if (routePlanSetting) routePlanSetting.hidden = !supported;
    if (!routePlanToggle) return;
    if (mode !== routePlanMode) routePlanToggle.checked = mode === "walk";
    routePlanMode = mode;
    routePlanToggle.disabled = !supported || busy;
    syncManualCalibration();
  }
  function routePlanEnabled(): boolean {
    return routePlanSetting?.hidden === false && routePlanToggle?.checked === true;
  }
  function syncManualCalibration() {
    if (manualCalibration) manualCalibration.hidden = routePlanEnabled();
  }
  routePlanToggle?.addEventListener("change", syncManualCalibration);
  syncRoutePlan("unavailable", false);

  function cameraOpen(): boolean {
    if (!stream || stream.active === false) return false;
    if (boxFrames) return boxFrames.width > 0 && boxFrames.height > 0;
    return videoEl.readyState >= 2;
  }

  function frameSize() {
    if (boxFrames?.width && boxFrames.height) return { width: boxFrames.width, height: boxFrames.height };
    return { width: videoEl.videoWidth, height: videoEl.videoHeight };
  }

  function noteBoxFrame() {
    boxSerial++;
    const size = boxFrames ? `${boxFrames.width}x${boxFrames.height}` : "";
    if (boxSize && size !== boxSize) {
      if (classroom && !classroom.checkGeometry()) classroom.release("摄像头画幅已变化，课堂任务已停止。");
      else if (!classroom && stream) resetTracking();
    }
    boxSize = size;
    for (const waiter of [...boxWaiters]) waiter();
    if (stream) drawPreview();
  }

  function setStatus(message: string) {
    if (statusEl && statusEl.textContent !== message) statusEl.textContent = message;
  }

  function inspectionUnavailable(): string | undefined {
    if (!cameraOpen()) return "请先开启教室摄像头，等预览画面出现后再识别。";
    if (calibratingIndex >= 0) return "请先完成或取消地面四角标定。";
    if (classroom) return "正在使用摄像头，请等当前观察完成或停止当前任务。";
    if (!bridge.inspectClassroom) return "当前桌面宿主不支持只识别。";
    const availability = bridge.canInspectClassroom?.();
    if (typeof availability === "string") return availability;
    if (!availability) return "请等机器人停稳并结束当前操作后，再识别目标。";
  }

  function refreshTarget() {
    if (inspectButton) inspectButton.disabled = !bridge.inspectionTarget?.() || !!inspectionUnavailable();
  }

  function resetTracking(invalidatePreview = true) {
    if (invalidatePreview) bridge.onTrackingReset?.();
    if (inspectStatus) inspectStatus.textContent = "";
    classroom?.release("摄像头或机器人状态已变化，本次观察已取消。");
    cancelCalibration();
    sceneMarkers = null;
    clearSnapshot();
    refreshTarget();
  }

  function syncUi() {
    if (toggleBtn) {
      toggleBtn.disabled = !!pendingStart;
      toggleBtn.textContent = pendingStart ? "正在开启…" : stream ? "关闭摄像头" : "开启摄像头";
    }
    if (preview) preview.hidden = !stream;
    if (deviceSelect) deviceSelect.disabled = !!pendingStart;
    const mirror = config.mirror ? "scaleX(-1)" : "";
    if (videoEl.style) videoEl.style.transform = mirror;
    if (boxFrames?.style) boxFrames.style.transform = mirror;
    refreshTarget();
    if (cornerHint) {
      cornerHint.hidden = calibratingIndex < 0;
      if (calibratingIndex >= 0) cornerHint.textContent = `请点击画面中地面的${cornerNames[calibratingIndex]}角（${calibratingIndex + 1}/4）。`;
    }
    if (calibrateBtn) {
      calibrateBtn.textContent = calibratingIndex >= 0 ? "取消标定" : "标定地面四角";
      calibrateBtn.disabled = !cameraOpen();
    }
  }

  async function refreshDevices() {
    if (!deviceSelect) return;
    const generation = ++deviceListGeneration;
    let devices: MediaDeviceInfo[] = [];
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
        devices = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === "videoinput");
      }
    } catch { /* Enumeration can fail before the system camera permission is granted. */ }
    if (generation !== deviceListGeneration) return;
    const current = deviceSelect.value;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = devices.length ? "默认本机摄像头" : boxCameraLabel ? "请选择摄像头" : "未发现摄像头设备";
    deviceSelect.replaceChildren(placeholder);
    devices.forEach((device, idx) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `摄像头 ${idx + 1}`;
      deviceSelect.appendChild(option);
    });
    if (boxCameraLabel) {
      const option = document.createElement("option");
      option.value = BOX_CAMERA_ID;
      option.textContent = boxCameraLabel;
      deviceSelect.appendChild(option);
    }
    const known = current === BOX_CAMERA_ID ? !!boxCameraLabel : devices.some(item => item.deviceId === current);
    if (known) deviceSelect.value = current;
    return devices;
  }

  function drawPreview() {
    if (!overlay) return;
    const size = frameSize();
    if (size.width && size.height) {
      const ratio = size.width / size.height;
      if (preview?.style) preview.style.aspectRatio = `${size.width} / ${size.height}`;
      const width = Math.max(1, Math.round(overlay.clientWidth || 320));
      const height = Math.max(1, Math.round(width / ratio));
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
    }
    const ctx = overlay.getContext?.("2d");
    if (!ctx) return;
    const { width, height } = overlay;
    ctx.clearRect(0, 0, width, height);
    if (sceneMarkers && freshMarkers(sceneMarkers.capturedAt)) paintDetections(ctx, width, height, config.mirror, sceneMarkers);
    if (calibratingIndex < 0) return;
    config.quad.forEach((corner, index) => {
      const x = (config.mirror ? 1 - corner.x : corner.x) * width;
      const y = corner.y * height;
      ctx.beginPath();
      ctx.arc(x, y, index === calibratingIndex ? 7 : 5, 0, Math.PI * 2);
      if (index === calibratingIndex) {
        ctx.fillStyle = "#171717";
        ctx.fill();
      }
      strokeWithOutline(ctx, index === calibratingIndex ? 3 : 1.5);
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      const labelX = clamp(x + 9, 0, width - 28), labelY = clamp(y - 8, 15, height - 2);
      ctx.fillStyle = "#171717";
      ctx.fillRect(labelX, labelY - 13, 28, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(cornerNames[index], labelX + 2, labelY);
    });
  }

  // The archived overlay belongs to the exact model input, never the live video
  // when the asynchronous result arrives. No frames are stored beyond this UI.
  function clearSnapshot() {
    snapshotGeneration++;
    if (snapshot) snapshot.hidden = true;
    if (snapshotTime) snapshotTime.textContent = "";
    if (snapshotCanvas) snapshotCanvas.width = snapshotCanvas.width;
  }
  function paintSnapshot(source: CanvasImageSource, rect: { left: number; top: number; w: number; h: number },
    capturedAt: number, marks?: SceneMarkers, issue?: WalkIssueMarker) {
    if (!snapshot || !snapshotCanvas || !snapshotTime) return;
    const ctx = snapshotCanvas.getContext("2d");
    if (!ctx) return;
    const width = Math.max(1, Math.min(rect.w, Math.round(overlay?.clientWidth || rect.w)));
    const height = Math.max(1, Math.round(width * rect.h / rect.w));
    snapshotCanvas.width = width;
    snapshotCanvas.height = height;
    const mirrorImage = !!marks && config.mirror;
    if (mirrorImage) {
      ctx.save(); ctx.translate(width, 0); ctx.scale(-1, 1);
    }
    ctx.drawImage(source, rect.left, rect.top, rect.w, rect.h, 0, 0, width, height);
    if (mirrorImage) ctx.restore();
    if (marks) paintDetections(ctx, width, height, config.mirror, marks);
    const issueLabel = issue?.kind === "obstacle" ? "疑似障碍" : "看不清处";
    if (issue) drawMarker(ctx, width, height, { x: issue.point.x * width, y: issue.point.y * height }, issueLabel, "below");
    const time = new Date(capturedAt);
    snapshotTime.textContent = time.toLocaleTimeString("zh-CN", { hour12: false });
    snapshotTime.setAttribute?.("datetime", time.toISOString());
    const label = issue ? "本次通路判断" : marks?.route ? "本次规划路线" : marks ? "最近识别画面" : "本次识别原图";
    if (snapshotLabel) snapshotLabel.textContent = label;
    const points = marks
      ? [marks.robot && "小布米", marks.target && ("目标：" + marks.name), marks.approach && "停靠点",
        marks.route?.length && "计划停靠点"].filter(Boolean)
      : [];
    snapshotCanvas.setAttribute?.("aria-label", [label, ...points, ...(issue ? [issueLabel] : [])].join("，"));
    snapshot.hidden = false;
  }
  function saveClassroomSnapshot(imageDataUrl: string, capturedAt: number, marks?: SceneMarkers,
    cropCamera?: CalibratedCamera, issue?: WalkIssueMarker) {
    clearSnapshot();
    if (!snapshot || !Number.isFinite(capturedAt) || capturedAt <= 0 || capturedAt > Date.now()
      || !/^data:image\/jpeg;base64,/i.test(imageDataUrl) || typeof Image === "undefined") return;
    const generation = snapshotGeneration;
    const image = new Image();
    image.onload = () => {
      if (generation !== snapshotGeneration || !stream || document.hidden || !document.hasFocus()) return;
      const rect = cropCamera ? classroomRawRect(image.naturalHeight, cropCamera.width, cropCamera.height)
        : { left: 0, top: 0, w: image.naturalWidth, h: image.naturalHeight };
      if (rect.w > 0 && rect.h > 0) paintSnapshot(image, rect, capturedAt, marks, issue);
    };
    image.onerror = () => { if (generation === snapshotGeneration) clearSnapshot(); };
    image.src = imageDataUrl;
  }

  function currentCamera(): CalibratedCamera {
    if (boxFrames) return { deviceId: BOX_CAMERA_ID, width: boxFrames.width, height: boxFrames.height };
    const track = stream?.getVideoTracks?.()[0];
    return { deviceId: track?.getSettings?.().deviceId || "", width: videoEl.videoWidth, height: videoEl.videoHeight };
  }

  function calibratedForActiveCamera() {
    const saved = config.calibratedCamera;
    const current = currentCamera();
    return !!saved && !!stream && current.width > 0 && current.height > 0
      && current.width === saved.width && current.height === saved.height
      && (saved.deviceId ? saved.deviceId === current.deviceId : calibratedStream === stream);
  }

  function acquireClassroomCamera(onInvalidated: (reason: string) => void, rawFrame = false): ClassroomCamera {
    if (inspection) {
      inspection.camera.release();
      inspection = null;
    }
    if (classroom) throw new Error("摄像头正在执行课堂任务。");
    if (!stream) throw new Error("请先开启教室摄像头。");
    if (!rawFrame && calibratingIndex >= 0) throw new Error("请先完成或取消当前的场地四角标定。");
    const calibrated = !rawFrame && calibratedForActiveCamera();
    // Latch the viewpoint with the lease. Dominant view sends the raw forward frame.
    const floorFrame = calibrated && readSearchView() !== "dominant";
    const toImage = floorFrame ? buildFloorToImageHomography(classroomCorners(config.quad)) : null;
    const sourceStream = stream;
    const sourceQuad = JSON.stringify(config.quad);
    const initialCamera = currentCamera();
    const track = stream.getVideoTracks?.()[0];
    const geometryValid = () => {
      if (calibrated) return calibratedForActiveCamera();
      const now = currentCamera();
      return !!stream && now.width > 0 && now.height > 0
        && now.width === initialCamera.width && now.height === initialCamera.height
        && now.deviceId === initialCamera.deviceId;
    };
    const available = () => !document.hidden && stream?.active !== false && geometryValid() && (boxFrames
      ? boxFrames.width > 0 && boxFrames.height > 0
      : videoEl.readyState >= 2 && track?.readyState !== "ended" && !track?.muted);
    if (!available()) throw new Error("摄像头画面尚未就绪。");
    resetTracking(!rawFrame);
    const canvas = document.createElement("canvas");
    let cancelFrame: (() => void) | undefined;
    function showMarkers(name: string, detection: ClassroomInspection, imageDataUrl?: string, approach?: Point2D) {
      if (classroom !== owner) return;
      sceneMarkers = null;
      const unproject = (p?: Point2D) => {
        if (!validPoint(p)) return undefined;
        return floorFrame ? (toImage && projectPoint(toImage, p)) ?? undefined : p;
      };
      const fresh = freshMarkers(detection.capturedAt);
      let marks: SceneMarkers | undefined;
      if (isCurrent() && Number.isFinite(detection.capturedAt) && detection.capturedAt > 0 && detection.capturedAt <= Date.now()) {
        const robot = unproject(detection.robot), target = unproject(detection.target);
        if (robot || target) marks = { name, capturedAt: detection.capturedAt, robot, target,
          headingPoint: robot ? unproject(detection.headingPoint) : undefined, approach: unproject(approach) };
      }
      // Keep delayed markers on their original JPEG when they are too old for the live preview.
      if (fresh && marks) sceneMarkers = marks;
      if (isCurrent() && imageDataUrl) {
        // Keep the planned path on the exposure used to plan it, including after the robot moves.
        const route = detection.route?.map(unproject);
        const snapshotMarks = marks && route && route.every(validPoint) ? { ...marks, route } : marks;
        saveClassroomSnapshot(imageDataUrl, detection.capturedAt, snapshotMarks, marks && floorFrame ? initialCamera : undefined);
      }
      else clearSnapshot();
      drawPreview();
    }
    const owner = {
      checkGeometry: geometryValid,
      release(reason?: string) {
        if (classroom !== owner) return;
        classroom = null;
        inspection = null;
        sceneMarkers = null;
        drawPreview();
        cancelFrame?.();
        syncUi();
        if (reason) { clearSnapshot(); onInvalidated(reason); }
      },
    };
    classroom = owner;
    syncUi();
    const isCurrent = () => classroom === owner && available();
    return {
      calibrated,
      source: boxFrames ? "forward" : "classroom",
      isCurrent,
      matchesSource: () => sourceStream === stream && geometryValid()
        && (rawFrame || (calibratedForActiveCamera() === calibrated && JSON.stringify(config.quad) === sourceQuad)),
      release: () => owner.release(),
      clearObservation(clearArchived = false) {
        if (classroom !== owner) return;
        sceneMarkers = null;
        if (clearArchived) clearSnapshot();
        drawPreview();
      },
      showInspection(name, detection, imageDataUrl) {
        showMarkers(name, detection, imageDataUrl);
      },
      showInputFrame(imageDataUrl, capturedAt, issue) {
        if (!isCurrent()) return;
        sceneMarkers = null;
        // The raw archive is unmirrored. For a composite, the model reported
        // this point on the right-hand floor view, not on the entire JPEG.
        const marker = floorFrame && issue
          ? { ...issue, point: { x: (1 + issue.point.x) / 2, y: issue.point.y } } : issue;
        saveClassroomSnapshot(imageDataUrl, capturedAt, undefined, undefined, marker);
        drawPreview();
      },
      showObservation(name, observation, imageDataUrl, minConfidence = defaultSceneConfidence) {
        if (classroom !== owner) return;
        const { capturedAt, confidence, status, pathClear, robot, target, headingPoint } = observation;
        if (capturedAt !== undefined && status === "ready" && pathClear === true && sceneConfidenceAccepted(confidence, minConfidence)
          && validPoint(robot) && validPoint(target) && validPoint(headingPoint)
          && Math.hypot(headingPoint.x - robot.x, headingPoint.y - robot.y) >= 0.005) {
          showMarkers(name, { capturedAt, robot, target, headingPoint }, imageDataUrl, observation.approach);
        } else {
          sceneMarkers = null;
          if (isCurrent() && imageDataUrl && capturedAt !== undefined) saveClassroomSnapshot(imageDataUrl, capturedAt);
          else clearSnapshot();
          drawPreview();
        }
      },
      captureFreshFrame: async () => {
        return new Promise<string>((resolve, reject) => {
          if (!isCurrent() || cancelFrame) {
            reject(new Error("摄像头状态已变化或上次截图尚未完成。"));
            return;
          }
          const source = boxFrames;
          if (source) {
            const frame = source;
            const initial = boxSerial;
            const timeout = window.setTimeout(() => fail("摄像头未提供新帧，请检查画面。"), 2000);
            function finish(error?: Error, frame?: string) {
              window.clearTimeout(timeout);
              boxWaiters.delete(watch);
              cancelFrame = undefined;
              if (error) reject(error);
              else if (frame) resolve(frame);
            }
            function fail(reason: string) { finish(new Error(reason)); }
            function watch() {
              if (boxSerial <= initial) return;
              if (!isCurrent()) { fail("摄像头或场地标定已变化。"); return; }
              try {
                finish(undefined, floorFrame
                  ? composeClassroomFrame(frame, canvas, config.quad)
                  : composeAutoClassroomFrame(frame, canvas));
              } catch (err) { finish(err instanceof Error ? err : new Error(String(err))); }
            }
            cancelFrame = () => fail("本次课堂截图已取消。");
            boxWaiters.add(watch);
            return;
          }
          let callback: number | undefined;
          let poll: number | undefined;
          const timeout = window.setTimeout(() => fail("摄像头未提供新帧，请检查画面。"), 2000);
          function clear() {
            window.clearTimeout(timeout);
            if (callback !== undefined) videoEl.cancelVideoFrameCallback(callback);
            if (poll !== undefined) window.clearInterval(poll);
            cancelFrame = undefined;
          }
          function fail(reason: string) {
            clear();
            reject(new Error(reason));
          }
          function capture() {
            clear();
            if (!isCurrent()) {
              reject(new Error("摄像头或场地标定已变化。"));
              return;
            }
            try {
              resolve(floorFrame
                ? composeClassroomFrame(videoEl, canvas, config.quad)
                : composeAutoClassroomFrame(videoEl, canvas));
            } catch (err) { reject(err); }
          }
          cancelFrame = () => fail("本次课堂截图已取消。");
          if (typeof videoEl.requestVideoFrameCallback === "function") {
            callback = videoEl.requestVideoFrameCallback(capture);
            return;
          }
          const counter = () => videoEl.getVideoPlaybackQuality?.().totalVideoFrames;
          const initial = counter();
          if (initial === undefined || !Number.isFinite(initial)) {
            fail("当前摄像头无法确认新帧。");
            return;
          }
          poll = window.setInterval(() => {
            if (!isCurrent()) fail("摄像头或场地标定已变化。");
            else if ((counter() ?? 0) > initial) capture();
          }, 40);
        });
      },
    };
  }
  videoEl.addEventListener("resize", () => {
    if (classroom && !classroom.checkGeometry()) classroom.release("摄像头画幅已变化，课堂任务已停止。");
    else if (!classroom && stream) resetTracking();
    drawPreview();
  });
  videoEl.addEventListener("loadeddata", syncUi);

  function processTick() {
    if (!stream || !overlay) return;
    const size = frameSize();
    if (!cameraOpen() || !size.width || !size.height) {
      overlay.getContext?.("2d")?.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    drawPreview();
    refreshTarget();
  }

  function stop(reason = "摄像头已关闭。") {
    pendingStart = null;
    boxSession++;
    classroom?.release(reason);
    calibratedStream = null;
    window.clearInterval(timer);
    timer = undefined;
    resetTracking();
    const close = closeBoxCamera;
    closeBoxCamera = undefined;
    boxFrames?.remove?.();
    boxFrames = null;
    boxSize = "";
    close?.();
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (video) video.srcObject = null;
    const ctx = overlay?.getContext?.("2d");
    if (ctx && overlay) ctx.clearRect(0, 0, overlay.width, overlay.height);
    setStatus(reason);
    syncUi();
  }

  function paintBoxFrame(canvas: HTMLCanvasElement, jpeg: string): Promise<void> {
    if (!jpeg || jpeg.length > 2_000_000) return Promise.reject(new Error("盒子摄像头画面无效。"));
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) { reject(new Error("盒子摄像头没有返回有效画面。")); return; }
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("盒子摄像头画面无法显示。")); return; }
        ctx.drawImage(image, 0, 0, width, height);
        resolve();
      };
      image.onerror = () => reject(new Error("盒子摄像头画面无法显示。"));
      image.src = `data:image/jpeg;base64,${jpeg}`;
    });
  }

  function boxPreviewStream(): MediaStream {
    const track = {
      readyState: "live" as "live" | "ended",
      muted: false,
      stop() { track.readyState = "ended"; },
      addEventListener() {},
      getSettings: () => ({ deviceId: BOX_CAMERA_ID }),
    };
    return { active: true, getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  }

  async function startBoxCamera(attempt: symbol) {
    const host = (window as Window & { __keepworkBoxCamera?: BoxCameraHost }).__keepworkBoxCamera;
    const label = boxCameraLabel;
    if (!label || !host?.open) {
      stop("请先连接视频语音盒子，再选择它的摄像头。");
      return;
    }
    setStatus("正在连接盒子摄像头…");
    const session = boxSession;
    const view = document.createElement("canvas") as HTMLCanvasElement & CameraView;
    Object.defineProperty(view, "videoWidth", { get: () => view.width, configurable: true });
    Object.defineProperty(view, "videoHeight", { get: () => view.height, configurable: true });
    if (view.style) view.style.transform = config.mirror ? "scaleX(-1)" : "";
    boxFrames = view;
    let paintQueue = Promise.resolve();
    let close: (() => void) | undefined;
    try {
      close = await host.open(
        jpeg => {
          paintQueue = paintQueue.then(async () => {
            if (session !== boxSession || boxFrames !== view) return;
            await paintBoxFrame(view, jpeg);
            if (session !== boxSession || boxFrames !== view) return;
            noteBoxFrame();
          }).catch(() => {});
        },
        reason => { if (session === boxSession && (stream || pendingStart === attempt)) stop(reason); },
      );
      if (pendingStart !== attempt) {
        if (closeBoxCamera !== close) close();
        if (boxFrames === view) boxFrames = null;
        return;
      }
      closeBoxCamera = close;
      stream = boxPreviewStream();
      if (overlay) overlay.parentElement?.insertBefore(view, overlay);
      if (video) video.srcObject = null;
      if (preview) preview.hidden = false;
      timer = window.setInterval(processTick, 200);
      setStatus(`正在使用「${label}」。`);
      pendingStart = null;
      drawPreview();
      syncUi();
    } catch (cause) {
      close?.();
      if (pendingStart !== attempt) return;
      stop(`无法打开摄像头：${String(cause)}。请检查盒子连接和摄像头。`);
    }
  }

  async function start() {
    if (pendingStart) return;
    if (stream) {
      stop();
      return;
    }
    const attempt = Symbol();
    pendingStart = attempt;
    syncUi();
    if (deviceSelect?.value === BOX_CAMERA_ID) {
      await startBoxCamera(attempt);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      stop("当前窗口无法使用摄像头。请在桌面端打开小布米控制窗口。");
      return;
    }
    setStatus("正在请求摄像头权限…");
    try {
      const deviceId = deviceSelect?.value;
      const saved = config.calibratedCamera;
      // Prefer the original capture mode when reopening a calibrated webcam.
      // A different system-default device still needs its own floor calibration.
      const previousMode = saved && saved.deviceId !== BOX_CAMERA_ID && (!deviceId || saved.deviceId === deviceId) ? saved : undefined;
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: previousMode?.width ?? 1280 },
        height: { ideal: previousMode?.height ?? 720 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      };
      const acquired = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      if (pendingStart !== attempt) {
        for (const track of acquired.getTracks()) track.stop();
        return;
      }
      stream = acquired;
      const track = acquired.getVideoTracks?.()[0];
      track?.addEventListener("ended", () => {
        if (stream === acquired) stop("摄像头已断开。");
      });
      track?.addEventListener("mute", () => {
        if (stream !== acquired) return;
        classroom?.release("摄像头已中断，课堂任务已停止。");
        resetTracking();
      });
      videoEl.srcObject = stream;
      if (preview) preview.hidden = false;
      await videoEl.play?.().catch(() => {});
      const devices = await refreshDevices();
      if (pendingStart !== attempt) return;
      timer = window.setInterval(processTick, 200);
      const activeId = track?.getSettings?.().deviceId;
      const label = track?.label?.trim() || (activeId && devices?.find(device => device.deviceId === activeId)?.label?.trim());
      setStatus(label ? `正在使用「${label}」。` : "摄像头已开启。");
      pendingStart = null;
      drawPreview();
      syncUi();
    } catch (cause) {
      if (pendingStart !== attempt) return;
      stop(`无法打开摄像头：${String(cause)}。请检查系统摄像头权限和所选设备。`);
    }
  }

  toggleBtn.addEventListener("click", () => { void start(); });
  command?.addEventListener("input", () => {
    if (inspection && bridge.inspectionTarget?.() !== inspection.target) {
      inspection.camera.release();
      inspection = null;
      clearSnapshot();
      if (inspectStatus) inspectStatus.textContent = "";
    }
    refreshTarget();
  });

  async function inspectTarget(target: string) {
    if (!inspectStatus) return;
    target = target.trim();
    if (!target || Array.from(target).length > 80 || /\p{Cc}/u.test(target)) {
      inspectStatus.textContent = "请输入 1 至 80 个字的人物或物体描述。";
      return;
    }
    const reason = inspectionUnavailable();
    if (reason || !bridge.inspectClassroom) {
      inspectStatus.textContent = reason || "当前桌面宿主不支持只识别。";
      return;
    }
    let camera: ClassroomCamera | undefined;
    try {
      camera = acquireClassroomCamera(message => { inspectStatus.textContent = message; });
      inspection = { target, camera };
      inspectStatus.textContent = `正在识别小布米和“${target}”…`;
      const message = await bridge.inspectClassroom(camera, target);
      if (camera.isCurrent()) inspectStatus.textContent = message;
    } catch (err) {
      if (!camera || camera.isCurrent()) {
        camera?.clearObservation(true);
        inspectStatus.textContent = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (inspection?.camera === camera) inspection = null;
      camera?.release();
    }
  }

  deviceSelect?.addEventListener("change", () => {
    if (stream) {
      stop("正在切换摄像头…");
      void start();
    }
  });
  mirrorToggle?.addEventListener("change", () => {
    config.mirror = mirrorToggle.checked;
    cancelCalibration();
    resetTracking();
    saveVisionConfig(config);
    syncUi();
    if (overlay && stream) drawPreview();
  });
  function cancelCalibration() {
    if (previousQuad) config.quad = previousQuad;
    previousQuad = null;
    calibratingIndex = -1;
  }
  calibrateBtn?.addEventListener("click", () => {
    if (!stream) return;
    if (calibratingIndex >= 0) {
      cancelCalibration();
      setStatus("已取消标定，沿用上次的场地四角。");
    } else {
      resetTracking();
      previousQuad = config.quad.map(point => ({ ...point })) as FloorQuad;
      calibratingIndex = 0;
      setStatus("请按画面上方的提示依次标定四个角。");
    }
    syncUi();
    if (calibratingIndex === 0) cornerHint?.scrollIntoView?.({ block: "start" });
  });
  resetQuadBtn?.addEventListener("click", () => {
    cancelCalibration();
    resetTracking();
    config.quad = DEFAULT_FLOOR_QUAD.map(point => ({ ...point })) as FloorQuad;
    delete config.calibratedCamera;
    calibratedStream = null;
    saveVisionConfig(config);
    calibratingIndex = -1;
    setStatus("已清除地面标定，使用原始摄像头画面。");
    if (overlay && stream) drawPreview();
    syncUi();
  });
  overlay.addEventListener("click", event => {
    if (calibratingIndex < 0 || !stream) return;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const rawX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const normX = config.mirror ? 1 - rawX : rawX;
    config.quad[calibratingIndex] = { x: Math.round(normX * 1000) / 1000, y: Math.round(rawY * 1000) / 1000 };
    calibratingIndex++;
    if (calibratingIndex >= 4) {
      if (!validFloorQuad(config.quad)) {
        cancelCalibration();
        setStatus("四角重合或顺序有误，已恢复上次标定。请按左上、右上、右下、左下重新标定。");
        drawPreview();
        syncUi();
        return;
      }
      previousQuad = null;
      calibratingIndex = -1;
      calibratedStream = stream;
      config.calibratedCamera = currentCamera();
      saveVisionConfig(config);
      setStatus("场地四角透视标定完成并已保存。");
    }
    drawPreview();
    syncUi();
  });

  // Motion tasks handle focus loss in the control window, which can suspend a
  // stopped clarification for an answer from main chat. Invalidate read-only
  // inspection here so its late answer cannot repaint a different task.
  window.addEventListener("blur", () => {
    clearSnapshot();
    if (inspection) classroom?.release("控制窗口失去焦点，本次识别已取消。");
  });
  window.addEventListener("pagehide", () => { if (stream || pendingStart) stop("页面已关闭，摄像头已释放。"); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (stream || pendingStart)) stop("摄像头已在窗口隐藏时关闭。请点「开启摄像头」恢复预览。");
  });

  const hostWindow = window as Window & {
    __keepworkBoxCamera?: BoxCameraHost;
    __keepworkBoxCameraNotify?: (camera: BoxCameraChoice | null) => void;
  };
  function applyBoxCamera(camera: BoxCameraChoice | null) {
    const label = camera?.label?.trim() || "";
    if (label === boxCameraLabel) return;
    const removed = !!boxCameraLabel && !label;
    boxCameraLabel = label;
    void refreshDevices();
    if (removed && deviceSelect?.value === BOX_CAMERA_ID && (stream || pendingStart)) {
      stop("盒子已断开，摄像头已关闭。");
    }
  }
  hostWindow.__keepworkBoxCameraNotify = applyBoxCamera;
  applyBoxCamera(hostWindow.__keepworkBoxCamera?.current?.() ?? null);

  void refreshDevices();
  syncUi();
  setStatus("摄像头尚未开启。");

  return { stop, clearSnapshot, resetTracking, refreshTarget, acquireClassroomCamera, inspectTarget, readConfidenceThreshold, syncConfidenceField, syncSearchView,
    syncWalkContinue, walkContinueEnabled, syncRoutePlan, routePlanEnabled,
    classroomActive: () => !!classroom, isActive: () => !!stream, isReady: () => cameraOpen() && calibratingIndex < 0 };
}
