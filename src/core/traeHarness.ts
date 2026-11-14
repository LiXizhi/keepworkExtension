import { EventEmitter } from 'node:events';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessAdapter } from './codexHarness';
import { cacheValue } from './acpHarness';
import { CliLaunch, resolveAgentCli, stopCli } from './agentCliProcess';
import { cliProxyEnvironment } from './cliProxyEnvironment';

type Thread = { id: string; driver?: string; cwd: string; turns: any[]; model?: string; mode?: string };
type Run = { child: ChildProcessWithoutNullStreams; turn: any; directory: string; trajectory: string; poll: NodeJS.Timeout; timeout: NodeJS.Timeout; seen: Map<string, string>; bytes: number; stopping?: boolean; stopStatus?: string; stopError?: string };
const rejected = (message: string) => Object.assign(new Error(message), { rpcRejected: true });
const unsupported = (feature: string) => rejected(`UNSUPPORTED_FEATURE: Trae Agent does not support ${feature}. Use a supported harness for this operation.`);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const DRIVER = 'trae-agent-v1';
const MAX_TRAJECTORY = 32 * 1024 * 1024;

/** Open-source bytedance/trae-agent native tasks; never send ACP to trae-cli. */
export class TraeHarness extends EventEmitter implements HarnessAdapter {
    private threads = new Map<string, Thread>();
    private active = new Map<string, Run>();
    private launch?: CliLaunch;
    private closing = false;
    constructor(private directory: string, private executable?: string, private prefix: string[] = []) { super(); }
    cliInfo() { return this.launch && { path: this.launch.path, source: this.launch.source }; }
    private notify(method: string, thread: Thread, params: any) { this.emit('notification', { method, params: { threadId: thread.id, ...params } }); }
    private save(thread: Thread) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const target = path.join(this.directory, thread.id + '.json');
        fs.writeFileSync(target + '.tmp', JSON.stringify(cacheValue(thread)), { mode: 0o600 });
        fs.renameSync(target + '.tmp', target);
    }
    private thread(id: string): Thread {
        if (!validId(id)) throw rejected('Invalid Trae Agent session ID');
        const existing = this.threads.get(id); if (existing) return existing;
        const target = path.join(this.directory, id + '.json');
        if (fs.statSync(target).size > MAX_TRAJECTORY) throw rejected('Trae Agent history exceeds the local limit');
        const thread = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (thread.id !== id || !Array.isArray(thread.turns)) throw rejected('Invalid Trae Agent history');
        this.threads.set(id, thread); return thread;
    }
    private validate(p: any) {
        if (p.mcpServers?.length) throw unsupported('scoped AIChat MCP tools');
        if (p.mode && p.mode !== 'craft') throw unsupported('Ask/Plan read-only modes');
        if (p.sandbox === 'read-only' || p.sandboxPolicy?.type === 'readOnly') throw unsupported('read-only execution');
        if (p.effort) throw unsupported('reasoning effort selection');
    }
    private item(thread: Thread, run: Run, value: any) {
        if (this.active.get(thread.id) !== run) return;
        const item = cacheValue(value, { remaining: 131072 });
        const serialized = JSON.stringify(item);
        const previous = run.seen.get(item.id);
        if (previous === serialized) return;
        const bytes = run.bytes + serialized.length - (previous?.length || 0);
        // Reserve space for the final reply even when native tool output is large.
        if (bytes > (item.id === run.turn.id + ':reply' ? 2_000_000 : 1_800_000)) return;
        run.bytes = bytes;
        run.seen.set(item.id, serialized);
        const existing = run.turn.items.find((entry: any) => entry.id === item.id);
        if (existing) Object.assign(existing, item); else if (run.turn.items.length < 2000) run.turn.items.push(item); else return;
        this.notify('item/completed', thread, { item });
    }
    private trajectory(run: Run) {
        if (fs.lstatSync(run.trajectory).isSymbolicLink()) throw new Error('Invalid trajectory file');
        const fd = fs.openSync(run.trajectory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_TRAJECTORY) throw new Error('Trajectory size limit');
            // Bound the read even while upstream is rewriting/growing the file.
            const buffer = Buffer.allocUnsafe(stat.size + 1);
            let size = 0, read = 0;
            while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
            if (size > stat.size) throw new Error('Trajectory changed during read');
            return JSON.parse(buffer.toString('utf8', 0, size));
        } finally { fs.closeSync(fd); }
    }
    private project(thread: Thread, run: Run, data: any) {
        for (const step of (Array.isArray(data.agent_steps) ? data.agent_steps : []).slice(0, 1000)) {
            const index = step.step_number;
            if (!Number.isSafeInteger(index) || index < 0) continue;
            const id = `${run.turn.id}:step:${index}`;
            if (typeof step.llm_response?.content === 'string' && step.llm_response.content)
                this.item(thread, run, { id, type: 'agentMessage', text: step.llm_response.content });
            const results = Array.isArray(step.tool_results) ? step.tool_results : [];
            for (const [i, call] of (Array.isArray(step.tool_calls) ? step.tool_calls : []).slice(0, 100).entries()) {
                if (typeof call.name !== 'string') continue;
                const result = results.find((entry: any) => entry.call_id === call.call_id);
                this.item(thread, run, { id: `${id}:tool:${i}`, type: 'mcpToolCall', command: call.name,
                    arguments: call.arguments, ...(result ? { result: result.result, status: result.success === true ? 'completed' : 'failed' } : { status: 'inProgress' }) });
            }
        }
        if (typeof data.final_result === 'string' && data.final_result)
            this.item(thread, run, { id: run.turn.id + ':reply', type: 'agentMessage', text: data.final_result });
    }
    private finish(thread: Thread, run: Run, status: string, error?: string) {
        if (this.active.get(thread.id) !== run) return;
        clearInterval(run.poll); clearTimeout(run.timeout);
        this.active.delete(thread.id);
        run.turn.status = status;
        thread.turns = thread.turns.slice(-100);
        while (thread.turns.length > 1 && JSON.stringify(thread.turns).length > 2_000_000) thread.turns.shift();
        thread.turns = cacheValue(thread.turns);
        try { this.save(thread); } catch { status = 'failed'; error = 'Could not persist local Trae Agent history'; }
        this.notify('turn/completed', thread, { turn: { id: run.turn.id, status, ...(error ? { error: { message: error } } : {}) } });
    }
    private stop(thread: Thread, run: Run, status: string, error?: string) {
        if (run.stopping) return;
        run.stopping = true; run.stopStatus = status; run.stopError = error;
        clearInterval(run.poll); clearTimeout(run.timeout);
        stopCli(run.child);
        const force = setTimeout(() => {
            if (process.platform !== 'win32' && run.child.pid) { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { run.child.kill('SIGKILL'); } }
        }, 3000); force.unref();
        run.child.once('close', () => clearTimeout(force));
    }
    async call(method: string, p: any = {}): Promise<any> {
        if (this.closing) throw rejected('Trae Agent adapter is closed');
        if (method === 'account/read') {
            this.launch = resolveAgentCli('trae', [...this.prefix, '--help'], this.executable);
            return { authUnknown: true, probe: 'executable' };
        }
        if (method === 'model/list') return { data: [] };
        if (method === 'account/login/start') throw unsupported('CLI account login; configure trae_config.yaml or TRAE_CONFIG_FILE and provider API keys');
        if (['thread/list', 'thread/native/read'].includes(method)) throw unsupported('native session listing or resumption');
        if (method === 'thread/start') {
            this.validate(p);
            const thread: Thread = { id: randomUUID(), driver: DRIVER, cwd: p.cwd, turns: [], model: p.model };
            this.threads.set(thread.id, thread); this.save(thread); return { thread };
        }
        const thread = this.thread(p.threadId);
        if (method === 'thread/read') return { thread };
        if (method === 'thread/resume') { if (thread.driver === DRIVER) this.validate(p); return { thread }; }
        if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(method)) {
            const run = this.active.get(thread.id); if (method === 'thread/archive' && run) this.stop(thread, run, 'interrupted');
            return {};
        }
        if (thread.driver !== DRIVER) throw rejected('This is saved TraeCode ACP history. Start a new Trae Agent chat to run tasks; its history is preserved.');
        this.validate(p);
        if (method === 'thread/mode/set') {
            if (this.active.has(thread.id)) throw rejected('Trae Agent task already running');
            thread.mode = p.mode; thread.model = p.model || thread.model; return { nativePlan: false };
        }
        if (method === 'turn/interrupt') {
            const run = this.active.get(thread.id); if (run) this.stop(thread, run, 'interrupted'); return {};
        }
        if (method !== 'turn/start') throw unsupported('this harness operation');
        if (this.active.has(thread.id)) throw rejected('Trae Agent task already running');
        if (this.active.size >= 4) throw rejected('Trae Agent concurrent task limit reached');
        if (!Array.isArray(p.input) || !p.input.length || p.input.some((part: any) => part.type !== 'text' || typeof part.text !== 'string')) throw unsupported('non-text input');
        const prompt = p.input.map((part: any) => part.text).join('\n');
        if (!prompt.trim() || prompt.length > 400000) throw rejected('Trae Agent text limit exceeded');
        const runtime = path.join(this.directory, 'runtime'); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
        const directory = fs.mkdtempSync(path.join(runtime, 'task-')); fs.chmodSync(directory, 0o700);
        const input = path.join(directory, 'task.txt'), trajectory = path.join(directory, 'trajectory.json');
        fs.writeFileSync(input, prompt, { mode: 0o600 });
        // Credentials and MCP configuration remain upstream-owned; never show-config or copy them.
        let command: CliLaunch;
        try { command = resolveAgentCli('trae', [...this.prefix, 'run', '--file', input, '--working-dir', thread.cwd, '--trajectory-file', trajectory, '--console-type', 'simple', ...((p.model || thread.model) ? ['--model', p.model || thread.model] : [])], this.executable); }
        catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw rejected((error as Error).message); }
        this.launch = command;
        const child = spawn(command.executable, command.args, { cwd: thread.cwd, env: { ...cliProxyEnvironment(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, shell: false, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' });
        const turn = { id: randomUUID(), status: 'inProgress', items: [] as any[] };
        const run: Run = { child, turn, directory, trajectory, seen: new Map(), bytes: 0, poll: setInterval(() => {
            try { this.project(thread, run, this.trajectory(run)); } catch { /* Upstream writes non-atomically; reconcile only after exit. */ }
        }, 400), timeout: setTimeout(() => this.stop(thread, run, 'failed', 'Trae Agent task timed out; no task was replayed'), 30 * 60 * 1000) };
        this.active.set(thread.id, run); thread.turns.push(turn);
        child.stdin.on('error', () => {}); child.stdin.end();
        let outputBytes = 0;
        for (const output of [child.stdout, child.stderr]) output.on('data', (chunk: Buffer) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_TRAJECTORY) this.stop(thread, run, 'failed', 'Trae Agent output limit exceeded; no task was replayed');
        });
        child.on('error', () => this.finish(thread, run, 'failed', 'Trae Agent could not start. Check trae-cli installation and native configuration.'));
        child.on('close', code => {
            // A terminated parent may leave tool descendants that ignored TERM.
            if (run.stopping && process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already reaped */ } }
            if (this.active.get(thread.id) === run) {
                if (run.stopping) this.finish(thread, run, run.stopStatus || 'interrupted', run.stopError);
                else {
                    let success = false;
                    try { const data = this.trajectory(run); this.project(thread, run, data); success = code === 0 && data.success === true && typeof data.end_time === 'string' && !!data.end_time; } catch { /* Missing or unfinished trajectory never means success. */ }
                    this.finish(thread, run, success ? 'completed' : 'failed', success ? undefined : 'Trae Agent did not confirm task success. Check native configuration and trajectory; no task was replayed.');
                }
            }
            fs.rmSync(directory, { recursive: true, force: true });
        });
        this.notify('turn/started', thread, { turn: { id: turn.id } });
        this.item(thread, run, { id: turn.id + ':user', type: 'userMessage', content: p.input });
        this.item(thread, run, { id: turn.id + ':mode', type: 'agentMessage', text: 'Trae Agent starts an independent native task for each turn; native conversation state is not resumed.' });
        try { this.save(thread); } catch { this.stop(thread, run, 'failed', 'Could not persist local Trae Agent history'); }
        return { turn: { id: turn.id } };
    }
    respond() { throw unsupported('interactive approval responses'); }
    close() {
        this.closing = true;
        for (const [id, run] of this.active) this.stop(this.thread(id), run, 'interrupted');
    }
}
