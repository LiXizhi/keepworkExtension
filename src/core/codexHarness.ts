import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveAgentCli, CliLaunch } from './agentCliProcess';

export interface HarnessAdapter {
    call(method: string, params?: unknown): Promise<any>;
    respond(id: string | number, result: unknown): void;
    on(event: string, listener: (...args: any[]) => void): this;
    close(): void;
    cliInfo?(): { path: string; source: string } | undefined;
    refreshCapabilities?(): void;
}

/** Codex owns credentials and tools; this transport never prints protocol payloads. */
export class CodexHarness extends EventEmitter implements HarnessAdapter {
    private child?: ChildProcessWithoutNullStreams;
    private ready?: Promise<void>;
    private nextId = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private launch?: CliLaunch;
    cliInfo() { return this.launch && { path: this.launch.path, source: this.launch.source }; }
    constructor(private executable?: string, private args = ['app-server', '--stdio']) { super(); }

    private start(): Promise<void> {
        if (this.ready) return this.ready;
        this.ready = new Promise<void>((resolve, reject) => {
            let command: CliLaunch;
            try { command = resolveAgentCli('codex', this.args, this.executable); this.launch = command; } catch (e) { reject(e); return; }
            const child = spawn(command.executable, command.args, { windowsHide: true, stdio: 'pipe', shell: false, detached: process.platform !== 'win32' });
            this.child = child;
            let buffer = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                buffer += chunk;
                if (buffer.length > 8_000_000) { child.kill(); return; }
                let end: number;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                    if (!line.trim()) continue;
                    try {
                        const message = JSON.parse(line);
                        if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
                        else {
                            const request = this.pending.get(message.id);
                            if (!request) continue;
                            this.pending.delete(message.id); clearTimeout(request.timer);
                            if (message.error) request.reject(Object.assign(new Error(message.error.message || 'Codex request failed'), { rpcRejected: true }));
                            else request.resolve(message.result);
                        }
                    } catch { child.kill(); }
                }
            });
            // Drain diagnostics without logging potentially sensitive provider output.
            child.stderr.resume();
            const fail = (error: Error) => {
                if (this.child !== child) return;
                this.child = undefined; this.ready = undefined;
                for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
                this.pending.clear(); reject(error); this.emit('exit', error.message);
            };
            child.on('error', () => fail(new Error('Codex unavailable. Install Codex or configure KEEPWORK_CODEX_PATH, then restart Keepwork MCP.')));
            child.stdin.on('error', () => fail(new Error('Codex input stream disconnected; check session state before retrying.')));
            child.on('exit', () => fail(new Error('Codex process stopped; interrupted prompts were not rerun.')));
            child.on('spawn', () => {
                void this.rpc('initialize', { clientInfo: { name: 'keepwork_aichat', title: 'AIChat', version: '1.0.0' } }).then(result => {
                    if (typeof result?.userAgent !== 'string') { reject(new Error('Incompatible Codex App Server handshake. Update Codex and reconnect.')); child.kill(); return; }
                    this.write({ method: 'initialized' }); resolve();
                }, error => { reject(error); child.kill(); });
            });
        });
        const ready = this.ready;
        void ready.catch(() => { if (this.ready === ready) this.ready = undefined; });
        return ready;
    }
    private write(message: unknown) {
        if (!this.child?.stdin.writable) throw new Error('Codex is disconnected');
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }
    private rpc(method: string, params?: unknown): Promise<any> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; check session state before retrying.`)); }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            try { this.write({ id, method, params: params || {} }); }
            catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
        });
    }
    async call(method: string, params?: unknown) { await this.start(); return this.rpc(method, params); }
    respond(id: string | number, result: unknown) { this.write({ id, result }); }
    close() {
        const child = this.child;
        if (!child?.pid) return;
        if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
            killer.on('error', () => child.kill());
        } else {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
        }
    }
}
