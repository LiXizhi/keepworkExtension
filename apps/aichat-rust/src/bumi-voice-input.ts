import { Channel, invoke } from "@tauri-apps/api/core";

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";
export interface VoiceEvent {
  type: "preview" | "done" | "error";
  text?: string;
  message?: string;
}
interface VoiceDependencies {
  start(id: string, events: Channel<VoiceEvent>): Promise<void>;
  send(id: string, samples: number[]): Promise<void>;
  finish(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createId(): string;
  canCapture(): boolean;
  onPhase(phase: VoicePhase, message: string): void;
  onPreview(text: string): void;
  onResult(text: string): void;
}
interface ActiveCapture {
  id: string;
  started: boolean;
  finishing: boolean;
  sampleRate?: number;
  resampleSum: number;
  resampleWeight: number;
  queued: number;
  chain: Promise<void>;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  silent?: GainNode;
}

export function createBumiVoiceInput(deps: VoiceDependencies) {
  let current: ActiveCapture | null = null;

  function release(owned: ActiveCapture) {
    owned.finishing = true;
    if (owned.processor) owned.processor.onaudioprocess = null;
    for (const node of [owned.processor, owned.source, owned.silent]) {
      try { node?.disconnect(); } catch { /* The graph may already be disconnected. */ }
    }
    owned.processor = undefined;
    owned.source = undefined;
    owned.silent = undefined;
    for (const track of owned.stream?.getTracks() || []) {
      try { track.stop(); } catch { /* Release the remaining tracks as well. */ }
    }
    owned.stream = undefined;
    try { void owned.context?.close().catch(() => {}); } catch { /* Already closed. */ }
    owned.context = undefined;
  }

  function fail(owned: ActiveCapture, cause: unknown) {
    if (current !== owned) return;
    current = null;
    release(owned);
    deps.onPhase("idle", String((cause as Error)?.message || cause));
  }

  async function cancelNative(owned: ActiveCapture) {
    try { await deps.cancel(owned.id); } catch { /* The native window may already be closed. */ }
  }

  function queueSamples(owned: ActiveCapture, samples: number[]) {
    if (owned.queued >= 8) {
      void cancelNative(owned);
      fail(owned, "语音传输暂时阻塞，录音已停止，请重试。");
      return;
    }
    owned.queued++;
    const task = owned.chain.then(async () => {
      if (current === owned) await deps.send(owned.id, samples);
    });
    owned.chain = task.then(() => {}, () => {});
    void task.catch(cause => {
      if (current === owned) {
        void cancelNative(owned);
        fail(owned, cause);
      }
    }).finally(() => { owned.queued--; });
  }

  function sendSamples(owned: ActiveCapture, input: Float32Array, sampleRate: number) {
    if (current !== owned || !owned.started || owned.finishing) return;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || input.length > 16384 ||
        (owned.sampleRate !== undefined && owned.sampleRate !== sampleRate)) {
      void cancelNative(owned);
      fail(owned, "麦克风音频格式不可用，请重试语音输入。");
      return;
    }
    owned.sampleRate = sampleRate;
    const ratio = sampleRate / 16000;
    let samples: number[] = [];
    const send = () => {
      queueSamples(owned, samples);
      samples = [];
    };
    for (const inputValue of input) {
      if (!Number.isFinite(inputValue)) {
        void cancelNative(owned);
        fail(owned, "麦克风音频格式不可用，请重试语音输入。");
        return;
      }
      let remaining = 1;
      while (remaining > 1e-10) {
        const weight = Math.min(remaining, ratio - owned.resampleWeight);
        owned.resampleSum += inputValue * weight;
        owned.resampleWeight += weight;
        remaining -= weight;
        if (owned.resampleWeight >= ratio - 1e-10) {
          const value = Math.max(-1, Math.min(1, owned.resampleSum / ratio));
          samples.push(Math.trunc(value * (value < 0 ? 32768 : 32767)));
          owned.resampleSum = 0;
          owned.resampleWeight = 0;
          if (samples.length === 4096) send();
        }
      }
    }
    if (samples.length) send();
  }

  async function start() {
    if (current) return;
    const events = new Channel<VoiceEvent>();
    const owned: ActiveCapture = {
      id: deps.createId(), started: false, finishing: false, resampleSum: 0, resampleWeight: 0,
      queued: 0, chain: Promise.resolve(),
    };
    current = owned;
    events.onmessage = event => {
      if (current !== owned || event?.type === "preview" && typeof event.text !== "string") return;
      if (event.type === "preview") {
        deps.onPreview(event.text!);
        return;
      }
      current = null;
      release(owned);
      if (event.type === "done" && typeof event.text === "string" && event.text.trim()) {
        deps.onPhase("idle", "");
        deps.onResult(event.text.trim());
      } else {
        deps.onPhase("idle", event.type === "done" ? "没有识别到文字，请再试一次。" : event.message || "语音识别失败，请重试。");
      }
    };
    deps.onPhase("starting", "正在准备麦克风…");
    try {
      if (!deps.canCapture()) throw new Error("Bumi 窗口已失去焦点，请重新语音输入。");
      const stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (current !== owned) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      owned.stream = stream;
      if (!deps.canCapture()) throw new Error("Bumi 窗口已失去焦点，请重新语音输入。");
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (current !== owned || owned.finishing) return;
        void cancelNative(owned);
        fail(owned, "麦克风已断开，请重新语音输入。");
      }, { once: true });
      const context = deps.createAudioContext();
      owned.context = context;
      if (context.state !== "running") await context.resume();
      if (current !== owned) return;
      if (context.state !== "running") throw new Error("麦克风音频未能启动，请重试语音输入。");
      owned.source = context.createMediaStreamSource(stream);
      owned.processor = context.createScriptProcessor(4096, 1, 1);
      owned.silent = context.createGain();
      owned.silent.gain.value = 0;
      owned.processor.onaudioprocess = event => sendSamples(owned, event.inputBuffer.getChannelData(0), context.sampleRate);
      owned.source.connect(owned.processor);
      owned.processor.connect(owned.silent);
      owned.silent.connect(context.destination);
      await deps.start(owned.id, events);
      if (current !== owned) return;
      owned.started = true;
      deps.onPhase("recording", "正在听写，说完请点“结束并识别”。");
    } catch (cause) {
      if (current === owned) {
        void cancelNative(owned);
        fail(owned, cause);
      }
    }
  }

  async function finish() {
    const owned = current;
    if (!owned || !owned.started || owned.finishing) return;
    owned.finishing = true;
    release(owned);
    deps.onPhase("transcribing", "正在识别语音…");
    await owned.chain;
    if (current !== owned) return;
    try { await deps.finish(owned.id); }
    catch (cause) { fail(owned, cause); }
  }

  function cancel(message = "已取消语音输入。") {
    const owned = current;
    if (!owned) return;
    current = null;
    release(owned);
    void cancelNative(owned);
    deps.onPhase("idle", message);
  }

  return {
    start,
    finish,
    cancel,
    toggle() {
      if (!current) void start();
      else if (current.finishing) cancel("已取消识别。");
      else if (current.started && current.context) void finish();
      else cancel();
    },
    active: () => current !== null,
  };
}

export function createLocalBumiVoiceInput(callbacks: Pick<VoiceDependencies, "onPhase" | "onPreview" | "onResult">) {
  return createBumiVoiceInput({
    ...callbacks,
    start: (id, events) => invoke("bumi_voice_input", { request: { operation: "start", id }, events }),
    send: (id, samples) => invoke("bumi_voice_input", { request: { operation: "audio", id, samples } }),
    finish: id => invoke("bumi_voice_input", { request: { operation: "stop", id } }),
    cancel: id => invoke("bumi_voice_input", { request: { operation: "cancel", id } }),
    getUserMedia: constraints => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("当前窗口无法使用麦克风，请使用文字输入。");
      return navigator.mediaDevices.getUserMedia(constraints);
    },
    createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
    createId: () => crypto.randomUUID(),
    canCapture: () => document.hasFocus() && !document.hidden,
  });
}
