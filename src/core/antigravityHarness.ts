import { EventEmitter } from 'node:events';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessAdapter } from './codexHarness';
import { cacheValue } from './acpHarness';
import { CliLaunch, resolveAgentCli, stopCli } from './agentCliProcess';
import { cliProxyEnvironment } from './cliProxyEnvironment';

type Thread = { id: string; driver: string; cwd: string; roots: string[]; turns: any[]; nativeId?: string; model?: string; effort?: string; mode?: string; mcpServers?: any[] };
type Run = { id: string; items: any[]; timer: NodeJS.Timeout };
type Connection = { child: ChildProcessWithoutNullStreams; ready: Promise<void>; run?: Run; fingerprint: string };
const rejected = (message: string) => Object.assign(new Error(message), { rpcRejected: true });
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);

/** Native agy NDJSON, not ACP or Claude's incompatible control protocol. */
export class AntigravityHarness extends EventEmitter implements HarnessAdapter {
    private threads = new Map<string, Thread>();
    private connections = new Map<string, Connection>();
    private launch?: CliLaunch;
    private modelCache?: any;
    private modelFlight?: Promise<any>;
    private modelEpoch = 0;
    constructor(private directory: string, private executable?: string, private prefix: string[] = []) { super(); }
    cliInfo() { return this.launch && { path: this.launch.path, source: this.launch.source }; }
    private notify(method: string, thread: Thread, params: any) { this.emit('notification', { method, params: { threadId: thread.id, ...params } }); }
    private save(thread: Thread) {
        fs.mkdirSync(this.directory, { recursive: true });
        const target = path.join(this.directory, thread.id + '.json');
        const { mcpServers, ...saved } = thread;
        fs.writeFileSync(target + '.tmp', JSON.stringify(cacheValue(saved)), { mode: 0o600 });
        fs.renameSync(target + '.tmp', target);
    }
    private thread(id: string): Thread {
        if (!validId(id)) throw rejected('Invalid Antigravity session ID');
        let thread = this.threads.get(id);
        if (!thread) { thread = JSON.parse(fs.readFileSync(path.join(this.directory, id + '.json'), 'utf8')); this.threads.set(id, thread!); }
        return thread!;
    }
    refreshCapabilities() { this.modelEpoch++; this.modelCache = undefined; this.modelFlight = undefined; }
    private models(): Promise<any> {
        if (this.modelCache) return Promise.resolve(cacheValue(this.modelCache));
        if (this.modelFlight) return this.modelFlight.then(result => cacheValue(result));
        const epoch = this.modelEpoch;
        const task = this.readModels().then(result => { if (epoch === this.modelEpoch) this.modelCache = result; return cacheValue(result); });
        this.modelFlight = task;
        void task.finally(() => { if (this.modelFlight === task) this.modelFlight = undefined; }).catch(() => {});
        return task;
    }
    private async readModels() {
        const command = resolveAgentCli('gemini', [...this.prefix, 'models'], this.executable); this.launch = command;
        const { stdout } = await promisify(execFile)(command.executable, command.args, { env: cliProxyEnvironment(), windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
        const data = stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
            const match = /^([\w][\w./:-]*)\t+(.+)$/.exec(line.trim());
            return match ? [{ id: match[1], displayName: match[2], supportedReasoningEfforts: [] }] : [];
        });
        if (!data.length) throw rejected('Antigravity returned no models. Run agy to sign in, then reconnect.');
        return { data };
    }
    private stop(thread: Thread) {
        const c = this.connections.get(thread.id); if (!c) return;
        this.connections.delete(thread.id); stopCli(c.child);
    }
    private boot(thread: Thread): Promise<void> {
        const fingerprint = JSON.stringify([thread.model, thread.effort, thread.mode, thread.mcpServers]);
        const previous = this.connections.get(thread.id);
        if (previous?.fingerprint === fingerprint) return previous.ready;
        if (previous?.run) throw rejected('Antigravity session already running');
        this.stop(thread);
        if (this.connections.size >= 16) {
            const idle = [...this.connections.keys()].find(id => !this.connections.get(id)?.run);
            if (!idle) throw rejected('Antigravity concurrent session limit reached');
            this.stop(this.thread(idle));
        }
        const env = cliProxyEnvironment();
        let cwd = thread.cwd;
        // agy exposes workspace MCP configuration, but no per-process --mcp-config.
        // Keep scoped descriptors in an owned launch directory, never in the user's
        // project/global config. Credentials are inherited only in child memory.
        if (thread.mcpServers?.length) {
            cwd = path.join(this.directory, 'runtime', thread.id);
            const configDir = path.join(cwd, '.agents'); fs.mkdirSync(configDir, { recursive: true });
            const mcpServers = Object.fromEntries(thread.mcpServers.map(server => {
                for (const entry of server.env || []) env[entry.name] = entry.value;
                return [server.name, { command: server.command, args: server.args }];
            }));
            fs.writeFileSync(path.join(configDir, 'mcp_config.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        const args = [...this.prefix, '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
            ...(thread.nativeId ? ['--conversation', thread.nativeId] : []),
            ...thread.roots.filter(root => root !== cwd).flatMap(root => ['--add-dir', root]),
            ...(thread.model ? ['--model', thread.model] : []), ...(thread.effort ? ['--effort', thread.effort] : []),
            ...(['ask', 'plan'].includes(thread.mode || '') ? ['--mode', 'plan'] : [])];
        const command = resolveAgentCli('gemini', args, this.executable); this.launch = command;
        const child = spawn(command.executable, command.args, { cwd, env, shell: false, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' });
        let resolveReady!: () => void, rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const c: Connection = { child, ready, fingerprint }; this.connections.set(thread.id, c);
        const startupTimer = setTimeout(() => fail(new Error('Antigravity startup timed out; no prompt was replayed')), 60000);
        let buffer = '';
        const fail = (error: Error) => {
            clearTimeout(startupTimer); rejectReady(error);
            if (this.connections.get(thread.id) !== c) return;
            if (c.run) this.finish(thread, c, 'failed', error.message);
            this.stop(thread);
        };
        child.stdout.setEncoding('utf8'); child.stderr.resume();
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 8_000_000) { fail(new Error('Antigravity output limit exceeded')); return; }
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
                try {
                    const m = JSON.parse(line);
                    if (m.event === 'init') {
                        if (!validId(m.conversation_id) || (thread.nativeId && thread.nativeId !== m.conversation_id)) throw new Error('Antigravity session identity mismatch');
                        thread.nativeId = m.conversation_id; this.save(thread); clearTimeout(startupTimer); resolveReady();
                    } else if (!c.run && m.event === 'result' && m.result?.status !== 'SUCCESS') {
                        fail(rejected(String(m.result?.error || 'Antigravity authentication failed. Run agy to sign in.').slice(0, 10000)));
                    } else this.message(thread, c, m);
                } catch (error) { fail(error instanceof Error ? error : new Error('Invalid Antigravity protocol output')); return; }
            }
        });
        child.on('error', () => fail(rejected('Antigravity CLI unavailable; install agy and reconnect')));
        child.on('exit', code => fail(new Error(`Antigravity process stopped (${code}); prompts were not rerun. Run agy to check login.`)));
        child.stdin.on('error', () => fail(new Error('Antigravity input disconnected; reconcile before retrying')));
        void ready.catch(() => {}); return ready;
    }
    private item(thread: Thread, c: Connection, value: any) {
        if (!c.run) return;
        const existing = c.run.items.find(item => item.id === value.id);
        if (existing) Object.assign(existing, cacheValue(value)); else c.run.items.push(cacheValue(value));
        c.run.items = c.run.items.slice(-2000);
        this.notify('item/completed', thread, { item: existing || c.run.items.at(-1) });
    }
    private message(thread: Thread, c: Connection, m: any) {
        const run = c.run; if (!run) return;
        if (m.event === 'step_update') {
            const step = m.step_update;
            if (step?.conversation_id !== thread.nativeId) throw new Error('Antigravity step identity mismatch');
            const id = `${run.id}:${step.step_index}`;
            if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
                const previous = run.items.find(item => item.id === id)?.text || '';
                this.item(thread, c, { id, type: 'agentMessage', text: (previous + step.text_delta).slice(-131072) });
            }
            if (step.step_type === 'tool') this.item(thread, c, { id, type: 'mcpToolCall', command: step.tool_name || step.tool_info?.name,
                arguments: step.tool_info?.parameters, result: step.tool_info?.output, status: step.tool_info?.error ? 'failed' : step.state === 'DONE' ? 'completed' : 'inProgress' });
        }
        if (m.event === 'result') {
            const result = m.result;
            if (result?.conversation_id !== thread.nativeId) throw new Error('Antigravity result identity mismatch');
            if (!run.items.some(item => item.type === 'agentMessage') && result.response) this.item(thread, c, { id: run.id + ':reply', type: 'agentMessage', text: result.response });
            // agy may exit successfully after soft-denying a tool. Do not present
            // an empty reply or a blocked MCP action as successful completion.
            const denied = Array.isArray(result.denied_actions) && result.denied_actions.length > 0;
            const error = denied ? 'Antigravity denied a tool under its native permissions. Open agy and use /permissions to allow the intended tool, then retry explicitly.' : result.status === 'SUCCESS' ? undefined : String(result.error || result.status).slice(0, 10000);
            this.finish(thread, c, denied ? 'failed' : result.status === 'SUCCESS' ? 'completed' : ['CANCELED', 'INTERRUPTED'].includes(result.status) ? 'interrupted' : 'failed', error);
        }
    }
    private finish(thread: Thread, c: Connection, status: string, error?: string) {
        const run = c.run; if (!run) return;
        clearTimeout(run.timer); c.run = undefined;
        thread.turns.push({ id: run.id, status, items: run.items }); thread.turns = thread.turns.slice(-100);
        while (thread.turns.length > 1 && JSON.stringify(thread.turns).length > 2_000_000) thread.turns.shift();
        try { this.save(thread); } catch { status = 'failed'; error = 'Could not persist local Antigravity history'; }
        this.notify('turn/completed', thread, { turn: { id: run.id, status, ...(error ? { error: { message: error } } : {}) } });
    }
    async call(method: string, p: any = {}): Promise<any> {
        if (method === 'account/read') { await this.models(); return { account: { type: 'cli' } }; }
        if (method === 'model/list') return this.models();
        if (method === 'account/login/start') throw rejected('Run agy in the login terminal, then reconnect.');
        if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(method)) {
            if (method === 'thread/archive') { const thread = this.threads.get(p.threadId); if (thread) this.stop(thread); }
            return {};
        }
        if (method === 'thread/start') {
            const thread: Thread = { id: randomUUID(), driver: 'antigravity-v1', cwd: p.cwd, roots: p.roots || [p.cwd], turns: [], model: p.model, mcpServers: p.mcpServers };
            this.threads.set(thread.id, thread); this.save(thread); return { thread };
        }
        const thread = this.thread(p.threadId);
        if (method === 'thread/read' || (method === 'thread/resume' && thread.driver !== 'antigravity-v1')) return { thread };
        if (thread.driver !== 'antigravity-v1') throw rejected('This is a saved Gemini CLI conversation. Its history is preserved; start a new Antigravity chat to continue.');
        if (p.mcpServers) thread.mcpServers = p.mcpServers;
        if (method === 'thread/resume') return { thread };
        if (method === 'thread/mode/set') {
            if (this.connections.get(thread.id)?.run) throw rejected('Antigravity session already running');
            thread.mode = p.mode; thread.model = p.model || thread.model; thread.effort = p.effort;
            return { nativePlan: ['ask', 'plan'].includes(p.mode) };
        }
        if (method === 'turn/interrupt') {
            const c = this.connections.get(thread.id);
            if (c?.run) this.finish(thread, c, 'interrupted'); this.stop(thread); return {};
        }
        if (method !== 'turn/start') throw rejected('Unsupported Antigravity harness method');
        if (this.connections.get(thread.id)?.run) throw rejected('Antigravity session already running');
        if (!Array.isArray(p.input) || p.input.some((part: any) => part.type !== 'text')) throw rejected('Antigravity supports text input only');
        thread.model = p.model || thread.model; thread.effort = p.effort || thread.effort;
        if (thread.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(thread.effort)) throw rejected('Unsupported Antigravity effort');
        // Startup has not submitted the prompt yet; a failure is safe to surface as rejected.
        try { await this.boot(thread); } catch (error) { throw rejected((error as Error).message); }
        const c = this.connections.get(thread.id)!;
        const run: Run = { id: randomUUID(), items: [], timer: setTimeout(() => { this.finish(thread, c, 'failed', 'Antigravity turn timed out; not rerun'); this.stop(thread); }, 30 * 60 * 1000) }; c.run = run;
        this.notify('turn/started', thread, { turn: { id: run.id } });
        this.item(thread, c, { id: run.id + ':user', type: 'userMessage', content: p.input });
        const context = thread.mcpServers?.length ? `Primary workspace: ${thread.cwd}\nAdditional roots: ${thread.roots.slice(1).join(', ')}\nThe launch directory is host-owned; work in the primary workspace.\n\n` : '';
        c.child.stdin.write(JSON.stringify({ event: 'user', message: { content: context + p.input.map((part: any) => part.text).join('\n') } }) + '\n');
        return { turn: { id: run.id } };
    }
    respond() { throw rejected('Antigravity headless mode does not support interactive permission responses; use its native permissions settings.'); }
    close() {
        this.refreshCapabilities();
        for (const [id, c] of this.connections) { const thread = this.thread(id); if (c.run) this.finish(thread, c, 'interrupted'); this.stop(thread); }
    }
}
