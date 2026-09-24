import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODEL_PORT = 18089;
const MODEL_PROTOCOL_VERSION = '1.0.0';

export type LocalModelStatus = 'starting' | 'running' | 'attached' | 'conflict' | 'error' | 'stopped';

export interface LocalModelState {
  status: LocalModelStatus;
  detail: string;
}

interface RuntimeManifest {
  schemaVersion: number;
  product: string;
  platform: string;
  arch: string;
  entry: string;
  args: string[];
  env?: Record<string, string>;
}

interface ModelProcess {
  pid?: number;
  exitCode: number | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnModel = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ModelProcess;

type FetchModel = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LocalModelSupervisorOptions {
  runtimeRoot: string;
  onState: (state: LocalModelState) => void;
  onLog?: (message: string) => void;
  fetchImpl?: FetchModel;
  spawnImpl?: SpawnModel;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

function confined(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('local-model runtime path must be relative');
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('local-model runtime path escapes its root');
  return target;
}

function readRuntime(root: string): RuntimeManifest {
  const manifestPath = path.join(root, 'runtime.json');
  const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
  if (value.schemaVersion !== 1
    || value.product !== 'keepwork-local-model-node-runtime'
    || value.platform !== 'windows'
    || value.arch !== 'x64'
    || !Array.isArray(value.args)
    || value.args.join('\0') !== ['serve', '--port', String(MODEL_PORT)].join('\0')) {
    throw new Error('local-model runtime manifest is incompatible');
  }
  confined(root, value.entry);
  return value;
}

export class LocalModelSupervisor {
  private readonly runtimeRoot: string;
  private readonly onState: (state: LocalModelState) => void;
  private readonly onLog: (message: string) => void;
  private readonly fetchImpl: FetchModel;
  private readonly spawnImpl: SpawnModel;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private process: ModelProcess | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private stopping = false;
  private state: LocalModelState = { status: 'stopped', detail: '模型服务未启动' };

  constructor(options: LocalModelSupervisorOptions) {
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.onState = options.onState;
    this.onLog = options.onLog || (() => {});
    this.fetchImpl = options.fetchImpl || fetch;
    this.spawnImpl = options.spawnImpl || ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcess);
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  currentState(): LocalModelState {
    return { ...this.state };
  }

  private update(status: LocalModelStatus, detail: string): void {
    if (this.state.status === status && this.state.detail === detail) return;
    this.state = { status, detail };
    this.onLog(`${status}: ${detail}`);
    this.onState(this.currentState());
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer) return;
    const delay = Math.min(this.retryBaseMs * (2 ** this.retryAttempt), this.retryMaxMs);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.maintain();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async probe(): Promise<{ reachable: boolean; valid: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${MODEL_PORT}/v1/health`, { signal: controller.signal });
      if (!response.ok) return { reachable: true, valid: false };
      const health = await response.json() as { service?: string; status?: string; protocolVersion?: string };
      return {
        reachable: true,
        valid: health.service === 'keepwork-local-model'
          && health.status === 'ok'
          && health.protocolVersion === MODEL_PROTOCOL_VERSION,
      };
    } catch {
      return { reachable: false, valid: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private startProcess(): void {
    let manifest: RuntimeManifest;
    try {
      manifest = readRuntime(this.runtimeRoot);
    } catch (error) {
      this.update('error', `安装包缺少有效模型运行时：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const command = path.join(this.runtimeRoot, 'node.exe');
    const entry = confined(this.runtimeRoot, manifest.entry);
    if (!fs.statSync(command, { throwIfNoEntry: false })?.isFile()
      || !fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) {
      this.update('error', '安装包缺少模型运行时文件');
      return;
    }
    const runtimeEnv = Object.fromEntries(Object.entries(manifest.env || {}).map(([key, value]) => [
      key,
      key === 'LOCAL_MODEL_ROOT' ? confined(this.runtimeRoot, value) : value,
    ]));
    this.update('starting', `端口 ${MODEL_PORT}`);
    const child = this.spawnImpl(command, [entry, ...manifest.args], {
      env: { ...process.env, ...runtimeEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;
    child.stdout?.on('data', chunk => this.onLog(`stdout: ${String(chunk).trim()}`));
    child.stderr?.on('data', chunk => this.onLog(`stderr: ${String(chunk).trim()}`));
    child.once('error', error => {
      if (this.process === child) this.process = null;
      this.update('error', error.message);
      this.scheduleRetry();
    });
    child.once('exit', code => {
      if (this.process === child) this.process = null;
      if (!this.stopping) {
        this.update('error', `模型服务已退出（${code ?? 'unknown'}）`);
        this.scheduleRetry();
      }
    });
  }

  async maintain(): Promise<void> {
    if (this.stopping) return;
    const probe = await this.probe();
    if (probe.valid) {
      this.clearRetry();
      this.retryAttempt = 0;
      this.update(this.process ? 'running' : 'attached', `协议 ${MODEL_PROTOCOL_VERSION}，端口 ${MODEL_PORT}`);
      return;
    }
    if (probe.reachable) {
      this.update('conflict', `${MODEL_PORT} 已被其他或不兼容服务占用`);
      return;
    }
    if (!this.process) this.startProcess();
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    const child = this.process;
    this.process = null;
    if (child?.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
        child.once('exit', finish);
        if (!child.kill()) finish();
      });
    }
    this.update('stopped', '模型服务已停止');
  }
}

export const LOCAL_MODEL_PORT = MODEL_PORT;
export const LOCAL_MODEL_PROTOCOL_VERSION = MODEL_PROTOCOL_VERSION;
