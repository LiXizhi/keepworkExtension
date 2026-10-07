import { EventEmitter } from 'node:events';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessAdapter } from './codexHarness';
import { cacheValue } from './acpHarness';
import { CliLaunch, resolveAgentCli, stopCli } from './agentCliProcess';
import { unsupportedModeMethod } from './agentModes';

type Thread = { id: string; cwd: string; roots: string[]; turns: any[]; native: boolean; planMode?: boolean; model?: string; mcpServers?: any[]; aichatInstructions?: string };
type Run = { id: string; items: any[]; cancelled?: boolean; messageId?: string; timer: NodeJS.Timeout };
type Connection = { child: ChildProcessWithoutNullStreams; ready: Promise<any>; pending: Map<string, any>; run?: Run; permissions: Map<string, any>; models: any[] };
const rejected = (message: string) => Object.assign(new Error(message), { rpcRejected: true });

/** Claude's native bidirectional stream-json control protocol, without shell or SDK dependency. */
export class ClaudeHarness extends EventEmitter implements HarnessAdapter {
    private threads = new Map<string, Thread>();
    private connections = new Map<string, Connection>();
    private launch?: CliLaunch;
    constructor(private directory: string, private executable?: string, private prefix: string[] = []) { super(); }
    cliInfo() { return this.launch && { path: this.launch.path, source: this.launch.source }; }
    private notify(method: string, threadId: string, params: any) { this.emit('notification', { method, params: { threadId, ...params } }); }
    private save(thread: Thread) {
        fs.mkdirSync(this.directory, { recursive: true });
        const target = path.join(this.directory, thread.id + '.json');
        const { mcpServers, aichatInstructions, ...saved } = thread;
        fs.writeFileSync(target + '.tmp', JSON.stringify(cacheValue(saved)), { mode: 0o600 }); fs.renameSync(target + '.tmp', target);
    }
    private thread(id: string): Thread {
        if (!/^[\w-]{1,160}$/.test(id)) throw rejected('Invalid Claude session ID');
        let thread = this.threads.get(id);
        if (!thread) { thread = JSON.parse(fs.readFileSync(path.join(this.directory, id + '.json'), 'utf8')); this.threads.set(id, thread!); }
        return thread!;
    }
    private write(c: Connection, value: any) {
        if (!c.child.stdin.writable) throw new Error('Claude input disconnected; reconcile before retrying');
        c.child.stdin.write(JSON.stringify(value) + '\n');
    }
    private control(c: Connection, request: any): Promise<any> {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { c.pending.delete(id); reject(new Error(`Claude ${request.subtype} timed out; do not resubmit automatically`)); }, 60000);
            c.pending.set(id, { resolve, reject, timer });
            try { this.write(c, { type: 'control_request', request_id: id, request }); }
            catch (e) { c.pending.delete(id); clearTimeout(timer); reject(e); }
        });
    }
    private boot(thread: Thread): Promise<any> {
        const existing = this.connections.get(thread.id); if (existing) return existing.ready;
        if (this.connections.size >= 16) {
            const idle = [...this.connections].find(([, c]) => !c.run && !c.pending.size);
            if (!idle) throw rejected('Claude concurrent session limit reached; finish or interrupt an active session');
            this.connections.delete(idle[0]); stopCli(idle[1].child);
        }
        const args = [...this.prefix, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-prompt-tool', 'stdio', `${thread.native ? '--resume' : '--session-id'}=${thread.id}`,
            ...thread.roots.slice(1).flatMap(root => ['--add-dir', root]), ...(thread.model ? ['--model', thread.model] : [])];
        const environment = { ...process.env };
        if (thread.mcpServers?.length) {
            const servers = Object.fromEntries(thread.mcpServers.map(server => [server.name, { command: server.command, args: server.args, env: Object.fromEntries(server.env.map((entry: any) => {
                environment[entry.name] = entry.value;
                return [entry.name, '${' + entry.name + '}'];
            })) }]));
            args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
        }
        if (thread.aichatInstructions) args.push('--append-system-prompt', thread.aichatInstructions);
        const command = resolveAgentCli('claude', args, this.executable); this.launch = command;
        const child = spawn(command.executable, command.args, { cwd: thread.cwd, env: environment, shell: false, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' });
        const c: Connection = { child, ready: Promise.resolve(), pending: new Map(), permissions: new Map(), models: [] };
        this.connections.set(thread.id, c);
        const fail = (error: Error) => {
            if (this.connections.get(thread.id) !== c) return;
            this.connections.delete(thread.id);
            for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(error); } c.pending.clear();
            if (c.run) this.finish(thread, c, c.run.cancelled ? 'interrupted' : 'failed', error.message);
            stopCli(child);
        };
        let buffer = '';
        child.stdout.setEncoding('utf8'); child.stderr.resume();
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk; if (buffer.length > 8_000_000) { fail(new Error('Claude output limit exceeded')); return; }
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
                try { this.message(thread, c, JSON.parse(line)); } catch { fail(new Error('Invalid Claude protocol output')); return; }
            }
        });
        child.on('error', () => fail(new Error('Claude CLI unavailable; check its installation and discovered path')));
        child.on('exit', code => fail(new Error(`Claude process stopped (${code}); prompts were not rerun`)));
        child.stdin.on('error', () => fail(new Error('Claude input stream disconnected')));
        c.ready = this.control(c, { subtype: 'initialize', hooks: {} }).then(result => {
            c.models = result.models || [];
            if (Array.isArray(result.models)) this.notify('model/updated', thread.id, {});
            return result;
        });
        void c.ready.catch(error => fail(error)); return c.ready;
    }
    private item(thread: Thread, c: Connection, value: any) {
        const run = c.run; if (!run) return;
        const existing = run.items.find(i => i.id === value.id);
        if (existing) Object.assign(existing, cacheValue(value)); else { run.items.push(cacheValue(value)); run.items = run.items.slice(-2000); }
        this.notify('item/completed', thread.id, { item: existing || run.items.at(-1) });
    }
    private block(thread: Thread, c: Connection, block: any, index: number, messageId: string) {
        const id = block.type === 'tool_use' ? block.id : `${messageId}:${index}`;
        if (block.type === 'text' || block.type === 'thinking') this.item(thread, c, { id, type: block.type === 'text' ? 'agentMessage' : 'reasoning', text: block.text || block.thinking || '' });
        if (block.type === 'tool_use') this.item(thread, c, { id, type: 'mcpToolCall', command: block.name, arguments: block.input || {}, status: 'inProgress' });
        if (block.type === 'tool_result') this.item(thread, c, { id: block.tool_use_id, type: 'mcpToolCall', result: block.content, status: block.is_error ? 'failed' : 'completed' });
    }
    private message(thread: Thread, c: Connection, m: any) {
        if (m.type === 'control_response') {
            const r = m.response, p = c.pending.get(r?.request_id); if (!p) return;
            c.pending.delete(r.request_id); clearTimeout(p.timer);
            if (r.subtype === 'error') p.reject(rejected(r.error || 'Claude rejected control request')); else p.resolve(r.response || {});
            return;
        }
        if (m.type === 'control_cancel_request') {
            c.permissions.delete(m.request_id); this.notify('serverRequest/resolved', thread.id, { requestId: m.request_id }); return;
        }
        if (m.type === 'control_request') {
            if (m.request?.subtype === 'can_use_tool' && c.run) {
                c.permissions.set(m.request_id, m.request);
                const questions = m.request.tool_name === 'AskUserQuestion' ? (m.request.input?.questions || []).map((q: any, i: number) => ({ ...q, id: String(i) })) : undefined;
                this.emit('request', { id: m.request_id, method: questions ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: { threadId: thread.id, readOnly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(m.request.tool_name), requiresUserDecision: m.request.tool_name === 'ExitPlanMode', command: `${m.request.tool_name}\n${JSON.stringify(cacheValue(m.request.input))}`, ...(questions ? { questions } : {}) } });
            } else this.write(c, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Client control method unsupported' } });
            return;
        }
        if (m.type === 'system' && m.subtype === 'init' && m.session_id && m.session_id !== thread.id) throw new Error('Claude session identity mismatch');
        const run = c.run;
        if (!run && m.type === 'result' && (m.is_error || m.subtype !== 'success')) {
            for (const pending of c.pending.values()) { clearTimeout(pending.timer); pending.reject(rejected(String(m.errors?.join('; ') || m.result || 'Claude startup failed'))); }
            c.pending.clear();
        }
        if (!run) return;
        if (m.type === 'stream_event') {
            const event = m.event;
            if (event?.type === 'message_start') run.messageId = event.message?.id || randomUUID();
            if (event?.type === 'content_block_start') this.block(thread, c, event.content_block, event.index, run.messageId || run.id);
            if (event?.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta?.type)) {
                const id = `${run.messageId || run.id}:${event.index}`, item = run.items.find(i => i.id === id);
                this.item(thread, c, { id, type: event.delta.type === 'text_delta' ? 'agentMessage' : 'reasoning', text: ((item?.text || '') + (event.delta.text || event.delta.thinking || '')).slice(-131072) });
            }
        }
        if (m.type === 'assistant' || m.type === 'user') {
            for (const [index, block] of (Array.isArray(m.message?.content) ? m.message.content : []).entries()) if (m.type === 'assistant' || block.type === 'tool_result') this.block(thread, c, block, index, m.message?.id || m.uuid || run.id);
        }
        if (m.type === 'result') {
            if (!run.items.some(i => i.type === 'agentMessage') && typeof m.result === 'string') this.item(thread, c, { id: randomUUID(), type: 'agentMessage', text: m.result });
            const error = m.is_error || m.subtype !== 'success' || m.permission_denials?.length;
            this.finish(thread, c, run.cancelled ? 'interrupted' : error ? 'failed' : 'completed', error ? String(m.errors?.join('; ') || m.result || 'Tool permission denied or Claude turn failed').slice(0, 10000) : undefined);
        }
    }
    private finish(thread: Thread, c: Connection, status: string, error?: string) {
        const run = c.run; if (!run) return; clearTimeout(run.timer); c.run = undefined;
        for (const id of c.permissions.keys()) this.notify('serverRequest/resolved', thread.id, { requestId: id }); c.permissions.clear();
        thread.turns.push({ id: run.id, status, items: run.items }); thread.turns = thread.turns.slice(-100);
        while (thread.turns.length > 1 && JSON.stringify(thread.turns).length > 2_000_000) thread.turns.shift();
        try { this.save(thread); } catch { status = 'failed'; error = 'Could not persist local Claude history'; }
        this.notify('turn/completed', thread.id, { turn: { id: run.id, status, ...(error ? { error: { message: error } } : {}) } });
    }
    async call(method: string, p: any = {}): Promise<any> {
        if (method === 'account/read') {
            const command = resolveAgentCli('claude', [...this.prefix, '--version'], this.executable); this.launch = command;
            await promisify(execFile)(command.executable, command.args, { timeout: 10000, maxBuffer: 65536, windowsHide: true });
            return { account: null, authUnknown: true, probe: 'executable' };
        }
        if (method === 'model/list') return { data: [...this.connections.values()].flatMap(c => c.models.map(m => ({ id: m.value || m.id, displayName: m.displayName || m.name || m.value }))).filter(m => m.id) };
        if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(method)) {
            const c = this.connections.get(p.threadId);
            if (method === 'thread/archive' && c && !c.run) { this.connections.delete(p.threadId); stopCli(c.child); }
            return {};
        }
        if (method === 'thread/start') {
            const thread: Thread = { id: randomUUID(), cwd: p.cwd, roots: p.roots || [p.cwd], turns: [], native: false, model: p.model, mcpServers: p.mcpServers, aichatInstructions: p.aichatInstructions };
            this.threads.set(thread.id, thread); await this.boot(thread); this.save(thread); return { thread };
        }
        const thread = this.thread(p.threadId);
        if (method === 'thread/read') return { thread };
        if (p.mcpServers) thread.mcpServers = p.mcpServers;
        if (p.aichatInstructions) thread.aichatInstructions = p.aichatInstructions;
        await this.boot(thread); const c = this.connections.get(thread.id)!;
        if (method === 'thread/mode/set') {
            try { await this.control(c, { subtype: 'set_permission_mode', mode: p.mode === 'plan' ? 'plan' : 'default' }); }
            catch (error) {
                if (!thread.planMode && unsupportedModeMethod(error)) return { nativePlan: false };
                throw error;
            }
            thread.planMode = p.mode === 'plan'; this.save(thread);
            return { nativePlan: p.mode === 'plan' };
        }
        if (method === 'thread/resume') return { thread };
        if (method === 'turn/interrupt') { if (c.run) c.run.cancelled = true; await this.control(c, { subtype: 'interrupt' }); return {}; }
        if (method !== 'turn/start') throw rejected('Unsupported Claude harness method');
        if (c.run) throw rejected('Claude session already running');
        if (p.effort) throw rejected('Per-turn Claude effort changes are unsupported; use native CLI settings');
        if (p.model) { await this.control(c, { subtype: 'set_model', model: p.model }); thread.model = p.model; }
        thread.native = true; this.save(thread);
        const run: Run = { id: randomUUID(), items: [], timer: setTimeout(() => { this.finish(thread, c, 'failed', 'Claude turn timed out; not rerun'); this.connections.delete(thread.id); stopCli(c.child); }, 30 * 60 * 1000) }; c.run = run;
        this.notify('turn/started', thread.id, { turn: { id: run.id } });
        this.item(thread, c, { id: randomUUID(), type: 'userMessage', content: p.input });
        this.write(c, { type: 'user', session_id: thread.id, message: { role: 'user', content: p.input }, parent_tool_use_id: null });
        return { turn: { id: run.id } };
    }
    respond(id: string | number, result: any) {
        for (const c of this.connections.values()) {
            const request = c.permissions.get(String(id)); if (!request) continue;
            let input = request.input;
            if (request.tool_name === 'AskUserQuestion' && result.answers) input = { ...input, answers: Object.fromEntries((input.questions || []).map((q: any, i: number) => [q.question, result.answers[String(i)]?.answers?.[0] || ''])) };
            const allow = !!result.answers || ['accept', 'acceptForSession'].includes(result.decision);
            this.write(c, { type: 'control_response', response: { subtype: 'success', request_id: String(id), response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'User declined permission' } } });
            c.permissions.delete(String(id)); return;
        }
        throw rejected('Claude request expired');
    }
    close() {
        for (const [id, c] of this.connections) {
            if (c.run) this.finish(this.thread(id), c, 'interrupted', 'Claude connection closed');
            for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Claude closed')); }
            c.pending.clear(); stopCli(c.child);
        }
        this.connections.clear();
    }
}
