import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopPetBridge } from "./types";

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
  dragging?: boolean;
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
    ready: Promise<unknown>;
  } | null = null;
  let dragEpoch = 0;
  let acceptClicksUntil = 0;
  let releasedTap = false;
  let firstTap = false;
  let renderedMessages = "";
  let choosing = false;
  let interactive: boolean | null = null;
  let jelly: Animation | undefined;
  const artStyle: Record<string, string> = {};

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
  }

  function render(raw: Record<string, unknown> | null): void {
    const next = (raw || {}) as PetSnapshot;
    if (!next || next.version !== 1) return;
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
    interactive = null;
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
    $("pet").title = `${pet.name || "宠物"} · 单击聊天 · 双击打开桌面 · 右键设置 · 拖动移动`;

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
    $("badge").hidden = !(state.busy || state.voice?.active || state.attention || state.error);

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

    positionLayers();
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
    interactive = true;
    acceptClicksUntil = performance.now() + 400;
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
    void api.action("hit-test", { interactive: true });
  };

  $("pet").addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragEpoch += 1;
    document.body.classList.add("dragging");
    pointer = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false,
      tracking: false,
      ready: api.action("drag-start", { screenX: event.screenX, screenY: event.screenY }),
    };
    $("pet").setPointerCapture(event.pointerId);
  });

  $("pet").addEventListener("pointermove", (event) => {
    if (!pointer) return;
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
    const step = () => {
      const current = pointer;
      if (!current?.tracking) return;
      void current.ready
        .then(() => api.action("drag", { screenX: current.screenX, screenY: current.screenY }))
        .then((snap) => {
          if (!pointer?.tracking) return;
          if (!snap || typeof snap !== "object") {
            requestAnimationFrame(step);
            return;
          }
          state = { ...state, ...(snap as PetSnapshot) };
          positionLayers();
          if ((snap as PetSnapshot).dragging === false) {
            finishDrag(pointer?.id);
            return;
          }
          requestAnimationFrame(step);
        })
        .catch(() => {
          if (pointer?.tracking) requestAnimationFrame(step);
        });
    };
    requestAnimationFrame(step);
  });

  const release = async (event: PointerEvent): Promise<void> => {
    const current = pointer;
    pointer = null;
    document.body.classList.remove("dragging");
    if (current) releaseCapture(current.id);
    if (!current) return;
    releasedTap = !current.moved && event.type === "pointerup";
    if (!releasedTap) firstTap = false;
    await current.ready;
    await api.action("drag-end");
  };

  // Crossing monitors moves this window and WKWebView often synthesizes pointerup
  // while the button is still held. Keep the tracker running; the host ends it
  // when the button is actually up.
  $("pet").addEventListener("pointerup", (event) => {
    if (pointer?.tracking) {
      releasedTap = false;
      firstTap = false;
      return;
    }
    void release(event);
  });

  $("pet").addEventListener("click", (event) => {
    if (event.detail === 0) {
      void expand(!expanded);
      return;
    }
    if (!releasedTap) return;
    releasedTap = false;
    if (event.detail === 2 && firstTap) {
      firstTap = false;
      if (!state.exitPrompt && !state.permission) void api.action("open");
    } else {
      firstTap = event.detail === 1;
      if (firstTap) void expand(!expanded);
    }
  });

  $("pet").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void api.action("menu");
  });

  window.addEventListener("resize", () => {
    positionLayers();
  });

  document.addEventListener("mousemove", (event) => {
    const target = event.target as HTMLElement | null;
    const next =
      !!pointer ||
      !!target?.closest("#pet, #compact-controls, #panel, #bubble, #exit-bubble, #permission-bubble");
    if (!next && performance.now() < acceptClicksUntil) return;
    if (next !== interactive) {
      interactive = next;
      void api.action("hit-test", { interactive });
    }
  });

  api.subscribe(render);
  void api.action("state").then(render);
})();
