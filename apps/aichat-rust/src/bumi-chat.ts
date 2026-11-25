import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseEmbodiedTask, type CountedWalk, type EmbodiedTask, type EmbodiedDirection } from "./bumi-embodied";
import { commandSentence, parseSpokenSteps, type SpokenWalkIntent } from "./bumi-voice-commands";
import { runWorkspaceCmd, type ClassroomFrameSource } from "./bumi-classroom-vision";
import type { BumiClassroomRequest as ChatRequest, BumiClassroomResult as ChatResult } from "./types";

type ChatStatus = ChatResult["status"];
export interface ChatTask {
  id: string;
  owner: string;
  link: string;
  result: ChatResult;
  description?: EmbodiedTask;
  sameCamera?: () => boolean;
  paused?: boolean;
  step?: boolean;
  after?: ChatTask;
}
type ChatOffer = { document: string; connection: string; request: ChatRequest };
interface ChatDriver {
  connection(): string | undefined;
  run(): (ClassroomFrameSource & { chat?: ChatTask }) | undefined;
  busy(): boolean;
  moving(): boolean;
  getCamera(): NonNullable<ClassroomFrameSource["camera"]>;
  watch(): Promise<unknown>;
  say(message: string): void;
  render(): void;
  stop(reason: string, link: string): Promise<void>;
  handshake(): Promise<void>;
  clarify(answer: string): boolean;
  start(task: EmbodiedTask | CountedWalk | SpokenWalkIntent | EmbodiedDirection | "wave" | "greet", owner: ChatTask): Promise<void>;
}
export const isLiveChat = (task?: ChatTask) => !!task && ["accepted", "running", "awaitingChoice", "stopping"].includes(task.result.status);
export function reportChat(task: ChatTask, status: ChatStatus, message: string) {
  task.result = { status, message, taskId: task.id };
  return task.result;
}
function localChatIpc<T>(request: object) { return invoke<T>("bumi_chat_handoff", { request }); }

export function createChatHandoff(driver: ChatDriver) {
  const chatGrant = document.getElementById("chat-classroom-grant") as HTMLInputElement | null;
  let chatLink: string | undefined;
  let stopOnlyLink: string | undefined;
  let chatGrantBusy = false;
  let revocationListener: (() => void) | undefined;
  let chatListener: (() => void) | undefined;
  let activeChat: ChatTask | undefined;
  let pendingStops = 0;
  let preflight: { owner: string; matches: () => boolean } | undefined;
  const chatTasks = new Map<string, ChatTask>();
  function revokeChat(reason: string, reloaded = false) {
    stopOnlyLink = reloaded ? chatLink : undefined;
    chatLink = undefined;
    preflight = undefined;
    if (chatGrant) chatGrant.checked = false;
    const task = activeChat;
    if (task && isLiveChat(task)) {
      task.paused = false;
      reportChat(task, "stopping", reason);
      void driver.stop(reason, task.link).then(
        () => reportChat(task, "stopped", reason + " 停止指令已写入。"),
        cause => reportChat(task, "failed", reason + " 停止指令未获确认。" + String(cause)),
      );
    }
    if (!reloaded) void localChatIpc({ operation: "disable" }).catch(() => {});
  }

  async function receiveChat(ticket: string) {
    let offer: ChatOffer;
    try { offer = await localChatIpc<ChatOffer>({ operation: "claim", ticket }); }
    catch { return; }
    let result: ChatResult;
    try {
      // Native focus and the DOM focus notification can arrive on different turns.
      if (["start", "observe", "clarify"].includes(offer.request.operation)) {
        for (let attempt = 0; attempt < 12 && (!document.hasFocus() || document.hidden); attempt++) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 40));
        }
      }
      result = await handleChat(offer);
    }
    catch (cause) { result = { status: "failed", taskId: offer.request.taskId, message: String(cause) }; }
    await localChatIpc({ operation: "reply", ticket, result }).catch(() => {});
  }
  chatGrant?.addEventListener("change", async () => {
    if (!chatGrant.checked) { revokeChat("本次主聊天控制授权已撤销。"); return; }
    const link = driver.connection();
    if (!link || chatGrantBusy) { chatGrant.checked = false; return; }
    chatGrantBusy = true;
    driver.render();
    try {
      chatListener ??= await listen<string>("bumi:classroom-request", e => { void receiveChat(e.payload); }, { target: "bumi-control" });
      revocationListener ??= await listen("bumi:classroom-revoked", () => {
        revokeChat("主聊天页面已切换，任务已取消。", true);
      }, { target: "bumi-control" });
      await driver.watch();
      await localChatIpc({ operation: "enable", connectionId: link });
      if (driver.connection() !== link || !chatGrant.checked) throw new Error("机器人连接已改变。");
      chatLink = link;
      stopOnlyLink = undefined;
    } catch (cause) {
      revokeChat("本次主聊天控制未启用。");
      driver.say(String(cause));
    } finally { chatGrantBusy = false; driver.render(); }
  });

  async function chatScreenshot(owner: string, task?: ChatTask): Promise<ChatResult> {
    if (task?.sameCamera && !task.sameCamera()) throw new Error("课堂任务使用的摄像头已改变。");
    if (driver.moving()) throw new Error("机器人移动中，请停稳后拍摄。");
    const run = driver.run();
    const temporary = !run?.camera;
    const camera = run?.camera ?? driver.getCamera();
    try {
      const frame = await runWorkspaceCmd({ cmd: "takeCameraScreenshot" }, run?.camera ? run : { camera });
      if (!chatLink || chatLink !== driver.connection() || !camera.isCurrent()) throw new Error("摄像头或机器人连接已改变。");
      if (!task) preflight = { owner, matches: camera.matchesSource };
      return { status: "completed", ...frame, ...(task ? {taskId: task.id} : {}) };
    } finally { if (temporary) camera.release(); }
  }
  function assertChatOwner(offer: ChatOffer) {
    const globalStop = offer.request.operation === "stop" && (!offer.request.taskId || offer.request.global === true);
    const link = chatLink ?? (globalStop ? stopOnlyLink : undefined);
    if (!link || link !== offer.connection || driver.connection() !== link) {
      throw new Error("这次机器人连接尚未向主聊天授权。");
    }
  }
  async function handleChat(offer: ChatOffer): Promise<ChatResult> {
    assertChatOwner(offer);
    const { request, document: owner } = offer;
    const id = request.taskId;
    const existing = id ? chatTasks.get(id) : undefined;
    const globalStop = request.operation === "stop" && (!id || request.global === true);
    const owned = existing?.owner === owner && existing.link === offer.connection;
    if (existing && !owned && !globalStop) {
      if (request.operation === "status") return {status: "unavailable", message: "当前页面没有该任务。"};
      throw new Error("此任务属于另一个页面或连接。");
    }
    if (request.operation === "status") return existing?.result ?? { status: "unavailable", message: "未找到该任务。" };
    if (request.operation === "stop") {
      let scoped = owned ? existing : undefined;
      if (id && !existing) {
        // Stop can overtake delivery of the corresponding start. A scoped
        // cancellation may not interrupt some other active controller.
        scoped = {id, owner, link: offer.connection, result: { status: "stopped", taskId: id, message: "任务已取消。" }};
        chatTasks.set(id, scoped);
        if (!globalStop && (isLiveChat(activeChat) || driver.busy() || driver.moving())) return scoped.result;
      }
      if (!globalStop && existing && !isLiveChat(existing)) return existing.result;
      const affected = new Set<ChatTask>();
      if (scoped) affected.add(scoped);
      if (activeChat && (globalStop || activeChat.after === scoped && scoped !== undefined) && isLiveChat(activeChat)) affected.add(activeChat);
      if (activeChat?.after && affected.has(activeChat) && isLiveChat(activeChat.after)) affected.add(activeChat.after);
      for (const task of affected) {
        task.paused = false;
        reportChat(task, "stopping", "已请求停止。");
      }
      pendingStops++;
      let status: ChatStatus = "stopped";
      let message = "任务已取消，停止指令已写入。";
      try {
        await driver.stop("已收到主聊天停止指令。", offer.connection);
        assertChatOwner(offer);
      } catch (cause) {
        status = "failed";
        message = "停止写入未获确认，请现场核对。" + String(cause);
      } finally { pendingStops--; }
      for (const task of affected) reportChat(task, status, message);
      return {status, message, ...(id ? {taskId: id} : {})};
    }
    if (request.operation === "start" && existing) return existing.result;
    if (!document.hasFocus() || document.hidden) throw new Error("请保持 Bumi 控制窗口在前台。");
    if (request.operation === "observe") {
      if (id && !existing) throw new Error("未找到该任务。");
      if (driver.run() && driver.run()?.chat?.owner !== owner) throw new Error("摄像头正在执行其他课堂任务。");
      return chatScreenshot(owner, existing);
    }
    if (pendingStops) throw new Error("请等停止指令写入后再开始任务。");
    if (request.operation === "clarify") {
      if (!existing || existing !== activeChat || existing.result.status !== "awaitingChoice" || !request.command) throw new Error("任务当前不在等待选择。");
      if (driver.run()?.chat === existing && driver.clarify(request.command)) return existing.result;
      if (!existing.paused || !existing.description || !existing.sameCamera?.()) {
        return reportChat(existing, "failed", "原摄像头或课堂任务已改变，请重新发起任务。");
      }
      const target = existing.description.target + "（" + request.command.trim() + "）";
      if (Array.from(target).length > 80) throw new Error("请用更短的方位描述指明目标。");
      existing.paused = false;
      await driver.start({ ...existing.description, target }, existing);
      return existing.result;
    }
    if (request.operation !== "start" || !id || !request.command) throw new Error("缺少指令或任务 ID。");
    const phrase = commandSentence(request.command);
    const { walk, step, intent, hint } = parseSpokenSteps(phrase);
    if (hint) throw new Error(hint);
    const description = parseEmbodiedTask(phrase);
    const walkCommand = walk ?? intent;
    const counted = walk ?? (intent && intent.expected.count > 1 ? intent.expected : undefined);
    if (counted && preflight?.owner !== owner) throw new Error("请先通过当前教室摄像头获取一张新图，再开始连续步进。");
    if ((description || counted) && preflight?.owner === owner && !preflight.matches()) throw new Error("固定摄像头已切换，请重新拍摄教室画面。");
    const single = step ?? ({"前进":"forward", "后退":"backward", "左转":"left", "右转":"right"} as Record<string, EmbodiedDirection>)[phrase];
    const handshake = phrase === "握手" || phrase === "握个手";
    const after = request.afterTaskId ? chatTasks.get(request.afterTaskId) : undefined;
    if (request.afterTaskId && (!handshake || !after || !after.step || after !== activeChat ||
      after.owner !== owner || after.link !== offer.connection || !["accepted", "running", "completed"].includes(after.result.status))) {
      throw new Error("原点动已取消、未获确认或属于另一个控制任务。");
    }
    if (after && (after.result.status === "completed" ? driver.busy() || driver.moving() : driver.run()?.chat !== after)) {
      throw new Error("原步进已被其他控制接管，无法追加握手。");
    }
    if (!after && (isLiveChat(activeChat) || driver.busy())) throw new Error("请先停止当前机器人控制任务。");
    const wave = /^(?:挥(?:个)?手|打(?:个)?招呼)$/u.test(phrase);
    if (!description && !walkCommand && (!single || single === "strafeLeft" || single === "strafeRight") && !handshake && !wave) throw new Error("不支持这条课堂动作指令。");
    const task: ChatTask = { id, owner, link: offer.connection, result: {status: "accepted", taskId: id}, description: description ?? undefined, step: !!single || intent?.expected.count === 1, after };
    chatTasks.set(id, task);
    activeChat = task;
    try {
      if (handshake) {
        await driver.handshake();
        if (task.result.status === "accepted") reportChat(task, "completed", "握手动作指令已写入。");
      } else if (walkCommand) {
        if (counted) preflight = undefined;
        // Vision checks may outlast the handoff timeout. The original ID owns the
        // run and its receipts while the main chat polls or requests a stop.
        void driver.start(walkCommand, task).catch(cause => {
          if (isLiveChat(task) && task.result.status !== "stopping") reportChat(task, "failed", String(cause));
        });
      } else if (description) {
        await driver.start(description, task);
      } else if (wave) {
        await driver.start(phrase.startsWith("打") ? "greet" : "wave", task);
      } else if (single === "forward" || single === "backward" || single === "left" || single === "right") {
        await driver.start(single, task);
      }
    } catch (cause) {
      if (isLiveChat(task) && task.result.status !== "stopping") reportChat(task, "failed", String(cause));
    }
    return task.result;
  }

  function clearPaused(reason: string) {
    if (activeChat?.paused) {
      activeChat.paused = false;
      reportChat(activeChat, "stopped", reason);
    }
  }
  for (const event of ["pointerdown", "keydown"]) {
    document.addEventListener(event, e => {
      if (e.isTrusted && (e.target as HTMLElement | null)?.closest?.("button, input, select, [data-move]")) {
        clearPaused("已在控制窗口接管机器人，原主聊天任务已结束。");
      }
    }, true);
  }
  return {
    refresh(available: boolean) {
      if (chatLink && chatLink !== driver.connection()) revokeChat("机器人连接已改变，课堂任务结束。");
      if (chatGrant) chatGrant.disabled = chatGrantBusy || !available;
    },
    clearPaused,
  };
}
