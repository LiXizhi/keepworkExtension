import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopPetBridge } from "./types";
import { installPetAudioCapture } from "./petAudio";

interface PetOption {
  icon?: string;
  text: string;
}

interface PetReply {
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
  canSwitchTarget?: boolean;
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
  let choosing = false;
  let hitRegionsQueued = false;
  let hitRegionsSignature = "";
  let jelly: Animation | undefined;
  const artStyle: Record<string, string> = {};
  const hitSurfaceIds = ["pet", "panel", "bubble", "compact-controls", "exit-bubble", "permission-bubble"];
  const hitSurfaceSelector = hitSurfaceIds.map((id) => `#${id}`).join(", ");

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
    $("pet").style.transform = `translate3d(${state.petLeft}px, ${state.petTop}px, 0)`;
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
    if (next.context !== state.context) {
      edits = 0;
      draftRevision++;
      unsynced = false;
      localError = "";
      draftEl.value = next.draft || "";
    }
    state = next;
    if (typeof next.expanded === "boolean") {
      expanded = next.expanded;
      $("panel").hidden = !expanded;
    }
    const pet = state.preferences?.appearance === "dragon" ? {} : state.pet || {};
    if ($("art").textContent !== "") $("art").textContent = "";
    const image = pet.imageData || pet.sheetUrl;
    setArtStyle("backgroundImage", image ? `url(${JSON.stringify(image)})` : "");
    setArtStyle("backgroundSize", image ? pet.bgSize || "400% 400%" : "");
    setArtStyle("backgroundPosition", image ? pet.bgPos || "0% 0%" : "");
    document.body.style.setProperty("--pet-pixels", `${state.petPixels || 112}px`);
    $("pet").title = `${pet.name || "宠物"}${localError ? ` · ${localError}` : ""} · 单击聊天 · 双击打开桌面 · 右键设置 · 拖动移动`;

    const title = state.target === "persona" ? state.title || "我的分身" : `会话 · ${state.title || "AIChat"}`;
    $("target-title").textContent = `${title} ⇄`;
    const folderName = (state.folder || "").split(/[\\/]/).filter(Boolean).pop() || state.folder || "";
    $("target-detail").textContent =
      state.target === "persona"
        ? folderName || "第二大脑"
        : `技能：${state.skill || "无"} · 文件夹：${folderName || "未绑定"}`;
    const targetBtn = $<HTMLButtonElement>("target");
    targetBtn.title = `${$("target-title").textContent}\n${$("target-detail").textContent}${
      state.folder ? `\n${state.folder}` : ""
    }\n点击切换到${state.target === "persona" ? "聊天会话" : "我的分身"}`;
    targetBtn.disabled =
      !state.canSwitchTarget || !!state.dictating || !!state.voice?.active || !!edits || unsynced;
    $("badge").hidden = !(state.busy || state.voice?.active || state.attention || state.error || localError);

    if (!edits && !unsynced) draftEl.value = state.draft || "";
    draftEl.disabled = !!state.richDraft || !!state.dictating;

    const sendBtn = $<HTMLButtonElement>("send");
    sendBtn.textContent = state.busy ? "停止" : "发送";
    sendBtn.disabled = !state.ready || (!state.busy && (!!state.richDraft || !!state.dictating));

    const dictationBtn = $<HTMLButtonElement>("dictation");
    dictationBtn.textContent = state.dictating ? "停止输入" : "语音输入";
    dictationBtn.disabled = !state.ready || !!state.richDraft || !!state.voice?.active;

    const callBtn = $<HTMLButtonElement>("call");
    callBtn.textContent = state.voice?.active ? "结束通话" : "通话";
    callBtn.title =
      state.canCall || state.voice?.active ? "实时语音对话" : "请在 AIChat 中选择实时语音模型";
    callBtn.disabled = !state.ready || (!state.canCall && !state.voice?.active) || !!state.dictating;

    const muteBtn = $<HTMLButtonElement>("mute");
    muteBtn.hidden = !state.voice?.active;
    muteBtn.textContent = state.voice?.muted ? "取消静音" : "静音";

    const voiceLabelMap: Record<string, string> = {
      starting: "连接中",
      listening: "聆听中",
      thinking: "思考中",
      speaking: "说话中",
      stopping: "结束中",
      discussing: "讨论中",
    };
    $("status").textContent =
      state.attention ||
      (state.richDraft
        ? "含附件或文件引用，请在 AIChat 中编辑。"
        : state.voice?.active
          ? `语音：${state.voice.muted ? "已静音" : voiceLabelMap[state.voice.state || ""] || "通话中"}`
          : state.busy
            ? "正在回复…"
            : "");
    if (!state.ready && !state.richDraft && !state.dictating) {
      $("status").textContent = [$("status").textContent, "可先输入草稿，连接后点击发送。"]
        .filter(Boolean).join("\n");
    }
    $("error").textContent = localError || state.error || "";

    const reply = state.reply;
    $("bubble").hidden = !reply || (!reply.text && !reply.options?.length);
    $("bubble").classList.toggle("thinking", !!reply?.thinking);
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
      const context = state.context;
      $("options").replaceChildren(
        ...(reply?.options || []).map((option) => {
          const button = document.createElement("button");
          button.textContent = [option.icon, option.text].filter(Boolean).join(" ");
          button.onclick = async () => {
            if (
              choosing ||
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
                if (reply?.immediate !== false) await action("send");
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
    for (const child of Array.from($("options").children)) {
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
    $("compact-controls").hidden = expanded || !!exit || !!permission || !state.compactVoice;
    const compactRecordBtn = $<HTMLButtonElement>("compact-record");
    compactRecordBtn.hidden = !rec;
    compactRecordBtn.textContent = rec?.enabled ? "停止录音" : "开始录音";
    compactRecordBtn.setAttribute("aria-pressed", String(!!rec?.enabled));
    compactRecordBtn.disabled =
      !state.ready ||
      !!state.dictating ||
      (!rec?.enabled && active) ||
      ["starting", "stopping"].includes(rec?.phase || "");

    const compactCallBtn = $<HTMLButtonElement>("compact-call");
    compactCallBtn.textContent = active ? "停止语音" : "开始语音";
    compactCallBtn.setAttribute("aria-pressed", String(active));
    compactCallBtn.disabled =
      !state.ready ||
      !!state.dictating ||
      (!active && !state.canCall) ||
      ["starting", "stopping"].includes(state.voice?.state || "");

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
    $("compact-status").textContent =
      localError ||
      state.error ||
      rec?.error ||
      (active
        ? compactVoiceStateMap[state.voice?.state || ""] || (state.voice?.muted ? "语音已静音" : "语音中")
        : recPhaseMap[rec?.phase || ""] || "");

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

  function action(name: string, args: Record<string, unknown> = {}): Promise<boolean> {
    const context = state.context;
    const task = queue.then(async () => {
      if (context !== state.context) throw new Error("会话已改变，请重试");
      if (["input", "send"].includes(name) && !state.ready) {
        throw new Error("请先在 AIChat 中连接本机服务和第二大脑，草稿已保留。");
      }
      const next = await api.action(name, { ...args, context });
      if (context !== state.context) return false;
      localError = "";
      if (next) render(next);
      return true;
    });
    queue = task.catch((err: unknown) => {
      if (context !== state.context) return false;
      const msg = err instanceof Error ? err.message : String(err);
      localError = msg.replace(/^Error invoking remote method '[^']+': Error: /, "");
      $("error").textContent = localError;
      return false;
    });
    return queue;
  }

  async function expand(value: boolean): Promise<void> {
    if (state.exitPrompt || state.permission) return;
    const opening = value && !expanded;
    expanded = value;
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
    await api.action("expand", { expanded });
    $("panel").hidden = !expanded;
    scheduleHitRegions();
    const draftEl = $<HTMLTextAreaElement>("draft");
    if (expanded && !draftEl.disabled) draftEl.focus();
  }

  const draftEl = $<HTMLTextAreaElement>("draft");
  draftEl.addEventListener("input", () => {
    const context = state.context;
    const revision = ++draftRevision;
    unsynced = true;
    // Older AIChat pages reject input while offline. Keep these edits local
    // until the user edits again online or explicitly sends the draft.
    if (!state.ready) {
      render(state as unknown as Record<string, unknown>);
      return;
    }
    edits++;
    void action("input", { text: draftEl.value }).then((ok) => {
      if (context === state.context) {
        edits = Math.max(0, edits - 1);
        if (revision === draftRevision) unsynced = !ok;
        if (!edits) {
          render(state as unknown as Record<string, unknown>);
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
    await queue;
    if (context !== state.context || !state.ready) return;
    if (name === "send" && (state.busy || state.richDraft || state.dictating)) return;
    if (name === "send" && unsynced) {
      const revision = draftRevision;
      if (!(await action("input", { text: draftEl.value }))) return;
      if (context !== state.context || revision !== draftRevision || !state.ready ||
          state.busy || state.richDraft || state.dictating) return;
      unsynced = false;
    }
    void action(name);
  };

  $("compact-record").onclick = () =>
    void action(state.classroomRecording?.enabled ? "record-stop" : "record-start");
  $("compact-call").onclick = () =>
    void action(state.voice?.active ? "voice-stop" : "voice-start");

  for (const name of ["dictation", "call", "mute"]) {
    $(name).onclick = () => {
      void action(name);
    };
  }

  $("target").onclick = async () => {
    await queue;
    if (!edits && !unsynced) await action("toggle-target");
  };

  $("open").onclick = () => {
    void api.action("open");
  };

  $("reply").onclick = () => {
    if (!window.getSelection()?.toString()) void api.action("open");
  };

  $("reply").onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void api.action("open");
    }
  };

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
