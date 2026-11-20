import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopPetBridge } from "./types";
import { installPetAudioCapture } from "./petAudio";
import { petSpokenText, startPetNarration } from "./petNarration";

interface PetOption {
  icon?: string;
  text: string;
}

interface PetReply {
  requestId?: string;
  speechText?: string;
  text?: string;
  thinking?: boolean;
  immediate?: boolean;
  options?: PetOption[];
}

interface PetPersona {
  name: string;
  channels: string[];
}

interface PetExitPrompt {
  id: string;
  loading?: boolean;
  unavailable?: boolean;
  sharedRuntime?: boolean;
  personas: PetPersona[];
}

interface PetPermissionPrompt {
  id: string;
  client: string;
}

interface PetSpeech {
  requestId: string;
  state: "waiting" | "speaking" | "paused" | "ended" | "unavailable";
  text?: string;
}

type PhoneCaption = { role: "user" | "assistant"; text: string };

interface PetSnapshot {
  version?: number;
  context?: string;
  expanded?: boolean;
  petLeft?: number;
  petTop?: number;
  petPixels?: number;
  hitRegionsEpoch?: number;
  dragging?: boolean;
  dragId?: number;
  dragMoved?: boolean;
  nativeDragTracking?: boolean;
  preferences?: { appearance?: string; scale?: number };
  pet?: {
    name?: string;
    imageData?: string;
    sheetUrl?: string;
    bgSize?: string;
    bgPos?: string;
  };
  target?: "persona" | "session" | string;
  title?: string;
  folder?: string;
  skill?: string;
  dictating?: boolean;
  voice?: { active?: boolean; muted?: boolean; state?: string };
  busy?: boolean;
  attention?: string;
  error?: string;
  draft?: string;
  ready?: boolean;
  richDraft?: boolean;
  canCall?: boolean;
  reply?: PetReply | null;
  petReplyPresentationVersion?: number;
  petStreamingSpeechVersion?: number;
  petSpeech?: PetSpeech | null;
  remoteDialogue?: { id?: string; state?: string; caption?: PhoneCaption } | null;
  phoneCaption?: PhoneCaption | null;
  petStopOnlyCallVersion?: number;
  phoneState?: string;
  phoneActivity?: "tool";
  phoneError?: string;
  sentRequestId?: string;
  exitPrompt?: PetExitPrompt | null;
  permission?: PetPermissionPrompt | null;
  classroomRecording?: { enabled?: boolean; phase?: string; error?: string } | null;
  compactVoice?: boolean;
}

function ensureDesktopPetBridge(): DesktopPetBridge {
  if (window.desktopPet) return window.desktopPet;
  const listeners = new Set<(state: Record<string, unknown>) => void>();
  void listen<Record<string, unknown>>("aichat-desktop:pet-state", (event) => {
    for (const cb of listeners) {
      try {
        cb(event.payload);
      } catch {
        // Ignore listener error
      }
    }
  });
  const api: DesktopPetBridge = Object.freeze({
    action(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
      return invoke<Record<string, unknown> | null>("desktop_pet_action", {
        name: String(name || ""),
        args: args || {},
      });
    },
    subscribe(callback: (state: Record<string, unknown>) => void): () => void {
      if (typeof callback !== "function") return () => {};
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  });
  Object.defineProperty(window, "desktopPet", {
    value: api,
    writable: false,
    configurable: false,
  });
  return api;
}

(() => {
  installPetAudioCapture();
  const api = ensureDesktopPetBridge();
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  let state: PetSnapshot = {};
  let expanded = false;
  let pendingHangup: object | null = null;
  let edits = 0;
  let draftRevision = 0;
  let unsynced = false;
  let localError = "";
  let queue: Promise<boolean> = Promise.resolve(true);
  let pointer: {
    id: number;
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    moved: boolean;
    tracking: boolean;
    acknowledged: boolean;
    dragId: number;
    nativeTracking: boolean;
    ready: Promise<unknown>;
  } | null = null;
  let dragEpoch = 0;
  let pendingRelease: { epoch: number; done: Promise<boolean> } | null = null;
  let lastRelease: { epoch: number; done: Promise<boolean> } | null = null;
  let previousRelease: { epoch: number; done: Promise<boolean> } | null = null;
  let releasedTap = false;
  let firstTap = false;
  let renderedMessages = "";
  let renderedChoices = "";
  let shownReply: PetReply | null = null;
  let previousReply = "";
  const recentReplies = new Set<string>();
  let pinnedReply = false;
  let textExpired = false;
  let paused = false;
  let narration: ReturnType<typeof startPetNarration> = null;
  let presentationTimer = 0;
  let presentationSequence = 0;
  let optimisticCollapse = false;
  type PendingTurn = {
    correlated: boolean;
    context?: string;
    streaming: boolean;
    speechControlPending?: boolean;
    earlySpeech: Map<string, PetSpeech>;
    timingSilentFinal?: boolean;
    baseline: string;
    initialError?: string;
    reopen: boolean;
    accepted: boolean;
    sawBusy: boolean;
    timedOut?: boolean;
    requestId?: string;
    // Native publications can arrive ahead of the send acknowledgement.
    earlyReplies: Map<string, PetReply>;
    legacyResult?: PetReply;
  };
  let waiting: PendingTurn | null = null;
  let choosing = false;
  let hitRegionsQueued = false;
  let hitRegionsSignature = "";
  let jelly: Animation | undefined;
  const artStyle: Record<string, string> = {};
  const hitSurfaceIds = ["pet", "panel", "bubble", "exit-bubble", "permission-bubble"];
  const hitSurfaceSelector = [...hitSurfaceIds, "dialogue-icon"].map((id) => `#${id}`).join(", ");

  function scheduleHitRegions(): void {
    if (hitRegionsQueued) return;
    hitRegionsQueued = true;
    requestAnimationFrame(() => {
      hitRegionsQueued = false;
      const regions = hitSurfaceIds.flatMap((id) => {
        const el = $(id);
        if (!el.getClientRects().length) return [];
        const { left, top, width, height } = el.getBoundingClientRect();
        if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
        return [{ id, left, top, width, height }];
      });
      const epoch = state.hitRegionsEpoch;
      const signature = JSON.stringify([epoch, regions]);
      if (signature === hitRegionsSignature) return;
      hitRegionsSignature = signature;
      void api.action("hit-regions", { epoch, regions }).catch(() => {
        if (hitRegionsSignature === signature) hitRegionsSignature = "";
      });
    });
  }

  function setArtStyle(key: "backgroundImage" | "backgroundSize" | "backgroundPosition", value: string): void {
    if (artStyle[key] !== value) {
      artStyle[key] = value;
      $("art").style[key] = value;
    }
  }

  function positionLayers(): void {
    if (typeof state.petLeft !== "number" || typeof state.petTop !== "number") return;
    const petPixels = state.petPixels || 112;
    // Composite the moving sprite with a transform; changing left/top plus the
    // drop-shadow filter on every pointermove leaves visible ghost trails in
    // WKWebView.
    const transform = `translate3d(${state.petLeft}px, ${state.petTop}px, 0)`;
    $("pet").style.transform = transform;
    $("dialogue-icon").style.transform = transform;
    const stack = $("stack");
    const width = Math.min(348, window.innerWidth - 12);
    const above = Math.max(0, state.petTop - 12);
    const below = Math.max(0, window.innerHeight - state.petTop - petPixels - 28);
    const onTop = above >= Math.min(stack.scrollHeight, 360) || above >= below;
    stack.style.width = `${width}px`;
    stack.style.left = `${Math.max(
      6,
      Math.min(state.petLeft + petPixels - width, window.innerWidth - width - 6)
    )}px`;
    stack.style.right = "auto";
    stack.style.maxHeight = `${onTop ? above : below}px`;
    stack.style.bottom = onTop ? `${window.innerHeight - state.petTop + 8}px` : "auto";
    stack.style.top = onTop ? "auto" : `${state.petTop + petPixels + 24}px`;
    scheduleHitRegions();
  }

  function adoptNativeDrag(snapshot: PetSnapshot): void {
    const current = pointer;
    if (!current || snapshot.nativeDragTracking !== true || snapshot.dragId !== current.dragId || snapshot.dragMoved !== true) return;
    current.nativeTracking = true;
    current.moved = true;
    if (!current.tracking) {
      current.tracking = true;
      releaseCapture(current.id);
    }
  }

  function stopPresentation(): void {
    ++presentationSequence;
    if (presentationTimer) window.clearTimeout(presentationTimer);
    presentationTimer = 0;
    narration?.cancel();
    narration = null;
    paused = false;
    if (waiting?.streaming && waiting.requestId) {
      cancelSpeech(waiting.context, waiting.requestId);
    }
    waiting = null;
  }

  function cancelSpeech(context: string | undefined, speechRequestId: string): void {
    void api.action("cancel-speech", { context, speechRequestId }).catch(() => {});
  }

  function currentSpeech(): PetSpeech | undefined {
    return waiting?.streaming && waiting.requestId ? waiting.earlySpeech.get(waiting.requestId) : undefined;
  }

  function callPhase(snapshot = state): string {
    return snapshot.phoneState || snapshot.remoteDialogue?.state ||
      (snapshot.voice?.active ? snapshot.voice.state || "listening" : "");
  }

  const callStatusLabels = new Map([
    ["starting", "正在连接…"],
    ["listening", "聆听中"],
    ["muted", "已静音"],
    ["thinking", "正在思考"],
    ["tool", "正在调用工具…"],
    ["speaking", "正在说话"],
    ["discussing", "学生讨论中…"],
    ["paused", "已暂停"],
    ["stopping", "正在结束…"],
  ]);

  function hangupAction(): string {
    if (state.remoteDialogue?.id) return "hangup";
    if (!state.ready) return "open";
    if (state.compactVoice) return "voice-stop";
    if (state.petStopOnlyCallVersion === 1 && state.voice?.active) return "call";
    return "open";
  }

  function paintBubble(): void {
    const speech = currentSpeech();
    const thinking = (!!waiting && !shownReply?.text && speech?.state !== "ended" &&
      (!waiting.timedOut || !!state.busy)) || !!shownReply?.thinking;
    const textVisible = !thinking && !textExpired && !!shownReply?.text;
    const phoneState = callPhase();
    const phoneIcon = $<HTMLButtonElement>("dialogue-icon");
    const showCall = !!phoneState && !document.hidden && !state.exitPrompt && !state.permission;
    phoneIcon.hidden = !showCall;
    phoneIcon.disabled = !!pendingHangup || phoneState === "stopping";
    phoneIcon.dataset.state = phoneState;
    phoneIcon.title = hangupAction() === "open" ? "打开 AIChat 结束通话" : "挂断通话";
    phoneIcon.setAttribute("aria-label", phoneIcon.title);

    // Older phone snapshots fold discussion into listening. The active voice
    // session still reports the precise phase and microphone state.
    let statusPhase = phoneState;
    if (phoneState === "thinking" && state.phoneActivity === "tool") statusPhase = "tool";
    if (phoneState === "listening") {
      if (state.voice?.active && state.voice.state === "discussing") statusPhase = "discussing";
      else if (state.voice?.muted) statusPhase = "muted";
    }
    const status = $("dialogue-status");
    const label = showCall ? callStatusLabels.get(statusPhase) || "" : "";
    status.dataset.state = statusPhase;
    status.hidden = !label;
    if (status.textContent !== label) status.textContent = label;

    const caption = state.remoteDialogue ? state.remoteDialogue.caption : state.phoneCaption;
    const dialogueCaption = $("dialogue-caption");
    const text = showCall && caption?.text ? (caption.role === "user" ? caption.text : `AI：${caption.text}`) : "";
    dialogueCaption.classList.toggle("voice-input-preview", !!text && caption?.role === "user");
    dialogueCaption.hidden = !text;
    if (dialogueCaption.textContent !== text) {
      dialogueCaption.textContent = text;
      dialogueCaption.scrollTop = dialogueCaption.scrollHeight;
    }
    const errorButton = $("phone-error");
    const collapsedError = !expanded && !phoneState && state.phoneError;
    errorButton.hidden = !collapsedError;
    errorButton.textContent = collapsedError ? `${collapsedError} · 打开 AIChat` : "";
    $("bubble").hidden = !!state.exitPrompt || !!state.permission || !!phoneState ||
      !(collapsedError || thinking || textVisible);
    $("bubble").classList.toggle("thinking", thinking);
    $("thinking").hidden = !thinking;
    const reply = $("reply");
    reply.hidden = !textVisible;
    const canControl = speech && !["ended", "unavailable"].includes(speech.state);
    reply.title = canControl || narration
      ? (speech?.state === "paused" || paused ? "点击继续朗读" : "点击暂停朗读")
      : "点击打开桌面查看完整回复";
    reply.setAttribute("aria-label", [shownReply?.text, reply.title].filter(Boolean).join("，"));
    scheduleHitRegions();
  }

  function showReply(reply: PetReply | null, speak: boolean): void {
    stopPresentation();
    shownReply = reply;
    textExpired = false;
    if (!reply || reply.thinking) return;
    const sequence = presentationSequence;
    const expire = () => {
      if (sequence !== presentationSequence) return;
      narration = null;
      paused = false;
      textExpired = true;
      paintBubble();
      positionLayers();
    };
    const timeDisplay = () => {
      if (reply.text) {
        presentationTimer = window.setTimeout(expire, replyDisplayTime(reply.text));
      }
    };
    const prose = speak ? reply.speechText ?? petSpokenText(reply.text || "") : "";
    if (prose && !state.voice?.active && !state.dictating && !activeRemotePress) {
      const speech = startPetNarration(prose, completed => {
        if (sequence !== presentationSequence) return;
        narration = null;
        paused = false;
        if (completed) expire();
        else { timeDisplay(); paintBubble(); }
      });
      if (!textExpired && !presentationTimer) narration = speech;
    }
    if (!narration && !presentationTimer && !textExpired) timeDisplay();
  }

  function dismissPresentation(): void {
    stopPresentation();
    pinnedReply = true;
    optimisticCollapse = false;
    shownReply = null;
    textExpired = true;
    paintBubble();
    positionLayers();
  }

  // History snapshots can omit requestId and speechText for the same displayed answer.
  // Use visible content for replay detection; a pending send still matches its requestId.
  function replySignature(reply?: PetReply | null): string {
    if (!reply) return "";
    const options = (reply.options || []).map(option => [option.icon || "", option.text || ""]);
    return JSON.stringify([reply.text || "", !!reply.thinking, options, reply.immediate !== false]);
  }

  function beginTurn(): PendingTurn {
    const turn: PendingTurn = {
      correlated: state.petReplyPresentationVersion === 1,
      context: state.context,
      streaming: state.petReplyPresentationVersion === 1 && state.petStreamingSpeechVersion === 1,
      earlySpeech: new Map(),
      baseline: replySignature(state.reply),
      initialError: state.error,
      reopen: expanded,
      accepted: false,
      sawBusy: false,
      earlyReplies: new Map(),
    };
    showReply(null, false);
    waiting = turn;
    pinnedReply = true;
    optimisticCollapse = expanded;
    expanded = false;
    $("panel").hidden = true;
    $("panel").classList.remove("remote-voice-open");
    // If a page stops publishing, retire the indicator. A later, positively
    // identified reply can still complete a slow tool call in this context.
    presentationTimer = window.setTimeout(() => {
      if (waiting !== turn) return;
      if (!turn.accepted || (!turn.correlated && !state.busy)) dismissPresentation();
      else {
        turn.timedOut = true;
        paintBubble();
        positionLayers();
      }
    }, 180000);
    render(state as unknown as Record<string, unknown>);
    return turn;
  }

  function rememberSpeech(turn: PendingTurn, speech: PetSpeech): void {
    if (turn.requestId && speech.requestId !== turn.requestId) return;
    const previous = turn.earlySpeech.get(speech.requestId);
    // A late publication or acknowledgement cannot restart a finished stream.
    if (previous?.state === "ended" || previous?.state === "unavailable") return;
    turn.earlySpeech.set(speech.requestId, { ...speech, text: speech.text ?? previous?.text });
    if (turn.earlySpeech.size > 4) {
      const oldest = turn.earlySpeech.keys().next().value;
      if (oldest) turn.earlySpeech.delete(oldest);
    }
  }

  function presentStream(turn: PendingTurn, final: PetReply | undefined): void {
    const speech = currentSpeech();
    if (final && (speech?.state === "unavailable" || speech?.state === "ended")) {
      turn.streaming = false; // Already terminal on the owner page.
      showReply(final, false);
      if (speech.state === "ended") textExpired = true;
      return;
    }
    textExpired = speech?.state === "ended";
    shownReply = final || (speech?.text ? { text: speech.text } : null);
    if (final && !speech && !turn.timingSilentFinal) {
      // If a negotiated page disappears between delivering text and its audio
      // status, preserve visual-only expiry and scope any late audio to this send.
      turn.timingSilentFinal = true;
      window.clearTimeout(presentationTimer);
      presentationTimer = window.setTimeout(() => {
        if (waiting !== turn || currentSpeech()) return;
        showReply(final, false);
        textExpired = true;
        paintBubble();
      }, replyDisplayTime(final.text || ""));
    }
  }

  function replyDisplayTime(text: string): number {
    return Math.max(3000, Math.min(15000, Array.from(text).length * 120));
  }

  function updatePresentation(restored: boolean): void {
    const reply = state.reply || null;
    const signature = replySignature(reply);
    const turn = waiting;
    if (document.hidden || state.exitPrompt || state.permission || callPhase() ||
        (turn?.streaming && state.petStreamingSpeechVersion !== 1) ||
        ((turn || narration) && (!state.ready || state.voice?.active || state.dictating))) {
      dismissPresentation();
    } else if (turn) {
      if (state.error && state.error !== turn.initialError) {
        dismissPresentation();
        if (turn.reopen) void expand(true).catch(() => {});
      } else {
        turn.sawBusy ||= !!state.busy;
        if (turn.streaming && state.petSpeech) rememberSpeech(turn, state.petSpeech);
        if (!state.busy && reply && !reply.thinking) {
          if (reply.requestId) {
            turn.earlyReplies.set(reply.requestId, reply);
            if (turn.earlyReplies.size > 4) {
              const oldest = turn.earlyReplies.keys().next().value;
              if (oldest) turn.earlyReplies.delete(oldest);
            }
          } else if (signature !== turn.baseline && !recentReplies.has(signature)) {
            turn.legacyResult = reply;
          }
        }
        if (turn.accepted) {
          const final = turn.correlated
            ? turn.requestId && turn.earlyReplies.get(turn.requestId)
            : turn.legacyResult;
          if (turn.streaming) {
            presentStream(turn, final || undefined);
          } else if (final) {
            const legacyClassroom = !turn.correlated && (!!state.classroomRecording ||
              ["课堂互动助手", "classroom-interaction-assistant"].includes(state.skill || ""));
            // A legacy host can coalesce its busy transition and final reply.
            // Show that fresh result, but speak only with evidence of our turn.
            showReply(final, !legacyClassroom && (turn.correlated || turn.sawBusy));
          } else if (!turn.correlated && turn.sawBusy && !state.busy &&
                     (!reply || signature === turn.baseline)) {
            dismissPresentation();
          }
        }
      }
    } else {
      // An idle snapshot carries the last assistant message from the conversation.
      // Opening a draft (including a remote paste) is not a new assistant turn.
      const hasDraft = !!state.draft || unsynced || !!state.dictating || !!activeRemotePress;
      if (restored || expanded || hasDraft) {
        if (shownReply) showReply(null, false);
      } else if (signature !== previousReply && !reply?.requestId) {
        if (!reply || reply.thinking) {
          if (!pinnedReply) showReply(reply, false);
        } else if (!state.busy && !recentReplies.has(signature)) {
          showReply(reply, false);
        }
      }
    }
    if (reply && !reply.thinking && !state.busy && !recentReplies.has(signature)) {
      recentReplies.add(signature);
      if (recentReplies.size > 16) {
        const oldest = recentReplies.values().next().value;
        if (oldest) recentReplies.delete(oldest);
      }
    }
    previousReply = signature;
    paintBubble();
  }

  function render(raw: Record<string, unknown> | null): void {
    let next = (raw || {}) as PetSnapshot;
    if (!next || next.version !== 1) return;
    const staleDrag = pointer && typeof next.dragId === "number" && next.dragId !== pointer.dragId;
    if (staleDrag) {
      // The native thread may have queued a last snapshot before this press.
      // Keep ordinary chat state current without rewinding the new drag.
      next = { ...next, petLeft: state.petLeft, petTop: state.petTop };
    }
    const openingExit = !!next.exitPrompt && !state.exitPrompt;
    const closingExit = !next.exitPrompt && !!state.exitPrompt;
    const draftEl = $<HTMLTextAreaElement>("draft");
    const restored = !state.version || next.context !== state.context || (!!next.ready && !state.ready);
    if (next.context !== state.context) {
      if (activeRemotePress) finishRemotePress();
      showReply(null, false);
      pinnedReply = false;
      previousReply = "";
      recentReplies.clear();
      optimisticCollapse = false;
      edits = 0;
      draftRevision++;
      unsynced = false;
      localError = "";
      draftEl.value = next.draft || "";
    }
    if (!callPhase(next) || next.context !== state.context || next.remoteDialogue?.id !== state.remoteDialogue?.id) {
      pendingHangup = null;
    }
    state = next;
    if (typeof next.expanded === "boolean") {
      if (!next.expanded) optimisticCollapse = false;
      expanded = next.expanded && !optimisticCollapse;
    }
    $("panel").hidden = !expanded || !!callPhase();
    if ($("panel").hidden) $("panel").classList.remove("remote-voice-open");
    const pet = state.preferences?.appearance === "dragon" ? {} : state.pet || {};
    if ($("art").textContent !== "") $("art").textContent = "";
    const image = pet.imageData || pet.sheetUrl;
    setArtStyle("backgroundImage", image ? `url(${JSON.stringify(image)})` : "");
    setArtStyle("backgroundSize", image ? pet.bgSize || "400% 400%" : "");
    setArtStyle("backgroundPosition", image ? pet.bgPos || "0% 0%" : "");
    document.body.style.setProperty("--pet-pixels", `${state.petPixels || 112}px`);
    $("pet").title = `${pet.name || "宠物"}${localError ? ` · ${localError}` : ""} · 单击聊天 · 双击打开桌面 · 右键设置 · 拖动移动`;

    const title = state.target === "persona" ? state.title || "我的分身" : `会话 · ${state.title || "AIChat"}`;
    $("target-title").textContent = title;
    const folderName = (state.folder || "").split(/[\\/]/).filter(Boolean).pop() || state.folder || "";
    $("target-detail").textContent =
      state.target === "persona"
        ? folderName || "第二大脑"
        : `技能：${state.skill || "无"} · 文件夹：${folderName || "未绑定"}`;
    const target = $("target");
    target.dataset.kind = state.target === "persona" ? "persona" : "session";
    target.dataset.hint = `${$("target-title").textContent}\n${$("target-detail").textContent}${
      state.folder ? `\n${state.folder}` : ""
    }`;
    target.setAttribute("aria-description", target.dataset.hint);
    target.title = target.dataset.hint;
    $("badge").hidden = !!callPhase() ||
      !(state.busy || state.attention || state.error || localError);

    if (!edits && !unsynced) draftEl.value = state.draft || "";
    draftEl.disabled = !!state.richDraft || !!state.dictating;
    draftEl.classList.toggle("dictating", !!state.dictating);

    const sendBtn = $<HTMLButtonElement>("send");
    sendBtn.classList.toggle("alternate-action", !!state.busy);
    $("send-label").textContent = state.busy ? "停止" : "发送";
    sendBtn.disabled = !state.ready || (!state.busy && (!!state.richDraft || !!state.dictating));

    const dictationBtn = $<HTMLButtonElement>("dictation");
    dictationBtn.classList.toggle("alternate-action", !!state.dictating);
    $("dictation-label").textContent = state.dictating ? "停止输入" : "语音输入";
    dictationBtn.disabled = !state.ready || !!state.richDraft || !!state.voice?.active;

    const callBtn = $<HTMLButtonElement>("call");
    callBtn.classList.toggle("alternate-action", !!state.voice?.active);
    $("call-label").textContent = state.voice?.active ? "结束通话" : "通话";
    callBtn.dataset.hint =
      state.voice?.active ? "结束通话" : state.canCall ? "实时语音对话" : "请在 AIChat 中选择实时语音模型";
    callBtn.disabled = !state.ready || (!state.canCall && !state.voice?.active) || !!state.dictating;

    const muteBtn = $<HTMLButtonElement>("mute");
    muteBtn.hidden = !state.voice?.active;
    muteBtn.classList.toggle("alternate-action", !!state.voice?.muted);
    $("mute-label").textContent = state.voice?.muted ? "取消静音" : "静音";
    paintStationHints();

    $("status").textContent =
      state.attention ||
      (state.richDraft
        ? "含附件或文件引用，请在 AIChat 中编辑。"
        : state.voice?.active
          ? `语音：${state.voice.muted ? "已静音" : callStatusLabels.get(state.voice.state || "") || "通话中"}`
          : state.busy
            ? "正在回复…"
            : "");
    if (!state.ready && !state.richDraft && !state.dictating) {
      $("status").textContent = [$("status").textContent, "可先输入草稿，连接后点击发送。"]
        .filter(Boolean).join("\n");
    }
    $("error").textContent = localError || state.phoneError || state.error || "";

    updatePresentation(restored);
    const reply = shownReply;
    const signature = JSON.stringify([state.context, reply]);
    if (signature !== renderedMessages) {
      renderedMessages = signature;
      const log = $("reply");
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      const wasThinking = log.dataset.thinking === "true";
      log.textContent = reply?.text || "";
      log.dataset.thinking = String(!!reply?.thinking);
      if (wasThinking && !reply?.thinking) log.scrollTop = 0;
      else if (atBottom && state.busy) log.scrollTop = log.scrollHeight;
    }

    // Suggestions belong to the composer; their lifetime is independent of the answer bubble.
    const choices = state.reply;
    const options = $("options");
    options.hidden = !!state.draft || unsynced || !!state.dictating || !!activeRemotePress ||
      !!callPhase();
    const choicesKey = JSON.stringify([state.context, choices?.options, choices?.immediate]);
    if (choicesKey !== renderedChoices) {
      renderedChoices = choicesKey;
      const context = state.context;
      options.replaceChildren(
        ...(choices?.options || []).map((option) => {
          const button = document.createElement("button");
          button.textContent = [option.icon, option.text].filter(Boolean).join(" ");
          button.onclick = async () => {
            if (
              choosing || !expanded || options.hidden ||
              context !== state.context ||
              state.busy ||
              state.richDraft ||
              state.dictating ||
              state.draft ||
              edits ||
              unsynced
            ) {
              return;
            }
            choosing = true;
            render(state as unknown as Record<string, unknown>);
            try {
              if ((await action("input", { text: option.text })) && context === state.context) {
                if (choices?.immediate !== false) await action("send");
                else await expand(true);
              }
            } finally {
              choosing = false;
              render(state as unknown as Record<string, unknown>);
            }
          };
          return button;
        })
      );
    }
    for (const child of Array.from(options.children)) {
      (child as HTMLButtonElement).disabled =
        choosing ||
        !state.ready ||
        !!state.busy ||
        !!state.richDraft ||
        !!state.dictating ||
        !!state.draft ||
        !!edits ||
        unsynced;
    }

    const exit = state.exitPrompt;
    $("exit-bubble").hidden = !exit;
    if (exit) {
      $("bubble").hidden = true;
      $("panel").hidden = true;
      $("exit-summary").textContent = exit.sharedRuntime
        ? "将完全关闭 AIChat。由其他程序提供的本机服务会继续运行，但依赖 AIChat 的分身回复会中断。"
        : "将完全关闭 AIChat 和它启动的本机服务。以下分身将暂停运行，已启用渠道将无法自动回复，直到重新启动：";
      $("exit-personas").replaceChildren(
        ...(exit.personas || []).map((persona) => {
          const item = document.createElement("li");
          item.textContent = `${persona.name}（${(persona.channels || []).join("、") || "本地分身任务"}）`;
          return item;
        })
      );
      $("exit-status").textContent = exit.loading
        ? "正在检查分身和渠道…"
        : exit.unavailable
          ? "暂时无法获取分身列表。飞书、钉钉等已连接渠道的自动回复可能中断。仍要退出吗？"
          : (exit.personas || []).length
            ? "隐藏宠物可保持后台运行；完全退出会停止本应用。"
            : "未发现当前账号的已配置分身。仍要完全退出吗？";
      $<HTMLButtonElement>("exit-confirm").disabled = !!exit.loading;
      if (openingExit) $("exit-cancel").focus();
    }
    if (closingExit) $("pet").focus();

    const permission = state.permission;
    $("permission-bubble").hidden = !permission;
    if (permission) {
      $("bubble").hidden = true;
      $("panel").hidden = true;
      $("exit-bubble").hidden = true;
      $("permission-client").textContent = `请求方：${permission.client}`;
    }

    const rec = state.classroomRecording;
    const active = !!state.voice?.active;
    const compactVoiceStateMap: Record<string, string> = {
      starting: "语音连接中",
      stopping: "正在结束语音",
      paused: "语音已暂停",
    };
    const recPhaseMap: Record<string, string> = {
      recording: "录音中",
      starting: "录音连接中",
      stopping: "正在停止录音",
    };
    const compactStatus = $("compact-status");
    compactStatus.textContent =
      localError ||
      state.error ||
      rec?.error ||
      (active
        ? compactVoiceStateMap[state.voice?.state || ""] || (state.voice?.muted ? "语音已静音" : "语音中")
        : recPhaseMap[rec?.phase || ""] || "");

    compactStatus.hidden = !compactStatus.textContent || expanded || !!exit || !!permission ||
      !!callPhase() || !state.compactVoice;

    syncReadiness();
    adoptNativeDrag(next);
    if (next.dragging === false && pointer?.tracking && !staleDrag &&
        (typeof next.dragId === "number" ? next.dragId === pointer.dragId : pointer.acknowledged)) {
      finishDrag(pointer.id);
    }
    positionLayers();
    scheduleHitRegions();
  }

  for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-permission]"))) {
    el.onclick = async () => {
      const id = state.permission?.id;
      if (!id) return;
      await api.action("permission-choice", { id, choice: el.dataset.permission });
    };
  }

  function action(name: string, args: Record<string, unknown> = {}, stillValid?: () => boolean): Promise<boolean> {
    const context = state.context;
    if (name === "send" && waiting && !waiting.accepted) return Promise.resolve(false);
    const turn = name === "send" ? beginTurn() : null;
    const task = queue.then(async () => {
      if (stillValid && !stillValid()) return false;
      if (turn && waiting !== turn) return false;
      if (context !== state.context) throw new Error("会话已改变，请重试");
      if (["input", "send"].includes(name) && !state.ready) {
        throw new Error("请先在 AIChat 中连接本机服务和第二大脑，草稿已保留。");
      }
      const next = await api.action(name, { ...args, context });
      if (turn?.streaming && waiting !== turn && typeof next?.sentRequestId === "string") {
        cancelSpeech(context, next.sentRequestId);
      }
      if (context !== state.context) return false;
      localError = "";
      if (turn && waiting === turn) {
        turn.requestId = typeof next?.sentRequestId === "string" ? next.sentRequestId : undefined;
        turn.accepted = true;
      }
      if (name === "stop") dismissPresentation();
      if (next) render(next);
      return true;
    });
    queue = task.catch((err: unknown) => {
      if (context !== state.context) return false;
      const msg = err instanceof Error ? err.message : String(err);
      localError = msg.replace(/^Error invoking remote method '[^']+': Error: /, "");
      $("error").textContent = localError;
      if (turn && waiting === turn) {
        dismissPresentation();
        if (turn.reopen) void expand(true).catch(() => {});
      }
      return false;
    });
    return queue;
  }

  async function expand(value: boolean, context?: string): Promise<void> {
    if (state.exitPrompt || state.permission || callPhase()) return;
    optimisticCollapse = false;
    if (waiting) waiting.reopen = false;
    const opening = value && !expanded;
    expanded = value;
    if (opening && shownReply) dismissPresentation();
    if (opening && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      jelly?.cancel();
      const amount = Math.min(0.12, 14 / (state.petPixels || 112));
      jelly = $("art").animate?.(
        [
          { transform: "scale(1, 1)" },
          { transform: `scale(${1 + amount}, .88)`, offset: 0.22 },
          { transform: "scale(.93, 1.07)", offset: 0.46 },
          { transform: `scale(${1 + amount / 3}, .96)`, offset: 0.7 },
          { transform: "scale(1, 1)" },
        ],
        { duration: 460, easing: "ease-out" }
      );
    }
    state = { ...state, expanded: value };
    $("panel").hidden = !expanded;
    if (!expanded) $("panel").classList.remove("remote-voice-open");
    paintBubble();
    const draftEl = $<HTMLTextAreaElement>("draft");
    if (expanded && !draftEl.disabled) draftEl.focus();
    syncReadiness();
    await api.action("expand", { expanded: value, ...(context && { context }) });
  }

  const draftEl = $<HTMLTextAreaElement>("draft");
  const panel = $("panel");
  const indicator = $("remote-voice-indicator");
  const indicatorLabel = $("remote-voice-label");
  const preview = $("remote-voice-preview");
  let lastRemotePress = 0;
  let activeRemotePress = 0;
  let pressPhase = "";
  const deviceCues: Record<string, [string, string]> = {
    "waiting-paired": ["link", "正在等待遥控器唤醒…"],
    scanning: ["link", "正在查找遥控器…"],
    connecting: ["link", "正在连接遥控器…"],
    reconnecting: ["link", "正在重新连接遥控器…"],
    "preparing-microphone": ["prepare", "正在准备麦克风…"],
    "needs-permission": ["permission", "请在遥控器设置中授权蓝牙。"],
  };
  const voiceCues: Record<string, [string, string]> = {
    ...deviceCues,
    ready: ["ready", "遥控器已就绪，可以按住语音键说话。"],
    recording: ["record", "录音中"],
    transcribing: ["transcribe", "正在识别语音"],
    retry: ["retry", "这次未能录入语音，请重新按住语音键。"],
  };
  let readiness = "";
  let lastConnectionPhase = "";
  let readyNoticeUntil = 0;
  let noAudioPress = 0;
  let readinessTimer = 0;
  let readingReadiness = false;

  function paintStationHints(): void {
    const showHints = !panel.classList.contains("remote-voice-station");
    for (const id of ["dictation", "send", "mute"]) {
      $(id).title = showHints ? $(id + "-label").textContent || "" : "";
    }
    for (const id of ["target", "call", "minimize", "open", "collapse"]) {
      const button = $(id);
      button.title = showHints ? button.dataset.hint || "" : "";
    }
  }
  // The static chrome buttons use their original tooltips outside voice input.
  for (const id of ["minimize", "open", "collapse"]) $(id).dataset.hint = $(id).title;

  function paintVoiceIndicator(): void {
    const phase = noAudioPress ? "retry" : activeRemotePress ? pressPhase : readiness;
    const cue = voiceCues[phase];
    indicator.hidden = !cue;
    panel.classList.toggle("remote-voice-station", !!cue);
    paintStationHints();
    indicator.dataset.icon = cue?.[0] || "";
    const label = cue?.[1] || "";
    if (indicatorLabel.textContent !== label) indicatorLabel.textContent = label;
  }
  // The settings window owns device IDs and configuration. The pet asks only
  // for the phase, and only while its composer is on screen.
  function syncReadiness(): void {
    if (document.hidden || panel.hidden || state.exitPrompt || state.permission) {
      window.clearTimeout(readinessTimer);
      readinessTimer = 0;
      readiness = "";
      lastConnectionPhase = "";
      readyNoticeUntil = 0;
      paintVoiceIndicator();
      return;
    }
    if (readingReadiness || readinessTimer) return;
    readingReadiness = true;
    void api.action("remote-voice-readiness").then(result => {
      const phase = typeof result?.readiness === "string" ? result.readiness : "";
      if (phase === "ready" && deviceCues[lastConnectionPhase] && !activeRemotePress) {
        readyNoticeUntil = performance.now() + 3000;
      } else if (phase !== "ready") {
        readyNoticeUntil = 0;
      }
      lastConnectionPhase = phase;
      readiness = phase === "ready" && performance.now() < readyNoticeUntil
        ? "ready"
        : Object.prototype.hasOwnProperty.call(deviceCues, phase) ? phase : "";
    }).catch(() => { readiness = ""; }).finally(() => {
      readingReadiness = false;
      if (document.hidden || panel.hidden || state.exitPrompt || state.permission) return;
      paintVoiceIndicator();
      readinessTimer = window.setTimeout(() => {
        readinessTimer = 0;
        syncReadiness();
      }, 1000);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && activeRemotePress) finishRemotePress();
    syncReadiness();
  });


  window.addEventListener("aichat:remote-dialogue", (event) => {
    const detail = (event as CustomEvent<{ action?: string }>).detail;
    if (detail?.action === "interrupt" && !document.hidden && (narration || waiting?.streaming)) {
      dismissPresentation();
    }
  });
  window.addEventListener("aichat:remote-voice-focus", (event) => {
    if (callPhase() || !state.version || state.exitPrompt || state.permission || draftEl.disabled) return;
    const id = (event as CustomEvent<number>).detail;
    if (id !== undefined) {
      if (!Number.isSafeInteger(id) || id <= lastRemotePress) return;
      lastRemotePress = activeRemotePress = id;
      preview.textContent = "";
      preview.hidden = true;
      pressPhase = "preparing-microphone";
      noAudioPress = 0;
      readyNoticeUntil = 0;
      readiness = "";
      paintVoiceIndicator();
      panel.classList.add("remote-recording");
    }
    if (shownReply || waiting) dismissPresentation();
    optimisticCollapse = false;
    expanded = true;
    panel.classList.add("remote-voice-open");
    panel.hidden = false;
    $("compact-status").hidden = true;
    positionLayers();
    scheduleHitRegions();
    draftEl.focus();
    if (document.activeElement === draftEl) event.preventDefault();
  });
  window.addEventListener("aichat:remote-voice-edit", (event) => {
    const detail = (event as CustomEvent<{ press: number; context: string; action: string; text: string }>).detail;
    if (!activeRemotePress || detail?.press !== activeRemotePress || detail.context !== state.context ||
        document.hidden || panel.hidden || draftEl.disabled || state.permission || state.exitPrompt ||
        state.remoteDialogue?.state || state.richDraft || state.dictating) return;
    if (detail.action === "submit") {
      const send = $<HTMLButtonElement>("send");
      if (send.disabled || state.busy || !draftEl.value.trim()) return;
      send.click();
    } else if (detail.action === "clear" || (detail.action === "insert" && typeof detail.text === "string")) {
      if (detail.action === "clear") draftEl.value = "";
      else draftEl.setRangeText(detail.text, draftEl.selectionStart, draftEl.selectionEnd, "end");
      void syncDraftEdit();
    } else {
      return;
    }
    event.preventDefault();
  });
  window.addEventListener("aichat:remote-voice-recording", (event) => {
    if (activeRemotePress && activeRemotePress === (event as CustomEvent<number>).detail && pressPhase === "preparing-microphone") {
      pressPhase = "recording";
      paintVoiceIndicator();
    }
  });
  window.addEventListener("aichat:remote-voice-preview", (event) => {
    const detail = (event as CustomEvent<{ press: number; text: string }>).detail;
    if (!activeRemotePress || detail?.press !== activeRemotePress || typeof detail.text !== "string") return;
    preview.textContent = detail.text;
    preview.hidden = !detail.text;
    preview.scrollTop = preview.scrollHeight;
  });
  window.addEventListener("aichat:remote-voice-transcribing", (event) => {
    if (!activeRemotePress || activeRemotePress !== (event as CustomEvent<number>).detail) return;
    panel.classList.remove("remote-recording");
    pressPhase = "transcribing";
    paintVoiceIndicator();
  });
  window.addEventListener("aichat:remote-voice-no-audio", (event) => {
    const id = (event as CustomEvent<number>).detail;
    if (!activeRemotePress || id !== activeRemotePress) return;
    noAudioPress = id;
    paintVoiceIndicator();
    window.setTimeout(() => {
      if (noAudioPress !== id) return;
      noAudioPress = 0;
      paintVoiceIndicator();
    }, 3000);
  });
  window.addEventListener("aichat:remote-voice-end", (event) => {
    const id = (event as CustomEvent<number>).detail;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    lastRemotePress = Math.max(lastRemotePress, id);
    if (id === activeRemotePress) finishRemotePress();
  });
  function finishRemotePress(): void {
    activeRemotePress = 0;
    pressPhase = "";
    paintVoiceIndicator();
    preview.hidden = true;
    preview.textContent = "";
    panel.classList.remove("remote-recording");
  }
  async function syncDraftEdit(): Promise<void> {
    const context = state.context;
    const revision = ++draftRevision;
    if (shownReply || waiting) dismissPresentation();
    unsynced = true;
    // Older AIChat pages reject input while offline. Keep these edits local
    // until the user edits again online or explicitly sends the draft.
    if (!state.ready) {
      render(state as unknown as Record<string, unknown>);
      return;
    }
    edits++;
    const ok = await action("input", { text: draftEl.value });
    if (context === state.context) {
      edits = Math.max(0, edits - 1);
      if (revision === draftRevision) unsynced = !ok;
      if (!edits) render(state as unknown as Record<string, unknown>);
    }
  }
  draftEl.addEventListener("input", () => void syncDraftEdit());

  window.addEventListener("aichat:remote-ok", (event) => {
    const context = (event as CustomEvent<{ context?: string }>).detail?.context;
    if (!context || context !== state.context || document.hidden || state.permission || state.exitPrompt ||
        activeRemotePress || callPhase()) return;
    if (controlNarration(false) || draftEl.disabled) return;
    if (!draftEl.value.trim()) {
      // A prompt or conversation change can supersede this press in the host.
      void expand(!expanded, context)
        .catch(() => api.action("state").then(render))
        .catch(() => {});
      return;
    }
    if (state.busy) return;
    const send = $<HTMLButtonElement>("send");
    if (!send.disabled) send.click();
  });

  let backPresses: Promise<void> = Promise.resolve();
  window.addEventListener("aichat:remote-back", (event) => {
    const context = (event as CustomEvent<{ context: string }>).detail?.context;
    if (!context || context !== state.context || document.hidden || state.exitPrompt || state.permission) return;
    const received = performance.now();
    const current = () => performance.now() - received < 1000 && context === state.context &&
      !document.hidden && !state.exitPrompt && !state.permission;
    event.preventDefault();
    backPresses = backPresses.then(async () => {
      if (!current()) return;
      if (panel.hidden) {
        await action("hide-temporarily", {}, () => current() && panel.hidden);
      } else if (!draftEl.disabled) {
        if (draftEl.value !== "") {
          draftEl.value = "";
          await syncDraftEdit();
        } else if (state.ready && state.draft && unsynced) {
          // The host still owns text after a failed clear. An explicit Back
          // can retry the empty edit before advancing to the next step.
          await syncDraftEdit();
        } else {
          await action("expand", { expanded: false }, () => current() && !panel.hidden &&
            !draftEl.disabled && draftEl.value === "");
        }
      }
    });
  });

  draftEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const sendBtn = $<HTMLButtonElement>("send");
      if (!sendBtn.disabled) sendBtn.click();
    }
  });

  $("send").onclick = async () => {
    if ($<HTMLButtonElement>("send").disabled) return;
    const name = state.busy ? "stop" : "send";
    const context = state.context;
    if (edits || unsynced) await queue;
    if (context !== state.context || !state.ready) return;
    if (name === "send" && (state.busy || state.richDraft || state.dictating)) return;
    if (name === "send" && unsynced) {
      const revision = draftRevision;
      if (!(await action("input", { text: draftEl.value }))) return;
      if (context !== state.context || revision !== draftRevision || !state.ready ||
          state.busy || state.richDraft || state.dictating) return;
      unsynced = false;
    }
    if (name === "stop" || draftEl.value.trim()) void action(name);
  };

  for (const name of ["dictation", "call", "mute"]) {
    $(name).onclick = () => {
      void action(name);
    };
  }

  $("minimize").onclick = () => {
    const context = state.context;
    // Window controls stay responsive while the chat page acknowledges draft edits.
    void api.action("hide-temporarily", { context, expanded: true }).catch((error: unknown) => {
      if (context !== state.context || panel.hidden || document.hidden) return;
      localError = error instanceof Error ? error.message : String(error);
      $("error").textContent = localError;
    });
  };

  $("open").onclick = () => {
    void api.action("open");
  };

  // A physical OK during playback owns this press, including repeats while the
  // pause acknowledgement is pending. Only the visible reply control resumes.
  function controlNarration(toggle: boolean): boolean {
    const turn = waiting;
    const speech = currentSpeech();
    if (turn && speech && !["ended", "unavailable"].includes(speech.state)) {
      if (turn.speechControlPending || (!toggle && speech.state === "paused")) return true;
      turn.speechControlPending = true;
      const name = speech.state === "paused" ? "resume-speech" : "pause-speech";
      void action(name, { speechRequestId: speech.requestId }, () => waiting === turn)
        .finally(() => { turn.speechControlPending = false; });
    } else if (narration) {
      if (!toggle && paused) return true;
      paused = !paused;
      if (paused) narration.pause();
      else narration.resume();
      paintBubble();
    } else {
      return false;
    }
    return true;
  }

  function activateReply(): void {
    if (window.getSelection()?.toString() || controlNarration(true)) return;
    if (!textExpired && shownReply?.text) void api.action("open");
  }

  $("reply").onclick = activateReply;
  $("reply").onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) activateReply();
    }
  };
  $("dialogue-icon").onclick = async () => {
    if (pendingHangup || !callPhase() || callPhase() === "stopping" ||
        document.hidden || state.permission || state.exitPrompt) return;
    const pending = pendingHangup = {};
    const name = hangupAction();
    const dialogueId = state.remoteDialogue?.id;
    const args = name === "hangup" ? { dialogueId } : name === "call" ? { stopOnly: true } : {};
    paintBubble();
    // The page publishes the current call. A delayed command reply can describe
    // an earlier call, even when both calls belong to the same conversation.
    let accepted = false;
    try {
      await api.action(name, { ...args, context: state.context });
      accepted = true;
    } catch (error) {
      if (pendingHangup === pending) {
        localError = error instanceof Error ? error.message : String(error);
        $("error").textContent = localError;
      }
    }
    // Some pages acknowledge before their microphone has finished stopping.
    // Keep a second click from acting on that stale state, while allowing retry.
    const unlock = () => {
      if (pendingHangup !== pending) return;
      pendingHangup = null;
      paintBubble();
    };
    if (accepted && pendingHangup === pending) window.setTimeout(unlock, 1500);
    else unlock();
  };
  $("phone-error").onclick = () => { void api.action("open"); };
  window.addEventListener("aichat:pet-hidden", dismissPresentation);
  window.addEventListener("pagehide", dismissPresentation);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) dismissPresentation();
    else paintBubble();
  });

  $("collapse").onclick = () => {
    void expand(false);
  };

  $("exit-cancel").onclick = () => {
    void api.action("exit-cancel");
  };

  $("exit-confirm").onclick = () => {
    if (!state.exitPrompt) return;
    void api
      .action("exit-confirm", { id: state.exitPrompt.id })
      .catch((error: unknown) => {
        $("exit-status").textContent = error instanceof Error ? error.message : String(error);
      });
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.permission) {
        void api.action("permission-choice", { id: state.permission.id, choice: "cancel" });
        return;
      }
      if (state.exitPrompt) void api.action("exit-cancel");
      else void expand(false);
    }
    if (event.key === "Tab" && state.exitPrompt) {
      event.preventDefault();
      const confirmBtn = $<HTMLButtonElement>("exit-confirm");
      (document.activeElement === $("exit-cancel") && !confirmBtn.disabled
        ? confirmBtn
        : $("exit-cancel")
      ).focus();
    }
  });

  const releaseCapture = (id: number) => {
    try {
      $("pet").releasePointerCapture(id);
    } catch {
      // The window move already dropped the capture.
    }
  };

  const finishDrag = (id: number | undefined) => {
    if (id != null) releaseCapture(id);
    pointer = null;
    releasedTap = false;
    firstTap = false;
    const epoch = dragEpoch;
    // The native move is async. Keep the drop-shadow off until it lands,
    // or WKWebView stamps the old shadow as a ghost.
    window.setTimeout(() => {
      if (epoch === dragEpoch && !pointer) document.body.classList.remove("dragging");
    }, 80);
    const pet = $("pet");
    // A lost pointerup leaves the button pressed, so the next click never fires.
    pet.style.pointerEvents = "none";
    requestAnimationFrame(() => {
      pet.style.pointerEvents = "";
    });
    scheduleHitRegions();
  };

  $("pet").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.ctrlKey) return;
    dragEpoch += 1;
    previousRelease = lastRelease?.epoch === dragEpoch - 1 ? lastRelease : null;
    pendingRelease = null;
    releasedTap = false;
    document.body.classList.add("dragging");
    pointer = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false,
      tracking: false,
      acknowledged: false,
      dragId: dragEpoch,
      nativeTracking: false,
      ready: api.action("drag-start", { screenX: event.screenX, screenY: event.screenY, dragId: dragEpoch }),
    };
    const current = pointer;
    void current.ready.then((raw) => {
      if (pointer !== current) return;
      current.acknowledged = true;
      current.nativeTracking = !!raw && typeof raw === "object" && (raw as PetSnapshot).nativeDragTracking === true;
      if (current.nativeTracking) {
        const snapshot = raw as PetSnapshot;
        // Only the native event stream updates geometry; an acknowledgement
        // can arrive after a newer cursor snapshot.
        adoptNativeDrag(snapshot);
        if (snapshot.dragId === current.dragId && snapshot.dragging === false && current.tracking) finishDrag(current.id);
      }
    }, () => {
      if (pointer === current) finishDrag(current.id);
    });
    $("pet").setPointerCapture(event.pointerId);
  });

  $("pet").addEventListener("pointermove", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer.screenX = event.screenX;
    pointer.screenY = event.screenY;
    if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 4) {
      pointer.moved = true;
    }
    // Keep sampling after the pointer leaves this monitor. The host moves the
    // window; that move can cancel the pointer, so release is not tied to it.
    if (!pointer.moved || pointer.tracking) return;
    pointer.tracking = true;
    // Global cursor tracking takes over. Holding capture across a window move
    // sticks the button so later clicks never arrive.
    releaseCapture(event.pointerId);
    const current = pointer;
    const step = () => {
      if (pointer !== current || !current.tracking || current.nativeTracking) return;
      void current.ready
        .then(() => {
          if (pointer !== current || !current.tracking || current.nativeTracking) return null;
          return api.action("drag", { screenX: current.screenX, screenY: current.screenY, dragId: current.dragId });
        })
        .then((snap) => {
          if (pointer !== current || !current.tracking) return;
          if (!snap || typeof snap !== "object") {
            requestAnimationFrame(step);
            return;
          }
          state = { ...state, ...(snap as PetSnapshot) };
          positionLayers();
          if ((snap as PetSnapshot).dragging === false) {
            finishDrag(current.id);
            return;
          }
          requestAnimationFrame(step);
        })
        .catch(() => {
          if (pointer === current && current.tracking) requestAnimationFrame(step);
        });
    };
    // New hosts continue on the native cursor timer even if this WebView stops
    // rendering while it crosses a monitor. Keep polling only for older hosts.
    void current.ready.then(() => {
      if (pointer === current && current.tracking && !current.nativeTracking) requestAnimationFrame(step);
    }, () => {});
  });

  const release = async (event: PointerEvent): Promise<boolean> => {
    const current = pointer;
    if (!current || event.pointerId !== current.id) return false;
    const epoch = dragEpoch;
    const commitRelease = (moved: boolean) => {
      pointer = null;
      document.body.classList.remove("dragging");
      releasedTap = !moved && event.type === "pointerup";
      if (!releasedTap) firstTap = false;
      return releasedTap;
    };
    releaseCapture(current.id);
    const legacy = current.acknowledged && !current.nativeTracking;
    // Legacy hosts keep their immediate tap behavior.
    let tap = legacy ? commitRelease(current.moved) : false;
    if (!legacy) releasedTap = false;
    try {
      await current.ready;
      if (epoch !== dragEpoch) return false;
      if (!current.nativeTracking) {
        if (!legacy && pointer === current) tap = commitRelease(current.moved);
        void api.action("drag-end", { dragId: current.dragId }).catch(() => {});
        return tap;
      }
      const raw = await api.action("drag-end", { dragId: current.dragId });
      const snapshot = (raw || {}) as PetSnapshot;
      if (snapshot.dragId !== current.dragId) return false;
      tap = snapshot.dragging === false && !current.moved && snapshot.dragMoved !== true && event.type === "pointerup";
      // A valid old confirmation may establish the first tap of a double click,
      // but cannot toggle the panel or mutate a newer pointer by itself.
      if (epoch !== dragEpoch || pointer !== current) return tap;
      if (snapshot.dragging === true) {
        // WKWebView can synthesize pointerup while the physical button is down.
        // Keep this press owned by the native tracker and reject its click.
        adoptNativeDrag(snapshot);
        releasedTap = false;
      } else if (snapshot.dragging === false) {
        commitRelease(current.moved || snapshot.dragMoved === true);
      }
      return tap;
    } catch {
      // A failed or superseded start must not end a newer native drag.
      if (epoch === dragEpoch && pointer === current) finishDrag(current.id);
      return false;
    }
  };

  // Crossing monitors moves this window and WKWebView often synthesizes pointerup
  // while the button is still held. Keep the tracker running; the host ends it
  // when the button is actually up.
  $("pet").addEventListener("pointerup", (event) => {
    if (pointer && event.pointerId !== pointer.id) return;
    if (pointer?.tracking) {
      releasedTap = false;
      firstTap = false;
      return;
    }
    if (pendingRelease?.epoch === dragEpoch) return;
    const waitForNative = !!pointer && (!pointer.acknowledged || pointer.nativeTracking);
    const done = release(event);
    if (waitForNative) {
      const owned = { epoch: dragEpoch, done };
      pendingRelease = owned;
      lastRelease = owned;
      void done.finally(() => {
        if (pendingRelease === owned) pendingRelease = null;
      });
    }
  });

  $("pet").addEventListener("click", async (event) => {
    if (event.ctrlKey || event.button > 0) return;
    if (event.detail === 0) {
      void expand(!expanded);
      return;
    }
    const epoch = dragEpoch;
    const waiting = pendingRelease;
    const previous = previousRelease;
    let confirmedTap = releasedTap;
    if (waiting) {
      confirmedTap = await waiting.done;
      if (waiting.epoch !== dragEpoch) return;
    }
    if (!confirmedTap) return;
    releasedTap = false;
    if (event.detail === 2) {
      const precededByTap = previous?.epoch === epoch - 1 ? await previous.done : firstTap;
      if (epoch !== dragEpoch) return;
      firstTap = false;
      if (precededByTap && !state.exitPrompt && !state.permission) void api.action("open");
    } else {
      firstTap = event.detail === 1;
      if (firstTap) void expand(!expanded);
    }
  });

  $("pet").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const context = state.context;
    void api.action("menu").then(() => {
      if (context !== state.context) return;
      localError = "";
      render(state as unknown as Record<string, unknown>);
    }, (error: unknown) => {
      if (context !== state.context) return;
      localError = error instanceof Error ? error.message : String(error);
      render(state as unknown as Record<string, unknown>);
    });
  });

  window.addEventListener("resize", () => {
    positionLayers();
    scheduleHitRegions();
  });

  // Native cursor tracking keeps these regions clickable even when an inactive
  // WebView receives no mousemove events. Never report the transparent #stack.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(scheduleHitRegions);
    for (const id of hitSurfaceIds) observer.observe($(id));
  }
  document.addEventListener("animationend", scheduleHitRegions, true);
  document.addEventListener("transitionend", scheduleHitRegions, true);
  document.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.ctrlKey && (event.target as HTMLElement | null)?.closest(hitSurfaceSelector)) {
      void api.action("pointer-hold", { active: true });
    }
  }, true);
  const releasePointerHold = () => void api.action("pointer-hold", { active: false });
  document.addEventListener("pointerup", releasePointerHold, true);
  document.addEventListener("pointercancel", releasePointerHold, true);
  window.addEventListener("blur", releasePointerHold);

  api.subscribe(render);
  void api.action("state").then(render);
})();
