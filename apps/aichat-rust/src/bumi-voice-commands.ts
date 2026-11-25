import { parseCountedWalk, parseEmbodiedTask, walkIntentCandidate, type CountedWalk, type EmbodiedDirection } from "./bumi-embodied";

export type StepDirection = EmbodiedDirection | "strafeLeft" | "strafeRight";
export type SpokenWalkIntent = { walkText: string; expected: CountedWalk };

interface SpokenSteps {
  step?: StepDirection;
  walk?: CountedWalk;
  hint?: string;
  intent?: SpokenWalkIntent;
}
const singleSteps: [RegExp, StepDirection][] = [
  [/^(?:向|往)?左移[一1]步$/u, "strafeLeft"],
  [/^(?:向|往)?右移[一1]步$/u, "strafeRight"],
  [/^(?:向|往)?左转[一1]下$/u, "left"],
  [/^(?:向|往)?右转[一1]下$/u, "right"],
];

export function parseSpokenSteps(phrase: string): SpokenSteps {
  const walk = parseCountedWalk(phrase);
  if (typeof walk === "string") return { hint: walk };
  if (walk) return walk.count === 1 ? { step: walk.direction } : { walk };
  const step = singleSteps.find(([pattern]) => pattern.test(phrase))?.[1];
  if (step) return { step };
  const expected = walkIntentCandidate(phrase);
  return expected ? { intent: { walkText: phrase, expected } } : {};
}

// Only complete, single imperatives are executable. Questions, negations and
// compound requests must not accidentally turn into a physical action.
export function isStopCommand(sentence: string) {
  const phrase = sentence.trim().replace(/[。！!]+$/u, "");
  return /^(?:(?:请|先|马上|立即|赶快)\s*)*(?:停下来|停下|停止移动|停止跟随|停止行走|停止|停|别走了|不要走了|取消导航)(?:吧|一下)?(?:$|[，,。！!])/u.test(phrase);
}

export function withoutAddress(raw: string) {
  return raw.trim().replace(/^(?:(?:小布米|布米|Bumi|机器人)[，,\s]*)?(?:请你|请)?/iu, "").trim();
}
export function commandSentence(raw: string) {
  return withoutAddress(raw).replace(/[。！!\s]+$/u, "");
}
export function observationRequest(sentence: string): string | undefined {
  return /^(?:只(?:看(?:看|一下)?|识别(?:一下)?)|看一看|看看|看一下|识别(?:一下)?)\s*[：:]?\s*(.*)$/u.exec(sentence)?.[1].trim();
}
export function inspectionTarget(raw: string): string {
  const sentence = commandSentence(raw);
  if (isStopCommand(sentence)) return "";
  return observationRequest(sentence) ?? parseEmbodiedTask(sentence)?.target ?? sentence;
}
export function normalizeVoice(raw: string) {
  return raw.trim().replace(/[。！？!?,，.\s]/g, "");
}

export function remoteVoiceExamples(snapshot: {
  remoteVoiceGestures?: boolean;
  guidedMotionVersion?: number;
  sceneWalkPathVersion?: number;
  remoteVoiceStepDirections?: boolean;
  sceneVisionVersion?: number;
  sceneInspectionVersion?: number;
}, gestureNames: Iterable<string>) {
  const gestures = snapshot.remoteVoiceGestures === true ? [...gestureNames] : ["跳舞"];
  const steps = snapshot.guidedMotionVersion === 1 ? ["向前走一步", "向左转一下"] : [];
  if (snapshot.sceneWalkPathVersion === 1) steps.push("往后走两步");
  if (steps.length && snapshot.remoteVoiceStepDirections === true) steps.push("后退一步", "向右移一步");
  const classroomExample = snapshot.sceneVisionVersion === 1 ? ["走到讲台旁边", "跟着靠门的人"] : [];
  if (snapshot.sceneInspectionVersion === 1) classroomExample.unshift("看看垃圾桶");
  return [...steps, ...gestures, ...classroomExample, "停止"].map(name => `“${name}”`).join("、");
}
