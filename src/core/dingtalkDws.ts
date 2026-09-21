import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFileSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { DingConfig, DingEvent, DingJob, atomicDingWrite } from './dingtalk';

export function resolveDws(): string {
    const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.env.APPDATA) directories.push(path.join(process.env.APPDATA, 'npm'));
    for (const directory of directories) {
        const binary = path.join(directory, process.platform === 'win32' ? 'dws.exe' : 'dws');
        if (fs.existsSync(binary) && fs.statSync(binary).isFile()) return binary;
        const vendor = path.join(directory, 'node_modules', 'dingtalk-workspace-cli', 'vendor', process.platform === 'win32' ? 'dws.exe' : 'dws');
        if (fs.existsSync(vendor)) return vendor;
    }
    if (process.platform !== 'win32') {
        try {
            const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            const binary = path.join(root, 'dingtalk-workspace-cli', 'vendor', 'dws');
            if (fs.existsSync(binary)) return binary;
        } catch { /* unavailable */ }
    }
    throw new Error('DWS not found; use interactive approved setup, no automatic installation');
}
export interface RetryInfo { retryable?: boolean; retry_after_seconds?: number; next_retry_at?: string; reason?: string }
export function dingRetryDelay(info: RetryInfo, retries: number, now = Date.now()): number | null {
    if (['terminal_hold', 'in_flight'].includes(info.reason || '')) return null;
    const budget = info.retryable === false ? 0 : info.retryable === true ? 2 : 1;
    if (retries >= budget) return null;
    const seconds = Number(info.retry_after_seconds);
    const next = Date.parse(info.next_retry_at || '');
    return Math.max(1000, Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0, Number.isFinite(next) ? next - now : 0);
}
export type DingSpawner = (args: string[]) => ChildProcessWithoutNullStreams;
const spawnDws: DingSpawner = args => spawn(resolveDws(), args, { windowsHide: true, stdio: 'pipe', shell: false });
export interface ListenerStatus { kind: string; state: string; retries: number; gapSince: number; nextRetryAt?: number }

export class DingListener {
    private child?: ChildProcessWithoutNullStreams;
    private timer?: NodeJS.Timeout;
    private stopped = false;
    private statusValue: ListenerStatus;
    private completion: Promise<void> = Promise.resolve();
    constructor(private profile: string, private kind: DingEvent['kind'], private receive: (event: DingEvent) => Promise<unknown>, private launch: DingSpawner = spawnDws, private checkpoint?: string) {
        this.statusValue = checkpoint && fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) as ListenerStatus
            : { kind, state: 'stopped', retries: 0, gapSince: Date.now() };
        if (this.statusValue.kind !== kind || !Number.isInteger(this.statusValue.retries) || this.statusValue.retries < 0) throw new Error('Invalid listener checkpoint');
        if (['starting', 'ready', 'stop-unconfirmed'].includes(this.statusValue.state)) this.statusValue.state = 'blocked';
    }
    private persist(): void { if (this.checkpoint) atomicDingWrite(this.checkpoint, this.statusValue); }
    status(): ListenerStatus { return { ...this.statusValue }; }
    start(): void {
        if (this.child || this.timer || this.stopped) return;
        if (this.statusValue.state === 'blocked') return;
        if (this.statusValue.nextRetryAt && this.statusValue.nextRetryAt > Date.now()) {
            const delay = this.statusValue.nextRetryAt - Date.now();
            if (delay > 2147483647) { this.statusValue.state = 'blocked'; this.persist(); return; }
            this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
            this.timer.unref();
            return;
        }
        this.statusValue.state = 'starting';
        this.persist();
        let child: ChildProcessWithoutNullStreams;
        try { child = this.launch(['--profile', this.profile, 'event', '+listen-im', '--kind', this.kind, '--flatten', '-f', 'ndjson']); }
        catch { this.statusValue.state = 'blocked'; this.persist(); return; }
        this.child = child;
        let stdout = '', stderr = '', ready = false, terminal = false;
        let info: RetryInfo = {};
        let pending: string[] = [];
        const fail = () => {
            terminal = true; this.statusValue.state = 'blocked'; child.stdin.end();
            try { this.persist(); } catch { this.stopped = true; }
        };
        const consume = (line: string) => {
            if (terminal || this.stopped) return;
            try {
                const value = JSON.parse(line) as Record<string, unknown>;
                const stamp = value.create_time ?? value.event_time ?? value.timestamp;
                let timestamp = typeof stamp === 'number' ? stamp : /^\d+$/.test(String(stamp)) ? Number(stamp) : Date.parse(String(stamp));
                if (timestamp < 100000000000) timestamp *= 1000;
                const event = { event_id: value.event_id, message_id: value.message_id, conversation_id: value.conversation_id,
                    sender_open_dingtalk_id: value.sender_open_dingtalk_id, content: typeof value.content === 'string' ? value.content : '', timestamp, kind: this.kind } as DingEvent;
                void this.receive(event).catch(() => fail());
            } catch { this.statusValue.state = 'malformed-event'; }
        };
        const startup = setTimeout(() => { if (!ready) fail(); }, 30000);
        startup.unref();
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
            if (Buffer.byteLength(stdout) > 128000) { fail(); return; }
            let index: number;
            while ((index = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, index).trim(); stdout = stdout.slice(index + 1);
                if (!line) continue;
                if (ready) consume(line);
                else if (pending.length < 10) pending.push(line); else fail();
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            if (Buffer.byteLength(stderr) > 64000) { fail(); stderr = ''; return; }
            let index: number;
            while ((index = stderr.indexOf('\n')) >= 0) {
                const line = stderr.slice(0, index).trim(); stderr = stderr.slice(index + 1);
                if (!terminal && !this.stopped && /^\[event\] ready (event_key=|event_count=)/.test(line)) {
                    ready = true; clearTimeout(startup); this.statusValue.state = 'ready';
                    try { this.persist(); } catch { fail(); return; }
                    for (const queued of pending) consume(queued);
                    pending = [];
                }
                try {
                    const parsed = JSON.parse(line) as { error?: RetryInfo } & RetryInfo;
                    info = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
                } catch { /* readiness and human status lines are not persisted */ }
            }
        });
        child.on('error', () => { terminal = true; this.statusValue.state = 'blocked'; });
        this.completion = new Promise(resolve => child.once('close', () => {
            clearTimeout(startup); this.child = undefined; pending = [];
            this.statusValue.gapSince = Date.now();
            if (this.stopped && !terminal && this.statusValue.state !== 'blocked') this.statusValue.state = 'stopped';
            else if (!terminal) {
                const delay = dingRetryDelay(info, this.statusValue.retries);
                if (delay === null || delay > 2147483647) this.statusValue.state = 'blocked';
                else {
                    this.statusValue.retries++;
                    this.statusValue.state = 'cooldown'; this.statusValue.nextRetryAt = Date.now() + delay;
                    this.timer = setTimeout(() => { this.timer = undefined; try { this.start(); } catch { fail(); } }, delay);
                    this.timer.unref();
                }
            }
            try { this.persist(); } catch { this.statusValue.state = 'blocked'; }
            resolve();
        }));
    }
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        this.child?.stdin.end();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.completion, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
        if (timer) clearTimeout(timer);
        if (this.child) { this.statusValue.state = 'stop-unconfirmed'; throw new Error('DWS graceful stop unconfirmed; do not start another consumer'); }
        if (!['blocked', 'cooldown'].includes(this.statusValue.state)) this.statusValue.state = 'stopped';
        this.persist();
    }
}

export function runDwsJson(args: string[], launch: DingSpawner = spawnDws): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = launch(args); } catch { reject(new Error('DWS unavailable')); return; }
        let output = '', size = 0, settled = false;
        const fail = () => { if (!settled) { settled = true; child.stdin.end(); reject(new Error('DWS command outcome unverified')); } };
        const timer = setTimeout(fail, 30000);
        const collect = (chunk: Buffer, stdout: boolean) => {
            size += chunk.length;
            if (size > 128000) { fail(); return; }
            if (stdout) output += chunk.toString('utf8');
        };
        child.stdout.on('data', chunk => collect(chunk, true));
        child.stderr.on('data', chunk => collect(chunk, false));
        child.on('error', fail);
        child.once('close', code => {
            clearTimeout(timer);
            if (settled) return;
            if (code !== 0) { fail(); return; }
            try {
                const parsed = JSON.parse(output) as Record<string, unknown>;
                if (!parsed || typeof parsed !== 'object' || parsed.error) throw new Error('Invalid result');
                settled = true; resolve(parsed);
            } catch { fail(); }
        });
    });
}
function payload(result: Record<string, unknown>): Record<string, unknown> {
    return result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : result;
}
export async function sendDingDraft(config: DingConfig, job: DingJob): Promise<string> {
    const target = job.target.startsWith('dm:') ? ['--open-dingtalk-id', job.target.slice(3)] : ['--group', job.target.slice(6)];
    const result = payload(await runDwsJson(['--profile', config.profile, 'chat', '+messages-send', '--as', 'user', ...target,
        '--text', job.reply || '', '--idempotency-key', job.id, '--yes', '--format', 'json']));
    if (typeof result.openTaskId !== 'string') throw new Error('No verified task receipt');
    return result.openTaskId;
}
export async function queryDingReceipt(config: DingConfig, receipt: string): Promise<'sent' | 'failed' | 'unknown'> {
    const result = payload(await runDwsJson(['--profile', config.profile, 'chat', 'message', 'query-send-status', '--open-task-id', receipt, '--format', 'json']));
    return result.sendStatus === 'SUCCESS' ? 'sent' : result.sendStatus === 'FAILED' ? 'failed' : 'unknown';
}