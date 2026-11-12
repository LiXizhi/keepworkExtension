import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface CaptureCommand { op: "start" | "activate" | "stop"; id: string }
interface CaptureEvent {
  type: "claim" | "ready" | "active" | "audio" | "error" | "ended";
  sampleRate?: number;
  channels?: number;
  format?: string;
  seq?: number;
  samples?: number[];
  message?: string;
}
interface CaptureDependencies {
  report(id: string, event: CaptureEvent): Promise<unknown>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  isVisible(): boolean;
  isSecure(): boolean;
  resumeTimeoutMs?: number;
  maxQueuedChunks?: number;
}
interface CaptureOperation {
  id: string;
  cancelled: boolean;
  ready: boolean;
  active: boolean;
  activating: boolean;
  seq: number;
  queued: number;
  sampleRate?: number;
  resampleSum: number;
  resampleWeight: number;
  chain: Promise<void>;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  silent?: GainNode;
  cancelResume?: () => void;
}

// The visible pet owns microphone resources only. ASR, settings, credentials and
// the destination draft stay with the validated main page that owns the lease.
export function createPetAudioCapture(deps: CaptureDependencies) {
  let current: CaptureOperation | null = null;
  let disposed = false;
  const valid = (owned: CaptureOperation) => !disposed && current === owned && !owned.cancelled;

  function report(owned: CaptureOperation, event: CaptureEvent, terminal = false): Promise<unknown> {
    const task = owned.chain.then(async () => {
      if (terminal || valid(owned)) {
        const accepted = await deps.report(owned.id, event);
        if (!terminal && accepted !== true) throw Error("语音输入请求已失效，请重新点击语音输入");
        return accepted;
      }
      return undefined;
    });
    // All IPC stays serial, including ready and terminal events. Each caller
    // handles its own error; a rejected transport cannot poison the queue.
    owned.chain = task.then(() => {}, () => {});
    return task;
  }

  function release(owned: CaptureOperation): void {
    owned.cancelled = true;
    owned.active = false;
    owned.cancelResume?.();
    owned.cancelResume = undefined;
    if (current === owned) current = null;
    if (owned.processor) owned.processor.onaudioprocess = null;
    for (const node of [owned.processor, owned.source, owned.silent]) {
      try { node?.disconnect(); } catch { /* A superseded graph may already be disconnected. */ }
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

  function end(owned: CaptureOperation, type: "error" | "ended", message: string): void {
    if (!valid(owned)) return;
    release(owned);
    // Previously queued audio is abandoned only together with a terminal event;
    // never keep recording while silently dropping frames under backpressure.
    void report(owned, { type, message: message.slice(0, 300) }, true).catch(() => {});
  }

  async function resume(owned: CaptureOperation, context: AudioContext): Promise<boolean> {
    if (context.state === "running") return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = new Promise<boolean>(resolve => { owned.cancelResume = () => resolve(false); });
      const resumed = await Promise.race([
        Promise.resolve(context.resume()).then(() => true),
        cancelled,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("麦克风音频未能启动，请重试语音输入")), deps.resumeTimeoutMs ?? 5000); }),
      ]);
      if (!resumed || !valid(owned)) return false;
      if (String(context.state) !== "running") throw Error("麦克风音频未能启动，请重试语音输入");
      return true;
    } finally {
      clearTimeout(timer);
      owned.cancelResume = undefined;
    }
  }

  function sendSamples(owned: CaptureOperation, input: Float32Array, sampleRate: number): void {
    if (!valid(owned) || !owned.ready || !owned.active) return;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || input.length > 16384) {
      end(owned, "error", "麦克风音频格式不可用，请重试"); return;
    }
    if (owned.sampleRate !== undefined && owned.sampleRate !== sampleRate) {
      end(owned, "error", "麦克风音频格式已变化，请重试"); return;
    }
    owned.sampleRate = sampleRate;
    const ratio = sampleRate / 16000;
    if (Math.ceil(input.length / ratio) > 32768) { end(owned, "error", "麦克风音频格式不可用，请重试"); return; }
    let samples: number[] = [];
    const send = (): boolean => {
      if (owned.queued >= (deps.maxQueuedChunks ?? 8)) {
        end(owned, "error", "语音传输暂时阻塞，录音已停止，请重试"); return false;
      }
      const seq = ++owned.seq;
      owned.queued++;
      void report(owned, { type: "audio", seq, samples }).catch(error => {
        if (valid(owned)) end(owned, "error", String(error?.message || error));
      }).finally(() => { owned.queued--; });
      samples = [];
      return true;
    };
    // Keep the fractional output window between callbacks. For example, three
    // 4096-frame buffers at 48 kHz must produce exactly 4096 samples at 16 kHz.
    for (const inputValue of input) {
      if (!Number.isFinite(inputValue)) { end(owned, "error", "麦克风音频格式不可用，请重试"); return; }
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
          if (samples.length === 4096 && !send()) return;
        }
      }
    }
    if (samples.length) send();
  }

  async function start(id: string): Promise<void> {
    if (current?.id === id) return;
    if (current) release(current);
    const owned: CaptureOperation = { id, cancelled: false, ready: false, active: false, activating: false, seq: 0, queued: 0, resampleSum: 0, resampleWeight: 0, chain: Promise.resolve() };
    current = owned;
    try {
      // Events can be emitted by other webviews. The native lease must accept
      // this exact pet click before any microphone permission is requested.
      const accepted = await report(owned, { type: "claim" });
      if (accepted !== true) throw Error("语音输入请求已失效，请重新点击语音输入");
      if (!valid(owned)) return;
      if (!deps.isSecure() || !deps.isVisible()) throw Error("请显示桌面宠物后重试语音输入");
      const stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!valid(owned)) { for (const track of stream.getTracks()) track.stop(); return; }
      owned.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => end(owned, "ended", "麦克风已断开"), { once: true });
      const context = deps.createAudioContext();
      owned.context = context;
      if (!await resume(owned, context) || !valid(owned)) return;
      owned.source = context.createMediaStreamSource(stream);
      owned.processor = context.createScriptProcessor(4096, 1, 1);
      owned.silent = context.createGain();
      owned.silent.gain.value = 0;
      owned.processor.onaudioprocess = event => sendSamples(owned, event.inputBuffer.getChannelData(0), context.sampleRate);
      owned.source.connect(owned.processor);
      owned.processor.connect(owned.silent);
      owned.silent.connect(context.destination);
      owned.ready = true;
      await report(owned, { type: "ready", sampleRate: 16000, channels: 1, format: "pcm16" });
      if (!valid(owned)) release(owned);
    } catch (error) {
      end(owned, "error", String((error as Error)?.message || error));
    }
  }

  return {
    async command(raw: unknown): Promise<void> {
      const command = raw as Partial<CaptureCommand> | null;
      if (disposed || !command || typeof command.id !== "string" || !command.id || command.id.length > 160) return;
      if (command.op === "start") { await start(command.id); return; }
      const owned = current;
      if (!owned || command.id !== owned.id) return;
      if (command.op === "stop") release(owned);
      else if (command.op === "activate" && owned.ready && !owned.active && !owned.activating) {
        owned.activating = true;
        try {
          await report(owned, { type: "active" });
          if (valid(owned)) owned.active = true;
        } catch (error) {
          if (valid(owned)) end(owned, "error", String((error as Error)?.message || error));
        } finally { owned.activating = false; }
      }
    },
    hidden(): void { if (current) end(current, "ended", "宠物窗口已隐藏，录音已停止"); },
    dispose(): void {
      if (current) end(current, "ended", "宠物窗口已关闭，录音已停止");
      disposed = true;
    },
  };
}

export function installPetAudioCapture(): () => void {
  const capture = createPetAudioCapture({
    report: (id, event) => invoke("desktop_pet_audio_event", { id, event }),
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
    isVisible: () => document.visibilityState !== "hidden",
    isSecure: () => window.isSecureContext,
  });
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<CaptureCommand>("aichat-desktop:pet-audio-command", event => { void capture.command(event.payload); })
    .then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
  const hidden = () => { if (document.visibilityState === "hidden") capture.hidden(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    capture.dispose();
    unlisten?.();
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", dispose);
  };
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", dispose);
  return dispose;
}
