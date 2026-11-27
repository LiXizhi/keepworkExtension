import { invoke } from "@tauri-apps/api/core";
import type { CountedWalk } from "./bumi-embodied";
import { observeWalkContinue, observeWalkPath, type ClassroomFrameSource } from "./bumi-classroom-vision";
import type { SpokenWalkIntent } from "./bumi-voice-commands";

export const MAX_AUTO_FORWARD_STEPS = 10;

// The model can confirm the single direction and number present in the
// utterance. Motor commands are issued only by the owning classroom task.
export async function verifyWalkIntent(intent: SpokenWalkIntent) {
  const result = await invoke<{ walkIntent?: CountedWalk }>("bumi_control", {
    request: { operation: "interpretWalk", text: intent.walkText },
  });
  const walk = result.walkIntent;
  if (!walk || walk.direction !== intent.expected.direction || walk.count !== intent.expected.count
    || !Number.isInteger(walk.count) || walk.count < 1 || walk.count > 10) {
    throw new Error("AI 无法核对这句话里的方向和步数，请说清楚，例如“向前走三步”。");
  }
}

export async function executeCountedWalk(walk: CountedWalk, current: () => ClassroomFrameSource,
  pulse: (direction: CountedWalk["direction"]) => Promise<void>, say: (message: string) => void) {
  const label = walk.direction === "forward" ? "前进" : "后退";
  say(`准备${label}${walk.count}步，正在检查通路。`);
  let previous = await observeWalkPath(current, walk.direction);
  for (let i = 1; i <= walk.count; i++) {
    current();
    say(`正在${label}第 ${i}/${walk.count} 步。`);
    await pulse(walk.direction);
    previous = await observeWalkPath(current, walk.direction, previous, i < walk.count);
  }
  current();
  return `已按指令${label}${walk.count}步，已逐步核对画面并发送停止指令。`;
}

// After each settled forward pulse, capture one fresh frame from whichever camera
// is active (fixed classroom camera or built-in forward camera) and ask the LLM
// whether the robot should keep walking forward.
export async function executeForwardContinueWalk(
  current: () => ClassroomFrameSource,
  pulse: (requireFrame: boolean) => Promise<void>,
  say: (message: string) => void,
  maxSteps = MAX_AUTO_FORWARD_STEPS,
) {
  let steps = 0;
  let lastCapturedAt: number | undefined;
  while (steps < maxSteps) {
    current();
    steps++;
    say(steps === 1 ? "正在向前移动，完成后将自动截屏判断是否继续行走。" : `AI 判断可继续行走，正在前进第 ${steps} 步。`);
    await pulse(steps > 1);
    current();
    say(`已完成第 ${steps} 步前进，正在截取当前画面并交由 AI 判断是否继续行走。`);
    const verdict = await observeWalkContinue(current, lastCapturedAt);
    lastCapturedAt = verdict.capturedAt;
    const reason = verdict.reason ? `（${verdict.reason}）` : "";
    if (!verdict.proceed) {
      return `已前进 ${steps} 步，AI 判断停止继续行走${reason}。`;
    }
    if (steps >= maxSteps) {
      return `已前进 ${steps} 步，AI 判断仍可继续${reason}，已达到单次连续行走上限（${maxSteps} 步）并停止。`;
    }
  }
  return `已前进 ${steps} 步并发送停止指令。`;
}
