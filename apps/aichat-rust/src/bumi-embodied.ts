// Each observation decides at most one settled BLE pulse. Floor coordinates
// follow the calibrated camera grid: right is +x and down is +y.
export type EmbodiedDirection = "forward" | "backward" | "left" | "right";
export interface CountedWalk {
  direction: "forward" | "backward";
  count: number;
}

// Only remove a spoken address or a polite imperative prefix at the start.
function walkSentence(raw: string): string {
  if (raw.length > 120 || /[\r\n]/u.test(raw)) return "";
  return raw.normalize("NFKC").trim().replace(/[ \t]+/gu, "").replace(/[。!.]+$/u, "")
    .replace(/^(?:(?:请你|请|麻烦你|麻烦|帮我|帮忙|劳驾)|(?:(?:让|叫|控制)?(?:小布米|布米|bumi|机器人)),?)+/iu, "")
    .replace(/(?:吧|谢谢)$/u, "");
}

const directions = /[向往朝](?:前|后)(?:面|方|边)?|前进|后退/gu;
const walkAmount = /([零〇一二两三四五六七八九十百千万\d]+|散|[Nn]|几|多少|若干)(?:小)?步/gu;
const namedCounts: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 散: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function specifiedWalk(direction: string, amount: string): CountedWalk | string {
  if (/^(?:[Nn]|几|多少|若干)$/u.test(amount)) return "请说具体步数，例如“向前走三步”。每次可以走 1 到 10 步。";
  // ASR can transcribe 三步 as 散步. Interpret it only after an explicit direction.
  const count = /^\d+$/u.test(amount) ? Number(amount) : namedCounts[amount];
  if (!Number.isInteger(count) || count < 1 || count > 10) return "每次可以走 1 到 10 步，请重新说方向和步数。";
  return { direction: direction.includes("前") ? "forward" : "backward", count };
}

export function parseCountedWalk(raw: string): CountedWalk | string | null {
  const phrase = walkSentence(raw);
  if (/^(?:(?:去)?散(?:个)?步|(?:走)?[零〇一二两三四五六七八九十百千\dNn几]+(?:小)?步)$/u.test(phrase)) {
    return "想往哪个方向走几步？请说完整口令，例如“向前走三步”或“向后走两步”。";
  }
  const direction = [...phrase.matchAll(directions)][0];
  const amount = [...phrase.matchAll(walkAmount)][0];
  if (!direction || !amount || direction.index !== 0 || amount.index + amount[0].length !== phrase.length) return null;
  const verb = phrase.slice(direction[0].length, amount.index);
  if (!/^(?:走(?:上|出|个)?|迈(?:上|出|个)?|进|退)?$/u.test(verb)) return null;
  if ((direction[0].includes("前") && verb === "退") || (direction[0].includes("后") && verb === "进")) return null;
  return specifiedWalk(direction[0], amount[1]);
}

// For unfamiliar imperative wording, independently extract the requested count
// and direction. The model must confirm both before the caller can use them.
export function walkIntentCandidate(raw: string): CountedWalk | null {
  const phrase = walkSentence(raw);
  const headings = [...phrase.matchAll(directions)];
  const amounts = [...phrase.matchAll(walkAmount)];
  if (headings.length !== 1 || amounts.length !== 1) return null;
  const walk = specifiedWalk(headings[0][0], amounts[0][1]);
  if (typeof walk === "string") return null;
  // Keep the remaining grammar affirmative and confined to a single walk.
  // A comma may introduce the total; unknown words and other clauses stay inert.
  const rest = phrase.replace(directions, "@").replace(walkAmount, "#");
  if (!/^(?:移动|挪动|迈步|挪|迈|走|朝着)?@(?:移动|挪动|迈步|挪|迈|走)?(?:一下|一挪|一走)?(?:,?(?:总共|一共|共))?(?:移动|挪动|走|迈)?(?:上|出|个)?#$/u.test(rest)) return null;
  return walk;
}
export type EmbodiedGesture = "handshake" | "wave";
export interface EmbodiedTask {
  mode: "approach" | "follow";
  target: string;
  gesture?: EmbodiedGesture;
}
type Point = { x: number; y: number };
export interface EmbodiedObservation {
  status: "ready" | "ambiguous" | "lost" | "uncertain" | "blocked";
  robot?: Point;
  headingPoint?: Point;
  target?: Point;
  approach?: Point;
  pathClear: boolean;
  rearClear: boolean;
  turnClear: boolean;
  confidence: number;
  distanceM?: number;
  approachDistanceM?: number;
  turnDeg?: number;
  atGreeting?: boolean;
  reason?: string;
  frameId?: number;
  capturedAt?: number;
  /** Set by the classroom window. Omitted means the fixed passive camera. */
  searchView?: "passive" | "dominant";
}
export interface EmbodiedCalibration {
  auto?: boolean;
  minConfidence?: number;
  widthM?: number;
  heightM?: number;
  stepM?: number;
  backwardM?: number;
  turnDeg?: number;
  leftDeg?: number;
  greetingM: number;
}
export interface EmbodiedDriver {
  calibration(): EmbodiedCalibration;
  observe(target: string, calibration?: EmbodiedCalibration): Promise<EmbodiedObservation>;
  /** Resolves after the one calibrated pulse has stopped and the robot has settled. */
  pulse(direction: EmbodiedDirection): Promise<void>;
  stop(): void | Promise<void>;
  gesture(kind: EmbodiedGesture): Promise<void>;
  greet(): Promise<void>;
  say(text: string): void;
  ask?(doorAndLectern: boolean): Promise<void>;
  state?(status: "running" | "awaitingChoice" | "completed" | "failed" | "stopped", message: string): void;
  ended?(): void;
  wait?(ms: number): Promise<void>;
}
export function parseEmbodiedTask(raw: string): EmbodiedTask | null {
  const phrase = raw.trim().replace(/\s+/gu, "").replace(/[。！!]+$/u, "");
  if (/[？?]/u.test(phrase) || /不要|别再|别去|别走|能不能|可不可以|要不要|可以吗|行吗|好吗|吗$/u.test(phrase)) return null;
  const match = /^(?:请)?(?:小布米)?(走到|走去|前往|去|跟着|跟随|跟上)(.+)$/u.exec(phrase);
  if (!match) return null;
  const mode = match[1].startsWith("跟") ? "follow" : "approach";
  let target = match[2];
  if (match[1] === "去" && (parseCountedWalk(target) || walkIntentCandidate(target))) return null;
  let gesture: EmbodiedGesture | undefined;
  const suffix = /(?:[，,、。]?)(?:(?:然后|并且|并|再|后|给他|给她|和他|和她|跟他|跟她)*)((?:握(?:个)?手|挥(?:个)?手|打(?:个)?招呼))$/u.exec(target);
  if (suffix) {
    if (mode === "follow") return null;
    gesture = suffix[1].startsWith("握") ? "handshake" : "wave";
    target = target.slice(0, suffix.index);
  }
  target = target.replace(/(?:的)?(?:旁边|身旁|旁|身边|附近)$/u, "");
  if (!target || target.length > 64 || /[，,。！？!?；;]|然后|接着|并且/u.test(target)) return null;
  return { mode, target, ...(gesture ? { gesture } : {}) };
}

const radians = Math.PI / 180;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const bearing = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x) / radians;
const angleDelta = (to: number, from: number) => ((to - from + 540) % 360) - 180;
export const validPoint = (p: Point | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
  && p.x >= 0 && p.y >= 0 && p.x <= 1 && p.y <= 1;
export const maxFrameAge = 15000;
export const defaultSceneConfidence = 0.75;
export function validSceneConfidenceThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 1;
}
export function sceneConfidenceAccepted(score: number, threshold = defaultSceneConfidence): boolean {
  return validSceneConfidenceThreshold(threshold) && Number.isFinite(score) && score >= threshold && score <= 1;
}
export function usableMotionFrame(capturedAt: number, now: number) {
  const age = now - capturedAt;
  return Number.isFinite(capturedAt) && age >= 0 && age <= maxFrameAge;
}
export function recognitionDelayMessage(ageMs: number): string {
  return `从拍摄到视觉识别返回已用 ${ageMs / 1000} 秒。`;
}
const followInterval = 1200;

type ManualCalibration = {
  widthM: number;
  heightM: number;
  stepM: number;
  backwardM?: number;
  turnDeg?: number;
  leftDeg?: number;
  greetingM: number;
};
type AdaptiveCalibration = Pick<EmbodiedCalibration, "stepM" | "backwardM" | "turnDeg" | "leftDeg" | "greetingM">;
type View = { robot: Point; target: Point; approach: Point; heading: number; turnClear: boolean; rearClear: boolean };
type AutoView = {
  robot: Point;
  target: Point;
  approach: Point;
  imageHeading: number;
  distanceM: number;
  approachDistanceM: number;
  turnDeg: number;
  atGreeting: boolean;
  turnClear: boolean;
  rearClear: boolean;
  dominant?: boolean;
};
type TaskRun = {
  task: EmbodiedTask;
  minConfidence: number;
  mode: "manual" | "auto";
  calibration?: ManualCalibration;
  adaptive?: AdaptiveCalibration;
  frameId?: number;
  awaitingChoice: boolean;
  unverifiedPulse?: { direction: EmbodiedDirection; view: View };
  unverifiedAutoPulse?: { direction: EmbodiedDirection; view: AutoView };
  scans?: number;
  scanTotal?: number;
  /** Consecutive settled pulses whose amplitude the frames could not attribute. */
  probes?: number;
  /** Consecutive settled pulses that produced no visible movement. */
  stalls?: number;
  /** Stop trying to learn the amplitude; keep navigating on the reserve. */
  conservativePulse?: boolean;
};

const validPositive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validAngle = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value < 180;

function metricView(scene: EmbodiedObservation, calibration: ManualCalibration): View {
  if (scene.status !== "ready"
    || !validPoint(scene.robot) || !validPoint(scene.headingPoint) || !validPoint(scene.target) || !validPoint(scene.approach)) {
    throw new Error(scene.reason || "画面未能可靠确认机器人、朝向和目标。");
  }
  if (scene.pathClear !== true) throw new Error("通往停靠点的路线被挡，或未能看清地面。");
  const metric = (p: Point) => ({ x: p.x * calibration.widthM, y: p.y * calibration.heightM });
  const robot = metric(scene.robot);
  const front = metric(scene.headingPoint);
  if (distance(robot, front) < 0.005) throw new Error("看不清胸口朝向。");
  return { robot, target: metric(scene.target), approach: metric(scene.approach), heading: bearing(robot, front),
    turnClear: scene.turnClear === true, rearClear: scene.rearClear === true };
}

function autoView(scene: EmbodiedObservation): AutoView {
  if (scene.status !== "ready"
    || !validPoint(scene.robot) || !validPoint(scene.headingPoint) || !validPoint(scene.target) || !validPoint(scene.approach)) {
    throw new Error(scene.reason || "画面未能可靠确认机器人、朝向和目标。");
  }
  if (scene.pathClear !== true) throw new Error("通往停靠点的路线被挡，或未能看清地面。");
  if (distance(scene.robot, scene.headingPoint) < 0.005) throw new Error("看不清胸口朝向。");
  if (typeof scene.distanceM !== "number" || !Number.isFinite(scene.distanceM) || scene.distanceM < 0
    || typeof scene.approachDistanceM !== "number" || !Number.isFinite(scene.approachDistanceM) || scene.approachDistanceM < 0
    || typeof scene.turnDeg !== "number" || !Number.isFinite(scene.turnDeg) || Math.abs(scene.turnDeg) > 180) {
    throw new Error("画面未能可靠估算机器人与目标的距离和偏转角度。");
  }
  return {
    robot: scene.robot,
    target: scene.target,
    approach: scene.approach,
    imageHeading: bearing(scene.robot, scene.headingPoint),
    distanceM: scene.distanceM,
    approachDistanceM: scene.approachDistanceM,
    turnDeg: scene.turnDeg,
    atGreeting: scene.atGreeting === true,
    turnClear: scene.turnClear === true,
    rearClear: scene.rearClear === true,
    dominant: scene.searchView === "dominant",
  };
}

function greetingTolerance(range: number, c: ManualCalibration) {
  const span = range < c.greetingM && c.backwardM && c.backwardM > 0 ? c.backwardM : c.stepM;
  return Math.min(span * 0.6, c.greetingM * 0.25);
}

function atGreetingPoint(view: View, c: ManualCalibration) {
  const range = distance(view.robot, view.target);
  const tolerance = greetingTolerance(range, c);
  return Math.abs(range - c.greetingM) <= tolerance
    && distance(view.robot, view.approach) <= tolerance;
}

const pulseField = { forward: "stepM", backward: "backwardM", right: "turnDeg", left: "leftDeg" } as const;
// Reserve the full range of linear travel that we accept for a first observation.
// This clearance is not a prediction of how far the selected pulse will move.
const firstPulseClearanceM = 0.8;

function pulsePlan(direction: EmbodiedDirection, c: AdaptiveCalibration, conservative = false) {
  const label = { forward: "前进", backward: "后退", left: "左转", right: "右转" }[direction];
  const unit = direction === "left" || direction === "right" ? "转角" : "位移";
  const estimate = c[pulseField[direction]];
  if (estimate === undefined) {
    return conservative
      ? `先${label}一次，幅度按保守值估算，停下后用新画面核对距离。`
      : `先${label}一次，停稳后用新画面估算这次${unit}。`;
  }
  const amount = unit === "转角" ? `${Math.round(estimate)}°` : `${estimate.toFixed(2)} 米`;
  return `先${label}一次，预计 ${amount}。`;
}

function decide(view: View, calibration: ManualCalibration, gesture?: EmbodiedGesture): EmbodiedDirection | "arrived" {
  const { robot, approach, target, heading } = view;
  const { greetingM } = calibration;
  const range = distance(robot, target);
  const tolerance = greetingTolerance(range, calibration);
  const near = atGreetingPoint(view, calibration);
  const tooClose = range < greetingM - tolerance;
  const aim = near || tooClose ? target : approach;
  const error = angleDelta(bearing(robot, aim), heading);
  const turn = error < 0 ? "left" : "right";
  const turnDeg = error < 0 ? calibration.leftDeg : calibration.turnDeg;
  const aligned = turnDeg && Number.isFinite(turnDeg) && turnDeg > 0 && turnDeg < 180
    ? Math.min(20, Math.max(5, turnDeg * 0.55)) : 5;
  if (near && (!gesture || Math.abs(error) <= aligned)) return "arrived";
  if (Math.abs(error) > aligned) {
    if (!view.turnClear) throw new Error("没有确认原地转身的净空。");
    if (turnDeg !== undefined && turnDeg >= 2 * Math.abs(error)) throw new Error("当前转向点动幅度过大，无法对准停靠点。");
    return turn;
  }
  if (tooClose && !view.rearClear) throw new Error("距离目标过近，无法确认身后一步有空地。");
  const step = tooClose ? "backward" : "forward";
  const stepM = tooClose ? calibration.backwardM ?? firstPulseClearanceM : calibration.stepM;
  if (!tooClose && distance(robot, approach) + 0.001 < stepM) throw new Error("剩余可见通路不足一个点动步幅。");
  const sign = tooClose ? -1 : 1;
  const next = { x: robot.x + sign * stepM * Math.cos(heading * radians), y: robot.y + sign * stepM * Math.sin(heading * radians) };
  if (next.x < 0 || next.y < 0 || next.x > calibration.widthM || next.y > calibration.heightM) throw new Error("下一步将超出标定场地。");
  // Check clearance over the complete predicted pulse, including its midpoint.
  const t = Math.max(0, Math.min(1, ((target.x - robot.x) * (next.x - robot.x) + (target.y - robot.y) * (next.y - robot.y)) / (stepM * stepM)));
  const nearest = { x: robot.x + t * (next.x - robot.x), y: robot.y + t * (next.y - robot.y) };
  if (!tooClose && distance(nearest, target) < greetingM - tolerance) throw new Error("按实测步幅，下一步会过于靠近目标。");
  if (tooClose && Math.abs(distance(next, target) - greetingM) >= greetingM - range) throw new Error("当前后退点动幅度无法安全调整招呼距离。");
  return step;
}

function checkPulse(direction: EmbodiedDirection, before: View, after: View, calibration: ManualCalibration): string {
  const magnitude = calibration[pulseField[direction]];
  if (direction === "left" || direction === "right") {
    const change = angleDelta(after.heading, before.heading) * (direction === "right" ? 1 : -1);
    if (change < (magnitude === undefined ? 3 : magnitude * 0.15) || change > (magnitude === undefined ? 90 : magnitude * 2.5)
      || distance(before.robot, after.robot) > calibration.stepM * 0.5) throw new Error("前后画面的位移或转角与原地转向点动不符。");
    if (magnitude === undefined) calibration[pulseField[direction]] = change;
    return `实测${direction === "left" ? "左" : "右"}转 ${Math.round(change)}°`;
  }
  const moved = verifyTranslation(direction, before, after, magnitude, true);
  if (direction === "backward" && magnitude === undefined) calibration.backwardM = moved;
  return `实测${direction === "forward" ? "前进" : "后退"} ${moved.toFixed(2)} 米`;
}

function verifyTranslation(direction: CountedWalk["direction"], before: Pick<View, "robot" | "heading">,
  after: Pick<View, "robot" | "heading">, measuredMetres?: number, metric = false): number {
  const dx = after.robot.x - before.robot.x;
  const dy = after.robot.y - before.robot.y;
  const headingX = Math.cos(before.heading * radians);
  const headingY = Math.sin(before.heading * radians);
  const along = (dx * headingX + dy * headingY) * (direction === "forward" ? 1 : -1);
  const across = Math.abs(dy * headingX - dx * headingY);
  const moved = Math.hypot(dx, dy);
  // Without a metric floor projection we can still verify visible movement in
  // the instructed direction. These bounds are fractions of the camera frame.
  const minAlong = measuredMetres === undefined ? (metric ? 0.03 : 0.003) : measuredMetres * 0.15;
  const maxTravel = measuredMetres === undefined ? (metric ? firstPulseClearanceM : 0.35) : measuredMetres * 2.5;
  if (along < minAlong || moved > maxTravel
    || across > Math.max(measuredMetres === undefined ? 0.003 : measuredMetres * 0.2, along * Math.tan(25 * radians))
    || Math.abs(angleDelta(after.heading, before.heading)) > 25) throw new Error("前后画面的行进方向或位移与点动标定不符。");
  return moved;
}

export interface WalkPose { robot: Point; headingPoint: Point }

/** Ego-camera check: a tracked floor point moves down when the robot walks forward. */
export function verifyDominantGroundShift(direction: CountedWalk["direction"], before: WalkPose, after: WalkPose) {
  const along = direction === "forward" ? after.robot.y - before.robot.y : before.robot.y - after.robot.y;
  const across = Math.abs(after.robot.x - before.robot.x);
  if (!(along >= 0.012) || across > Math.max(0.12, along * 2)) {
    throw new Error("主导视角下，前后画面的地面参照没有沿指令方向移动。");
  }
}

export function verifyWalkDisplacement(direction: CountedWalk["direction"], before: WalkPose, after: WalkPose,
  calibration: EmbodiedCalibration, stepM?: number) {
  const metric = calibration.auto === false && validPositive(calibration.widthM) && validPositive(calibration.heightM);
  const scale = (p: Point) => metric ? { x: p.x * calibration.widthM!, y: p.y * calibration.heightM! } : p;
  const view = (pose: WalkPose) => {
    const robot = scale(pose.robot);
    return { robot, heading: bearing(robot, scale(pose.headingPoint)) };
  };
  verifyTranslation(direction, view(before), view(after), metric ? stepM : undefined, metric);
}

function autoTolerance(range: number, c: AdaptiveCalibration) {
  const span = (range < c.greetingM ? c.backwardM : c.stepM) ?? 0;
  return Math.min(Math.max(0.12, span * 0.65), c.greetingM * 0.35);
}

function autoAtGreeting(view: AutoView, c: AdaptiveCalibration) {
  const tol = autoTolerance(view.distanceM, c);
  return (view.atGreeting && Math.abs(view.distanceM - c.greetingM) <= tol * 1.5)
    || (Math.abs(view.distanceM - c.greetingM) <= tol && view.approachDistanceM <= tol);
}

function decideAuto(view: AutoView, c: AdaptiveCalibration, gesture?: EmbodiedGesture, conservative = false): EmbodiedDirection | "arrived" {
  const tol = autoTolerance(view.distanceM, c);
  const near = autoAtGreeting(view, c);
  const tooClose = !near && view.distanceM < c.greetingM - tol;
  const turn = view.turnDeg < 0 ? "left" : "right";
  const turnEst = view.turnDeg < 0 ? c.leftDeg : c.turnDeg;
  const aligned = Math.min(22, Math.max(8, (turnEst ?? 0) * 0.6));
  if (near && (!gesture || Math.abs(view.turnDeg) <= aligned)) return "arrived";
  if (Math.abs(view.turnDeg) > aligned) {
    if (!view.turnClear) throw new Error("没有确认原地转身的净空。");
    if (turnEst !== undefined && turnEst >= 2 * Math.abs(view.turnDeg)) throw new Error("按当前转角，一次点动无法对准目标。");
    return turn;
  }
  if (tooClose) {
    const retreat = c.backwardM ?? firstPulseClearanceM;
    if (!view.rearClear) throw new Error("距离目标过近，无法确认身后一步有空地。");
    if (retreat >= 2 * (c.greetingM - view.distanceM)) throw new Error("后退一次可能超过招呼距离。");
    return "backward";
  }
  const minSafe = Math.max(0.25, c.greetingM - tol * 1.5);
  const step = c.stepM ?? firstPulseClearanceM;
  // Once the camera has failed to measure a pulse, the operator needs to know
  // which control actually unlocks the last stretch.
  const hint = conservative ? "可以在任务参数里填写“前进一步”的实测值。" : "";
  if (c.stepM === undefined && view.approachDistanceM < step) {
    throw new Error(`还未估出前进一步的距离，首次点动需要至少 ${firstPulseClearanceM} 米可见通路。${hint}`);
  }
  if (view.approachDistanceM + 0.001 < step) throw new Error("剩余可见通路不足一个点动步幅。");
  if (view.distanceM - step < minSafe) throw new Error(`按当前步幅，下一步会过于靠近目标。${hint}`);
  return "forward";
}

function updateAdaptive(c: AdaptiveCalibration, direction: EmbodiedDirection, measuredValue: number) {
  const field = pulseField[direction];
  const prior = c[field];
  c[field] = prior === undefined ? measuredValue : (prior + measuredValue) / 2;
}

// The robot ended visibly where it started: either the write never reached it
// or it is blocked. The two look identical, so the probe may be retried once.
class StalledPulseError extends Error {}
/** Two consecutive probes may fail to measure a pulse before the task stops
 * trying to learn the amplitude, but it never stops navigating. */
const unmeasuredProbeBudget = 2;
const stalledProbeBudget = 1;

function checkDominantPulse(direction: EmbodiedDirection, before: AutoView, after: AutoView, c: AdaptiveCalibration): string {
  if (direction === "left" || direction === "right") {
    const sign = direction === "right" ? 1 : -1;
    const deltaTurn = angleDelta(before.turnDeg, after.turnDeg) * sign;
    const visual = (before.target.x - after.target.x) * sign;
    if (c[pulseField[direction]] === undefined && visual < 0.01) {
      throw new Error("主导视角中的目标位置未随转身向预期方向变化，无法估算转角。");
    }
    if (deltaTurn < -15 && visual < 0.01) throw new Error("前后画面的转向方向与指令不符。");
    if (deltaTurn < 3 && visual < 0.01) throw new StalledPulseError("主导视角未检测到有效转向。");
    if (deltaTurn >= 5 && deltaTurn <= 90) {
      updateAdaptive(c, direction, deltaTurn);
      return `画面估算${direction === "left" ? "左" : "右"}转约 ${Math.round(deltaTurn)}°。`;
    }
    return "已核对主导视角的转向。";
  }
  const sign = direction === "forward" ? 1 : -1;
  const deltaDist = (before.distanceM - after.distanceM) * sign;
  const flow = (after.target.y - before.target.y) * sign;
  if (c[pulseField[direction]] === undefined && (flow < 0.012 || Math.abs(before.target.x - after.target.x) > 0.05)) {
    throw new Error("主导视角中的目标位置未随点动向预期方向变化，无法估算步幅。");
  }
  const expected = c[pulseField[direction]] ?? 0;
  if (deltaDist < -Math.max(0.12, expected * 0.8) && flow < 0.01) throw new Error("前后画面的行进方向与指令不符。");
  if (deltaDist < 0.03 && flow < 0.012) throw new StalledPulseError("主导视角未检测到有效移动，请检查是否受阻或打滑。");
  if (deltaDist >= 0.03 && deltaDist <= firstPulseClearanceM && (distance(before.target, after.target) <= 0.05
    || (flow >= 0.012 && Math.abs(before.target.x - after.target.x) <= 0.05))) {
    updateAdaptive(c, direction, deltaDist);
    return `画面估算${direction === "forward" ? "前进" : "后退"}约 ${deltaDist.toFixed(2)} 米。`;
  }
  return "已核对主导视角的移动。";
}

/** Verifies one settled pulse. `learned` reports whether the frames pinned the
 * amplitude down; a verified pulse whose amplitude stays unknown is a gap in
 * the camera estimate, not a reason to stop driving. */
type PulseCheck = { note: string; learned: boolean };

function checkAutoPulse(direction: EmbodiedDirection, before: AutoView, after: AutoView, c: AdaptiveCalibration): PulseCheck {
  const note = measureAutoPulse(direction, before, after, c);
  return { note, learned: c[pulseField[direction]] !== undefined };
}

function measureAutoPulse(direction: EmbodiedDirection, before: AutoView, after: AutoView, c: AdaptiveCalibration): string {
  if (before.dominant !== after.dominant) throw new Error("观察视角已变化，无法核对这次点动。");
  if (before.dominant) return checkDominantPulse(direction, before, after, c);
  const targetMoved = distance(before.target, after.target) > 0.05;
  if (direction === "left" || direction === "right") {
    const sign = direction === "right" ? 1 : -1;
    const deltaTurn = angleDelta(before.turnDeg, after.turnDeg) * sign;
    const imgTurn = angleDelta(after.imageHeading, before.imageHeading) * sign;
    if (c[pulseField[direction]] === undefined && (imgTurn < 3 || distance(before.robot, after.robot) > 0.05)) {
      throw new Error("无法从机身位置和朝向确认这次原地转向。");
    }
    if (!targetMoved) {
      if (deltaTurn < -15) throw new Error("前后画面的转向方向与指令不符。");
      if (deltaTurn < 3 && Math.abs(imgTurn) < 3) throw new StalledPulseError("前后画面未检测到有效转向，请检查地面和机器人状态。");
      if (deltaTurn >= 5 && deltaTurn <= 90) {
        updateAdaptive(c, direction, deltaTurn);
        return `画面估算${direction === "left" ? "左" : "右"}转约 ${Math.round(deltaTurn)}°。`;
      }
      return "已核对转向画面。";
    }
    if (Math.abs(imgTurn) < 3 || imgTurn < -10) throw new Error("目标移动期间，前后画面无法确认机器人按指令转向。");
    return `目标已移动，画面中的机身朝向变化约 ${Math.round(imgTurn)}°，已重新估算朝向。`;
  }
  const movedPx = distance(before.robot, after.robot);
  const sign = direction === "forward" ? 1 : -1;
  const deltaDist = (before.distanceM - after.distanceM) * sign;
  const expected = c[pulseField[direction]] ?? 0;
  if (movedPx < 0.003) throw new StalledPulseError("前后画面未检测到有效移动，请检查是否受阻或打滑。");
  const heading = before.imageHeading * radians;
  const projected = ((after.robot.x - before.robot.x) * Math.cos(heading)
    + (after.robot.y - before.robot.y) * Math.sin(heading)) * sign;
  if (projected <= 0 || Math.abs(angleDelta(after.imageHeading, before.imageHeading)) > 35) {
    throw new Error("前后画面的行进方向与指令不符。");
  }
  if (!targetMoved) {
    if (deltaDist < -Math.max(0.12, expected * 0.8)) throw new Error("前后画面的行进方向与指令不符。");
    if (deltaDist >= 0.03 && deltaDist <= firstPulseClearanceM) {
      updateAdaptive(c, direction, deltaDist);
      return `画面估算${direction === "forward" ? "前进" : "后退"}约 ${deltaDist.toFixed(2)} 米。`;
    }
    return "已核对移动画面。";
  }
  return "已核对机身位移。目标已移动，这次点动的幅度暂不参与标定。";
}

function relativeDirectionLabel(turnDeg: number) {
  const abs = Math.abs(turnDeg);
  if (abs <= 12) return "正前方";
  const side = turnDeg < 0 ? "左" : "右";
  return abs > 90 ? `${side}后方` : `${side}前方`;
}

export function createEmbodiedController(driver: EmbodiedDriver) {
  let active: TaskRun | null = null;
  let generation = 0;
  const wait = driver.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  function requestStop(message: string) {
    const issued = generation;
    const failed = (cause: unknown) => {
      if (generation === issued) driver.say(`${message} 停步指令未获确认，请现场核对。${String(cause)}`);
    };
    try {
      const acknowledgement = driver.stop();
      driver.say(message);
      if (acknowledgement) void Promise.resolve(acknowledgement).catch(failed);
    } catch (cause) { failed(cause); }
  }
  function finish(run: TaskRun, message: string, status: "completed" | "failed" | "stopped" = "failed") {
    if (active !== run) return;
    active = null;
    if (status === "completed") driver.say(message);
    else requestStop(message);
    driver.state?.(status, message);
    driver.ended?.();
  }
  async function observeRaw(run: TaskRun): Promise<EmbodiedObservation | null> {
    const requested = Date.now();
    const scene = await driver.observe(run.task.target, run.adaptive ?? run.calibration);
    if (active !== run) return null;
    const captured = scene.capturedAt ?? requested;
    const now = Date.now();
    if (!Number.isFinite(captured) || captured < requested || captured > now) {
      throw new Error("摄像头画面的拍摄时间异常，请确认预览在更新后重试。");
    }
    if (scene.frameId !== undefined && (!Number.isFinite(scene.frameId) || (run.frameId !== undefined && scene.frameId <= run.frameId))) {
      throw new Error("摄像头画面序号没有更新，请确认预览在更新后重试。");
    }
    if (!usableMotionFrame(captured, now)) {
      throw new Error(recognitionDelayMessage(now - captured) + "无法确认当前画面，请重新观察。");
    }
    run.frameId = scene.frameId;
    if (scene.status === "ready" && !sceneConfidenceAccepted(scene.confidence, run.minConfidence)) {
      throw new Error(`行走要求联合置信度至少为 ${run.minConfidence}，本次为 ${scene.confidence}。`);
    }
    if (scene.status === "ambiguous") {
      await driver.stop();
      if (active !== run) return null;
      const choices = scene.reason?.trim();
      const doorAndLectern = !!choices && /靠门|门边|门旁|门口|门附近/u.test(choices) && /讲台/u.test(choices);
      const question = doorAndLectern ? "靠门的那位，还是靠讲台的那位？"
        : choices && /[？?]$/u.test(choices) ? choices : (choices || "画面里有多个匹配目标。") + "您指的是哪一位？";
      if (driver.ask) await driver.ask(doorAndLectern);
      if (active !== run) return null;
      run.awaitingChoice = true;
      driver.say(question);
      driver.state?.("awaitingChoice", question);
      return null;
    }
    return scene;
  }
  function needsDominantScan(scene: EmbodiedObservation, threshold: number): boolean {
    if (scene.status !== "lost" || scene.searchView !== "dominant") return false;
    if (scene.turnClear !== true || !sceneConfidenceAccepted(scene.confidence, threshold)) {
      throw new Error(scene.reason || "目标不在主导视角内，且无法确认可以转身寻找。");
    }
    return true;
  }
  async function lookAround(run: TaskRun) {
    if (run.unverifiedAutoPulse || run.unverifiedPulse) throw new Error("点动后目标离开画面，无法核对这次动作。");
    const streak = (run.scans ?? 0) + 1;
    const total = (run.scanTotal ?? 0) + 1;
    if (streak > 4 || total > 12) throw new Error("主导视角已转身寻找，仍未看到目标。");
    run.scans = streak;
    run.scanTotal = total;
    const c = run.adaptive ?? run.calibration!;
    const direction = c.turnDeg === undefined && c.leftDeg !== undefined ? "left" : "right";
    driver.say(`主导视角里还没有${run.task.target}，先向${direction === "right" ? "右" : "左"}转一下再看。`);
    if (active !== run) return;
    await driver.pulse(direction);
  }
  async function observeManual(run: TaskRun): Promise<View | "scan" | null> {
    const scene = await observeRaw(run);
    if (!scene || active !== run) return null;
    if (needsDominantScan(scene, run.minConfidence)) return "scan";
    return metricView(scene, run.calibration!);
  }
  async function observeAuto(run: TaskRun): Promise<AutoView | "scan" | null> {
    const scene = await observeRaw(run);
    if (!scene || active !== run) return null;
    if (needsDominantScan(scene, run.minConfidence)) return "scan";
    return autoView(scene);
  }
  async function executeManual(run: TaskRun) {
    let lastView: View | undefined;
    let arrival: { target: Point; measured: string } | undefined;
    let followAnchor: Point | undefined;
    const c = run.calibration!;
    const targetNeighborhood = Math.max(c.stepM, c.greetingM * 0.75);
    try {
      while (active === run) {
        const view = await observeManual(run);
        if (!view || active !== run) return;
        if (view === "scan") { await lookAround(run); continue; }
        run.scans = 0;
        const previous = run.unverifiedPulse;
        const prior = lastView;
        lastView = view;
        if (prior && distance(prior.target, view.target) > targetNeighborhood) {
          throw new Error("目标位置跳变，无法确认仍是同一个目标。");
        }
        if (prior && !previous && (distance(prior.robot, view.robot) > c.stepM * 0.5
          || Math.abs(angleDelta(prior.heading, view.heading)) > Math.min(25, Math.max(5, (c.turnDeg ?? 0) * 0.5)))) {
          throw new Error("机器人停稳期间的位置或朝向发生了变化。");
        }
        const measured = previous ? checkPulse(previous.direction, previous.view, view, c) + "。" : "";
        run.unverifiedPulse = undefined;
        const range = distance(view.robot, view.target);
        if (run.task.mode === "follow") {
          // Consume a change in the target's world position once, including slow
          // motion that happens between successive observations. Use the
          // same robot position in both distances so its own pulse cannot count.
          followAnchor ??= view.target;
          const recession = range - distance(view.robot, followAnchor);
          const noise = Math.max(0.025, c.stepM * 0.25);
          const withinRange = range <= c.greetingM + c.stepM * 0.6;
          if (recession < -noise || withinRange) followAnchor = view.target;
          if (recession <= noise || withinRange) {
            driver.say(`${measured}正在等候，目标距离 ${range.toFixed(2)} 米。`);
            await wait(followInterval);
            continue;
          }
          followAnchor = view.target;
        }
        const direction = decide(view, c, run.task.gesture);
        if (direction === "arrived") {
          if (run.task.mode === "follow") { await wait(followInterval); continue; }
          const tolerance = greetingTolerance(range, c);
          if (run.task.gesture && (!arrival || distance(arrival.target, view.target) > tolerance)) {
            arrival = { target: view.target, measured };
            driver.say("已到达招呼位置，正在用新画面确认。");
            await wait(300);
            continue;
          }
          await driver.stop();
          if (active !== run) return;
          if (run.task.gesture) await driver.gesture(run.task.gesture);
          if (active !== run) return;
          if (run.task.gesture === "wave") await driver.greet();
          if (active === run) finish(run, `${arrival?.measured || measured}画面确认已停在${run.task.target}旁，距离 ${range.toFixed(2)} 米。`, "completed");
          return;
        }
        arrival = undefined;
        const remaining = distance(view.robot, view.approach);
        const aim = atGreetingPoint(view, c) || range < c.greetingM - greetingTolerance(range, c) ? view.target : view.approach;
        const offset = angleDelta(bearing(view.robot, aim), view.heading);
        const alignment = Math.abs(offset) < 1 ? "已对准" : `朝向相差${Math.abs(Math.round(offset))}°（${offset < 0 ? "左" : "右"}）`;
        driver.say(`${measured}距停靠点 ${remaining.toFixed(2)} 米，${alignment}。${pulsePlan(direction, c)}`);
        if (active !== run) return;
        run.unverifiedPulse = { direction, view };
        await driver.pulse(direction);
      }
    } catch (error) {
      finish(run, `课堂任务已中止。${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Verify the pulse that just settled. Every frame re-measures the robot's
  // absolute position, so an amplitude the frames cannot attribute is a gap in
  // the camera estimate rather than a contradiction: navigation continues on the
  // conservative reserve and keeps trying to learn. Only a pulse that moved
  // nothing is retried, because a dropped write and an obstacle look identical.
  async function recheckPulse(run: TaskRun, previous: TaskRun["unverifiedAutoPulse"], view: AutoView): Promise<string | "retry" | null> {
    if (!previous) return "";
    const c = run.adaptive!;
    const known = c[pulseField[previous.direction]] !== undefined;
    try {
      const check = checkAutoPulse(previous.direction, previous.view, view, c);
      run.unverifiedAutoPulse = undefined;
      if (check.learned) {
        run.probes = 0;
        run.stalls = 0;
        run.conservativePulse = false;
        return check.note;
      }
      const unit = previous.direction === "left" || previous.direction === "right" ? "转角" : "步幅";
      run.probes = (run.probes ?? 0) + 1;
      if (run.probes >= unmeasuredProbeBudget && !run.conservativePulse) {
        run.conservativePulse = true;
        driver.say(`${check.note}连续 ${run.probes} 次点动都估不出${unit}，改为按保守幅度逐帧核对着走。`);
      } else if (!run.conservativePulse) {
        driver.say(`${check.note}这次点动的${unit}还没估出来，下一次点动后再核算。`);
      }
      return check.note;
    } catch (cause) {
      if (!(cause instanceof StalledPulseError)) throw cause;
      if (known || (run.stalls ?? 0) >= stalledProbeBudget) throw cause;
      run.stalls = (run.stalls ?? 0) + 1;
      run.unverifiedAutoPulse = undefined;
      driver.say(`${cause.message}点动可能没有发出，重试一次。`);
      return "retry";
    }
  }
  async function executeAuto(run: TaskRun) {
    let lastView: AutoView | undefined;
    let arrival: { distanceM: number; measured: string } | undefined;
    let followAnchor: AutoView | undefined;
    const c = run.adaptive!;
    try {
      while (active === run) {
        const view = await observeAuto(run);
        if (!view || active !== run) return;
        if (view === "scan") { await lookAround(run); continue; }
        run.scans = 0;
        const previous = run.unverifiedAutoPulse;
        const prior = lastView;
        lastView = view;
        if (prior && view.dominant && !previous) {
          const imageJump = distance(prior.target, view.target);
          if (imageJump > 0.45 && Math.abs(view.distanceM - prior.distanceM) > 0.5) {
            throw new Error("目标位置跳变，无法确认仍是同一个目标。");
          }
        } else if (prior && !view.dominant && distance(prior.target, view.target) > (previous ? 0.30 : 0.25)) {
          throw new Error("目标位置跳变，无法确认仍是同一个目标。");
        }
        if (prior && !previous && view.dominant) {
          if (Math.abs(view.distanceM - prior.distanceM) > 0.35) {
            throw new Error("机器人停稳期间，主导视角里的目标距离发生了变化。");
          }
        } else if (prior && !previous && (distance(prior.robot, view.robot) > 0.08
          || Math.abs(angleDelta(prior.imageHeading, view.imageHeading)) > 25)) {
          throw new Error("机器人停稳期间的位置或朝向发生了变化。");
        }
        const measured = await recheckPulse(run, previous, view);
        if (measured === null) return;
        if (measured === "retry") continue;
        run.unverifiedAutoPulse = undefined;
        if (run.task.mode === "follow") {
          followAnchor ??= view;
          const step = c.stepM ?? 0;
          const noise = Math.max(0.10, step * 0.5);
          const withinRange = autoAtGreeting(view, c) || view.distanceM <= c.greetingM + Math.max(0.15, step * 0.8);
          // Compare both target sightings from the current foot position if our
          // own pulse moved the camera subject. A stationary target grants no pulse.
          const targetShift = distance(view.target, followAnchor.target);
          const currentSpan = distance(view.robot, view.target);
          const recession = distance(view.robot, followAnchor.robot) < 0.005
            ? view.distanceM - followAnchor.distanceM
            : (currentSpan - distance(view.robot, followAnchor.target)) * view.distanceM / Math.max(currentSpan, 0.005);
          if (withinRange || recession <= noise || targetShift < 0.01) {
            if (withinRange || recession < -noise || (previous && targetShift < 0.01)) followAnchor = view;
            driver.say(`${measured}正在等候，目标距离约 ${view.distanceM.toFixed(2)} 米。`);
            await wait(followInterval);
            continue;
          }
          followAnchor = view;
        }
        const direction = decideAuto(view, c, run.task.gesture, run.conservativePulse);
        if (direction === "arrived") {
          if (run.task.mode === "follow") {
            followAnchor = view;
            await wait(followInterval);
            continue;
          }
          const tol = autoTolerance(view.distanceM, c);
          if (run.task.gesture && (!arrival || Math.abs(arrival.distanceM - view.distanceM) > tol)) {
            arrival = { distanceM: view.distanceM, measured };
            driver.say("已到达招呼位置，正在用新画面确认。");
            await wait(300);
            continue;
          }
          await driver.stop();
          if (active !== run) return;
          if (run.task.gesture) await driver.gesture(run.task.gesture);
          if (active !== run) return;
          if (run.task.gesture === "wave") await driver.greet();
          if (active === run) finish(run, `${arrival?.measured || measured}画面确认已停在${run.task.target}旁，距离约 ${view.distanceM.toFixed(2)} 米。`, "completed");
          return;
        }
        arrival = undefined;
        const rel = relativeDirectionLabel(view.turnDeg);
        const alignment = Math.abs(view.turnDeg) < 1 ? "已对准" : `朝向相差约 ${Math.abs(Math.round(view.turnDeg))}°`;
        driver.say(`${measured}看到${run.task.target}了，在我${rel}，距停靠点约 ${view.approachDistanceM.toFixed(2)} 米（${alignment}）。${pulsePlan(direction, c, run.conservativePulse)}`);
        if (active !== run) return;
        run.unverifiedAutoPulse = { direction, view };
        await driver.pulse(direction);
      }
    } catch (error) {
      finish(run, `课堂任务已中止。${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const execute = (run: TaskRun) => (run.mode === "auto" ? executeAuto(run) : executeManual(run));
  return {
    start(task: EmbodiedTask) {
      if (active) { driver.say("视觉任务进行中，请先停止当前任务。"); return; }
      const raw = { ...driver.calibration() };
      const minConfidence = raw.minConfidence ?? defaultSceneConfidence;
      if ([raw.turnDeg, raw.leftDeg].some(angle => angle !== undefined && !validAngle(angle))
        || [raw.stepM, raw.backwardM].some(span => span !== undefined && (!validPositive(span) || span > 100))) {
        const message = "请检查手动填写的步幅或转角，也可以留空让摄像头估算。";
        driver.say(message);
        driver.state?.("failed", message);
        driver.ended?.();
        return;
      }
      if (raw.auto) {
        const adaptive: AdaptiveCalibration = {
          greetingM: validPositive(raw.greetingM) ? raw.greetingM : 0.8,
          stepM: raw.stepM, backwardM: raw.backwardM, turnDeg: raw.turnDeg, leftDeg: raw.leftDeg,
        };
        active = { task: { ...task }, minConfidence, mode: "auto", adaptive, awaitingChoice: false };
        generation++;
        const message = `正在自动观察${task.target}和周围通路。`;
        driver.say(message);
        driver.state?.("running", message);
        void execute(active);
        return;
      }
      if (![raw.widthM, raw.heightM, raw.stepM, raw.greetingM].every(validPositive)
        || Math.max(raw.backwardM ?? 0, raw.stepM as number) > Math.hypot(raw.widthM as number, raw.heightM as number)) {
        const message = "请检查场地尺寸、招呼距离和已填写的点动参数。";
        driver.say(message);
        driver.state?.("failed", message);
        driver.ended?.();
        return;
      }
      const calibration: ManualCalibration = {
        widthM: raw.widthM as number,
        heightM: raw.heightM as number,
        stepM: raw.stepM as number,
        turnDeg: raw.turnDeg,
        greetingM: raw.greetingM,
        backwardM: raw.backwardM,
        leftDeg: raw.leftDeg,
      };
      active = { task: { ...task }, minConfidence, mode: "manual", calibration, awaitingChoice: false };
      generation++;
      const message = `正在观察${task.target}和周围通路。`;
      driver.say(message);
      driver.state?.("running", message);
      void execute(active);
    },
    clarify(answer: string) {
      if (!active?.awaitingChoice || !answer.trim()) return false;
      const qualified = `${active.task.target}（${answer.trim()}）`;
      if (Array.from(qualified).length > 80) { driver.say("请用更短的方位描述指明目标。"); return true; }
      active.task.target = qualified;
      active.awaitingChoice = false;
      driver.state?.("running", `正在重新确认${qualified}。`);
      void execute(active);
      return true;
    },
    stop(reason = "已停止视觉任务。") {
      if (active) finish(active, reason, "stopped");
      else requestStop(reason);
    },
    isActive: () => active !== null,
  };
}
