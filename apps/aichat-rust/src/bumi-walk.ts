import { invoke } from "@tauri-apps/api/core";
import type { CountedWalk } from "./bumi-embodied";
import { observeWalkPath, type ClassroomFrameSource } from "./bumi-classroom-vision";
import type { SpokenWalkIntent } from "./bumi-voice-commands";

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
