import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  ModelAdapter,
  ModelConfig,
  ModelHealth,
  ModelInfo,
  ModelInput,
  ModelOutput,
} from '../core/types.js';
import type { LoadedModelConfig } from '../core/config.js';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol.js';
import { LocalModelError } from '../core/errors.js';
import { fromProjectRoot } from '../core/paths.js';
import { verifyModelPackage } from '../core/integrity.js';

interface Task {
  id: string;
  operation: 'embedding' | 'compare';
  input: ModelInput;
  signal: AbortSignal;
  resolve: (value: ModelOutput) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
  abort?: () => void;
}

export class SpeakerWorkerAdapter implements ModelAdapter {
  readonly config: ModelConfig;
  readonly configSource: string;
  private state: ModelHealth['state'] = 'unloaded';
  private worker: Worker | null = null;
  private loadPromise: Promise<ModelInfo> | null = null;
  private readyResolve: ((info: ModelInfo) => void) | null = null;
  private readyReject: ((error: unknown) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private queue: Task[] = [];
  private active: Task | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private loadedAt: number | undefined;
  private lastUsedAt: number | undefined;
  private lastError: ReturnType<LocalModelError['toBody']> | undefined;
  private installed = false;
  private trusted = false;

  constructor(loaded: LoadedModelConfig) {
    this.config = loaded.config;
    this.configSource = loaded.source;
  }

  async inspectIntegrity(): Promise<void> {
    try {
      await verifyModelPackage(this.config);
      this.installed = true;
      this.trusted = true;
      if (this.state === 'not-installed' || this.state === 'error') this.state = 'unloaded';
      this.lastError = undefined;
    } catch (error) {
      const local = error instanceof LocalModelError ? error : new LocalModelError('MODEL_PACKAGE_INVALID', String(error));
      this.installed = local.code !== 'MODEL_NOT_INSTALLED';
      this.trusted = false;
      this.state = local.code === 'MODEL_NOT_INSTALLED' ? 'not-installed' : 'error';
      this.lastError = local.toBody();
    }
  }

  info(): ModelInfo {
    return {
      id: this.config.identity.id,
      version: this.config.identity.version,
      capability: this.config.identity.capability,
      state: this.state,
      installed: this.installed,
      trusted: this.trusted,
      operations: [...this.config.operations],
      transports: { ...this.config.transports },
      input: { ...this.config.input, encodings: [...this.config.input.encodings], valueRange: [...this.config.input.valueRange] },
      output: { ...this.config.output },
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async load(): Promise<ModelInfo> {
    if (this.state === 'ready' && this.worker) return this.info();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.startWorker().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  private async startWorker(): Promise<ModelInfo> {
    await this.inspectIntegrity();
    if (!this.installed || !this.trusted) {
      throw new LocalModelError(
        this.lastError?.code ?? 'MODEL_NOT_INSTALLED',
        this.lastError?.message ?? 'Model package is unavailable',
        { status: 503 },
      );
    }
    const platform = `${process.platform}-${process.arch}`;
    if (!this.config.artifact.platforms.includes(platform)) {
      throw new LocalModelError('PLATFORM_UNSUPPORTED', `Model ${this.config.identity.id} does not support ${platform}`, { status: 503 });
    }
    if (this.config.runtime.adapter !== 'sherpa-speaker-embedding') {
      throw new LocalModelError('ADAPTER_NOT_REGISTERED', `Unknown model adapter: ${this.config.runtime.adapter}`);
    }
    this.clearIdleTimer();
    this.state = 'loading';
    this.lastError = undefined;
    const workerUrl = new URL('../workers/speakerWorker.js', import.meta.url);
    const worker = new Worker(workerUrl);
    this.worker = worker;
    worker.on('message', (response: WorkerResponse) => this.handleWorkerMessage(response));
    worker.on('error', error => this.handleWorkerFailure(error));
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.state === 'unloading') {
        this.state = 'unloaded';
      } else if (code !== 0 || this.state === 'ready' || this.state === 'loading') {
        this.handleWorkerFailure(new Error(`Speaker worker exited with code ${code}`));
      }
    });
    const ready = new Promise<ModelInfo>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(() => {
      this.handleWorkerFailure(new LocalModelError(
        'MODEL_LOAD_TIMEOUT',
        'Model worker initialization timed out',
        { retryable: true, status: 504 },
      ));
    }, this.config.resources.timeoutMs);
    const request: WorkerRequest = {
      type: 'initialize',
      modelPath: fromProjectRoot(this.config.artifact.path),
      threads: this.config.runtime.threads,
      provider: this.config.runtime.provider,
      expectedDimension: this.config.output.dimension,
    };
    worker.postMessage(request);
    return ready;
  }

  async invoke(operation: string, input: ModelInput, signal: AbortSignal): Promise<ModelOutput> {
    if (!this.config.operations.includes(operation as 'embedding' | 'compare')) {
      throw new LocalModelError('OPERATION_UNSUPPORTED', `Operation ${operation} is not supported`, { status: 400 });
    }
    if (operation === 'compare' && (!input.template || input.template.length !== this.config.output.dimension)) {
      throw new LocalModelError('TEMPLATE_INVALID', `Speaker template must contain ${this.config.output.dimension} values`, { status: 400 });
    }
    if (signal.aborted) throw new LocalModelError('REQUEST_ABORTED', 'Request was aborted', { retryable: true, status: 499 });
    await this.load();
    if (this.queue.length + (this.active ? 1 : 0) >= this.config.resources.maxQueue + this.config.resources.maxConcurrency) {
      throw new LocalModelError('MODEL_QUEUE_FULL', 'Model inference queue is full', { retryable: true, status: 429 });
    }
    return new Promise<ModelOutput>((resolve, reject) => {
      const task: Task = {
        id: randomUUID(),
        operation: operation as 'embedding' | 'compare',
        input,
        signal,
        resolve,
        reject,
        settled: false,
      };
      task.abort = () => this.abortTask(task, new LocalModelError('REQUEST_ABORTED', 'Request was aborted', { retryable: true, status: 499 }));
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active || !this.worker || this.state !== 'ready') return;
    const task = this.queue.shift();
    if (!task) {
      this.scheduleIdleUnload();
      return;
    }
    if (task.signal.aborted) {
      this.finishTask(task, undefined, new LocalModelError('REQUEST_ABORTED', 'Request was aborted', { retryable: true, status: 499 }));
      this.drain();
      return;
    }
    this.clearIdleTimer();
    this.active = task;
    task.timer = setTimeout(() => {
      this.abortTask(task, new LocalModelError('MODEL_TIMEOUT', 'Model inference timed out', { retryable: true, status: 504 }));
    }, this.config.resources.timeoutMs);
    const samples = task.input.samples.slice().buffer as ArrayBuffer;
    const template = task.input.template?.slice().buffer as ArrayBuffer | undefined;
    const request: WorkerRequest = {
      type: 'invoke',
      id: task.id,
      operation: task.operation,
      samples,
      sampleRate: task.input.sampleRate,
      ...(template ? { template } : {}),
    };
    this.worker.postMessage(request, template ? [samples, template] : [samples]);
  }

  private handleWorkerMessage(response: WorkerResponse): void {
    if (response.type === 'ready') {
      this.clearReadyTimer();
      this.state = 'ready';
      this.loadedAt = Date.now();
      this.lastUsedAt = this.loadedAt;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      resolve?.(this.info());
      this.drain();
      return;
    }
    if (response.type === 'error' && !response.id) {
      this.handleWorkerFailure(new LocalModelError(response.error.code, response.error.message, {
        retryable: response.error.retryable,
        details: response.error.details,
      }));
      return;
    }
    const task = this.active;
    if (!task || response.id !== task.id) return;
    if (response.type === 'error') {
      this.finishTask(task, undefined, new LocalModelError(response.error.code, response.error.message, {
        retryable: response.error.retryable,
        details: response.error.details,
      }));
    } else if (task.operation === 'embedding' && response.embedding) {
      this.finishTask(task, { embedding: new Float32Array(response.embedding), processingMs: response.processingMs });
    } else if (task.operation === 'compare' && typeof response.score === 'number') {
      this.finishTask(task, { score: response.score, processingMs: response.processingMs });
    } else {
      this.finishTask(task, undefined, new LocalModelError('MODEL_RESPONSE_INVALID', 'Model worker returned an invalid response'));
    }
    this.active = null;
    this.lastUsedAt = Date.now();
    this.drain();
  }

  private abortTask(task: Task, error: LocalModelError): void {
    const queued = this.queue.indexOf(task);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.finishTask(task, undefined, error);
      return;
    }
    if (this.active === task) {
      this.finishTask(task, undefined, error);
      this.active = null;
      this.handleWorkerFailure(error);
    }
  }

  private finishTask(task: Task, result?: ModelOutput, error?: unknown): void {
    if (task.timer) clearTimeout(task.timer);
    if (task.abort) task.signal.removeEventListener('abort', task.abort);
    if (task.settled) return;
    task.settled = true;
    if (error) task.reject(error);
    else if (result) task.resolve(result);
  }

  private handleWorkerFailure(error: unknown): void {
    this.clearReadyTimer();
    const local = error instanceof LocalModelError
      ? error
      : new LocalModelError('MODEL_WORKER_CRASHED', error instanceof Error ? error.message : String(error), { retryable: true });
    this.state = 'error';
    this.lastError = local.toBody();
    this.readyReject?.(local);
    this.readyResolve = null;
    this.readyReject = null;
    if (this.active) this.finishTask(this.active, undefined, local);
    this.active = null;
    for (const task of this.queue.splice(0)) this.finishTask(task, undefined, local);
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }

  health(): ModelHealth {
    return {
      state: this.state,
      queueDepth: this.queue.length,
      activeRequests: this.active ? 1 : 0,
      ...(this.loadedAt === undefined ? {} : { loadedAt: this.loadedAt }),
      ...(this.lastUsedAt === undefined ? {} : { lastUsedAt: this.lastUsedAt }),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async dispose(): Promise<void> {
    this.clearIdleTimer();
    this.clearReadyTimer();
    const error = new LocalModelError('MODEL_UNLOADED', 'Model was unloaded', { retryable: true, status: 503 });
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    if (this.active) this.finishTask(this.active, undefined, error);
    this.active = null;
    for (const task of this.queue.splice(0)) this.finishTask(task, undefined, error);
    if (!this.worker) {
      this.state = this.installed && this.trusted ? 'unloaded' : this.state;
      return;
    }
    this.state = 'unloading';
    const worker = this.worker;
    this.worker = null;
    worker.postMessage({ type: 'dispose' } satisfies WorkerRequest);
    await worker.terminate();
    this.state = 'unloaded';
    this.loadedAt = undefined;
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer();
    if (this.config.resources.idleUnloadMs <= 0 || this.state !== 'ready') return;
    this.idleTimer = setTimeout(() => { void this.dispose(); }, this.config.resources.idleUnloadMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
