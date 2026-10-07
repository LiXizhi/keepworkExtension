import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessAdapter } from './codexHarness';
import { resolveAgentCli, CliLaunch, stopCli } from './agentCliProcess';
import { AcpBackend, AGENT_CLI } from './agentCliBackends';

type Thread = { id: string; cwd: string; turns: any[]; models?: any; modes?: any; normalMode?: string; configOptions?: any[]; loaded?: boolean; mcpServers?: any[] };
export function cacheValue(value: any, budget = { remaining: 2_000_000 }, depth = 0): any {
    if (budget.remaining <= 0 || depth > 24) return '';
    budget.remaining -= 16;
    if (typeof value === 'string') { const text = value.slice(0, Math.max(0, Math.min(131072, budget.remaining))); budget.remaining -= text.length; return text; }
    if (Array.isArray(value)) {
        const result: any[] = [];
        for (const item of value.slice(0, 2000)) { if (budget.remaining <= 0) break; result.push(cacheValue(item, budget, depth + 1)); }
        return result;
    }
    if (value && typeof value === 'object') {
        const result: any = {};
        for (const [key, item] of Object.entries(value).slice(0, 2000)) {
            if (budget.remaining <= 0) break;
            if (/token|password|secret|authorization|cookie/i.test(key)) continue;
            budget.remaining -= key.length; result[key] = cacheValue(item, budget, depth + 1);
        }
        return result;
    }
    return value;
}

/** ACP stays private to the daemon. Browser snapshots use the existing normalized contract. */
export class AcpHarness extends EventEmitter implements HarnessAdapter {
    private scoped = new Map<string, AcpHarness>();
    private scopedRequests = new Map<string, { child: AcpHarness; id: string | number }>();
    private child?: ChildProcessWithoutNullStreams;
    private ready?: Promise<any>;
    private nextId = 0;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private permissions = new Map<string | number, any>();
    private threads = new Map<string, Thread>();
    private active = new Map<string, { id: string; items: any[]; textItem?: any; thoughtItem?: any; cancelled?: boolean }>();
    private capabilities: any = {};
    private launch?: CliLaunch;
    private catalogs = new Map<string, { cwd: string; thread: Thread }>();
    private catalogTasks = new Map<string, Promise<Thread>>();
    private modelCatalog = new Map<string, any[]>();
    private modelFlights = new Map<string, Promise<{ data: any[] }>>();
    private catalogEpoch = 0;
    private launchEpoch = 0;
    cliInfo() { return this.launch && { path: this.launch.path, source: this.launch.source }; }
    constructor(readonly backend: AcpBackend, private directory: string,
        private executable?: string,
        private args = AGENT_CLI[backend].args,
        private prepareEnvironment?: () => Promise<NodeJS.ProcessEnv>,
        private launchMcp?: any[], private launchCwd?: string) { super(); }

    private start(): Promise<any> {
        if (this.ready) return this.ready;
        const epoch = this.launchEpoch;
        this.ready = (async () => {
        const env = { ...process.env, ...await this.prepareEnvironment?.() };
        let launchArgs = this.args;
        if (this.launchMcp?.length) {
            const mcpServers = Object.fromEntries(this.launchMcp.map(server => [server.name, {
                type: 'stdio', command: server.command, args: server.args, tools: ['*'],
                env: Object.fromEntries(server.env.map((entry: any) => { env[entry.name] = entry.value; return [entry.name, '${' + entry.name + '}']; })),
            }]));
            launchArgs = [...launchArgs, '--additional-mcp-config', JSON.stringify({ mcpServers })];
        }
        if (epoch !== this.launchEpoch) throw new Error('ACP closed before launch');
        return new Promise((resolve, reject) => {
            let command;
            try { command = resolveAgentCli(this.backend, launchArgs, this.executable); this.launch = command; } catch (e) { reject(e); return; }
            const child = spawn(command.executable, command.args, { cwd: this.launchCwd, env, windowsHide: true, shell: false, stdio: 'pipe', detached: process.platform !== 'win32' });
            this.child = child;
            let buffer = '', failed = false;
            const fail = (error: Error) => {
                if (failed) return; failed = true;
                if (this.child !== child) return;
                this.child = undefined; this.ready = undefined;
                this.refreshCapabilities();
                for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
                this.pending.clear(); this.permissions.clear();
                for (const thread of this.threads.values()) thread.loaded = false;
                this.active.clear(); reject(error); this.emit('exit', error.message);
                stopCli(child);
            };
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                buffer += chunk;
                if (buffer.length > 8_000_000) { fail(new Error('ACP output limit exceeded')); return; }
                let end;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                    if (!line.trim()) continue;
                    try { this.message(JSON.parse(line)); } catch { fail(new Error('Invalid ACP protocol output')); return; }
                }
            });
            child.stderr.resume();
            child.on('error', () => fail(new Error(`${this.backend} unavailable. Install its CLI or configure KEEPWORK_${this.backend.toUpperCase()}_PATH and restart Keepwork MCP.`)));
            child.on('exit', () => fail(new Error(`${this.backend} process stopped; prompts were not rerun.`)));
            child.stdin.on('error', () => fail(new Error('ACP input disconnected; reconcile before retrying')));
            child.on('spawn', () => void this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'keepwork-aichat', version: '1.0.0' } }).then(result => {
                if (result.protocolVersion !== 1) { fail(new Error('Unsupported ACP protocol version')); return; }
                this.capabilities = result.agentCapabilities || {}; resolve(result);
            }, fail));
        });
        })();
        const ready = this.ready;
        void ready.catch(() => { if (this.ready === ready) this.ready = undefined; });
        return ready;
    }
    private write(message: any) {
        if (!this.child?.stdin.writable) throw new Error('ACP disconnected');
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    }
    private rpc(method: string, params: any, timeout = 30000): Promise<any> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP ${method} timed out; do not resubmit automatically`)); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
        });
    }
    private message(m: any) {
        if (!m.method) {
            const pending = this.pending.get(m.id); if (!pending) return;
            this.pending.delete(m.id); clearTimeout(pending.timer);
            if (m.error) pending.reject(Object.assign(new Error(m.error.message || 'ACP request rejected'), { rpcRejected: true }));
            else pending.resolve(m.result);
            return;
        }
        if (m.method === 'session/update') { this.update(m.params); return; }
        if (m.id === undefined) return;
        if (this.backend === 'cursor' && ['cursor/ask_question', 'cursor/create_plan'].includes(m.method)) {
            const candidates = [...this.active].filter(([id, run]) => id === m.params?.sessionId || run.items.some(i => i.id === m.params?.toolCallId));
            const sessionId = candidates.length === 1 ? candidates[0][0] : this.active.size === 1 ? [...this.active.keys()][0] : undefined;
            if (!sessionId) { this.write({ id: m.id, error: { code: -32602, message: 'Cannot identify active Cursor session' } }); return; }
            this.permissions.set(m.id, { ...m.params, sessionId, cursorMethod: m.method });
            if (m.method === 'cursor/ask_question') this.emit('request', { id: m.id, method: 'item/tool/requestUserInput', params: { threadId: sessionId, questions: (m.params.questions || []).map((q: any) => ({ id: q.id, question: q.prompt, options: (q.options || []).map((o: any) => ({ label: o.label, description: o.id })) })) } });
            else this.emit('request', { id: m.id, method: 'item/commandExecution/requestApproval', params: { threadId: sessionId, requiresUserDecision: true, command: String(m.params.plan || m.params.overview || 'Approve Cursor plan').slice(0, 10000) } });
            return;
        }
        if (m.method === 'session/request_permission' && this.active.has(m.params?.sessionId)) {
            this.permissions.set(m.id, m.params);
            this.emit('request', { id: m.id, method: 'item/commandExecution/requestApproval', params: { threadId: m.params.sessionId, readOnly: ['read', 'search'].includes(m.params.toolCall?.kind), command: m.params.toolCall?.title || 'CLI tool', toolCall: cacheValue(m.params.toolCall || {}), options: m.params.options } });
        } else this.write({ id: m.id, error: { code: -32601, message: 'Client method unsupported' } });
    }
    private notify(method: string, threadId: string, params: any) { this.emit('notification', { method, params: { threadId, ...params } }); }
    private update(p: any) {
        const run = this.active.get(p?.sessionId), update = p?.update;
        const thread = this.threads.get(p?.sessionId);
        if (thread && update?.sessionUpdate === 'config_option_update') {
            thread.configOptions = update.configOptions;
            this.notify('model/updated', thread.id, {});
        }
        if (thread?.modes && update?.sessionUpdate === 'current_mode_update') thread.modes.currentModeId = update.currentModeId;
        if (!run || !update) return;
        if (['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) && update.content?.type === 'text') {
            const key = update.sessionUpdate === 'agent_thought_chunk' ? 'thoughtItem' : 'textItem';
            if (!run[key]) {
                run[key] = { id: randomUUID(), type: key === 'thoughtItem' ? 'reasoning' : 'agentMessage', text: '' };
                run.items.push(run[key]); run.items = run.items.slice(-2000); this.notify('item/started', p.sessionId, { item: run[key] });
            }
            run[key].text = (run[key].text + update.content.text).slice(-131072);
            this.notify('item/agentMessage/delta', p.sessionId, { itemId: run[key].id, delta: update.content.text });
        }
        if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
            run.textItem = undefined; run.thoughtItem = undefined;
            let item = run.items.find(i => i.id === update.toolCallId);
            if (!item) { item = { id: update.toolCallId, type: 'mcpToolCall', arguments: {}, result: {} }; run.items.push(item); run.items = run.items.slice(-2000); }
            item.command = String(update.title || item.command || '').slice(0, 10000);
            item.arguments = cacheValue(update.rawInput ?? item.arguments, { remaining: 131072 });
            item.result = cacheValue(update.rawOutput ?? update.content ?? item.result, { remaining: 131072 });
            item.status = ({ pending: 'inProgress', in_progress: 'inProgress', completed: 'completed', failed: 'failed' } as any)[update.status] || item.status || 'inProgress';
            this.notify('item/completed', p.sessionId, { item });
        }
    }
    private thread(id: string): Thread {
        if (!/^[\w-]{1,160}$/.test(id)) throw Object.assign(new Error('Invalid provider session ID'), { rpcRejected: true });
        let thread = this.threads.get(id);
        if (!thread) {
            thread = JSON.parse(fs.readFileSync(path.join(this.directory, id + '.json'), 'utf8'));
            thread!.loaded = false; this.threads.set(id, thread!);
        }
        return thread!;
    }
    private save(thread: Thread) {
        fs.mkdirSync(this.directory, { recursive: true });
        const file = path.join(this.directory, thread.id + '.json');
        const { loaded, mcpServers, ...data } = thread;
        fs.writeFileSync(file + '.tmp', JSON.stringify(cacheValue(data)), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    }
    private async resume(thread: Thread) {
        if (thread.loaded) return;
        if (!this.capabilities.loadSession) throw Object.assign(new Error(`${this.backend} CLI cannot resume sessions. History is readable; start a new conversation to continue.`), { rpcRejected: true });
        const result = await this.rpc('session/load', { sessionId: thread.id, cwd: thread.cwd, mcpServers: thread.mcpServers || [] });
        thread.loaded = true; thread.models = result.models || thread.models; thread.configOptions = result.configOptions || thread.configOptions; thread.modes = result.modes || thread.modes;
    }
    private isBuddy() { return this.backend === 'workbuddy' || this.backend === 'codebuddy'; }
    async call(method: string, p: any = {}): Promise<any> {
        // Copilot versions that ignore ACP mcpServers need one process-level configuration per session.
        // Buddy captures its environment at process startup; session/new.cwd alone does not
        // change that context. Keep each owned session in its root, separate from discovery.
        // Never reuse a probe process or share another account's MCP capability.
        let delegated = this.scoped.get(p.threadId);
        const needsScope = (this.isBuddy() && !this.launchCwd)
            || (this.backend === 'copilot' && !this.launchMcp && p.mcpServers?.length);
        if (needsScope && ['thread/start', 'thread/resume'].includes(method)) {
            if (delegated && this.backend === 'copilot' && JSON.stringify(delegated.launchMcp) !== JSON.stringify(p.mcpServers)) { delegated.close(); this.scoped.delete(p.threadId); delegated = undefined; }
            if (!delegated) {
                const cwd = p.cwd || (p.threadId ? this.thread(p.threadId).cwd : undefined);
                if (this.isBuddy() && !cwd) throw new Error('Select a local workspace before starting the CLI');
                const child = new AcpHarness(this.backend, this.directory, this.executable, this.args, this.prepareEnvironment,
                    this.backend === 'copilot' ? p.mcpServers : undefined, cwd);
                let threadId = p.threadId;
                child.on('notification', message => this.emit('notification', message));
                child.on('request', message => { const id = 'mcp-scope-' + randomUUID(); this.scopedRequests.set(id, { child, id: message.id }); this.emit('request', { ...message, id }); });
                child.on('exit', message => this.emit('exit', message, threadId ? [threadId] : []));
                try {
                    const result = await child.call(method, p); threadId = result.thread?.id || p.threadId;
                    this.scoped.set(threadId, child); return result;
                } catch (error) { child.close(); throw error; }
            }
        }
        if (delegated) return delegated.call(method, p);

        if (method === 'thread/read') return { thread: this.thread(p.threadId) };
        if (['thread/name/set', 'thread/archive', 'thread/unarchive'].includes(method)) return {}; // host metadata; native history preserved
        await this.start();
        if (method === 'account/read') return { account: null, authUnknown: true };
        if (method === 'model/list') {
            const cwd = p.cwd || (p.catalogKey ? this.discoveryDirectory() : undefined);
            const key = JSON.stringify([cwd, p.model || '']);
            if (!p.threadId && p.catalogKey && this.modelCatalog.has(key)) return { data: cacheValue(this.modelCatalog.get(key)) };
            const shared = !p.threadId && !!p.catalogKey;
            if (shared && this.modelFlights.has(key)) return cacheValue(await this.modelFlights.get(key)!);
            const epoch = this.catalogEpoch;
            const task = (async () => {
                const thread = p.threadId ? this.thread(p.threadId) : p.catalogKey ? await this.catalog(p.catalogKey, cwd!) : undefined;
                if (thread && !p.readOnly) { await this.resume(thread); if (p.model && this.models(thread).some(m => m.id === p.model)) await this.setModel(thread, p.model); }
                const data = (thread ? [thread] : [...this.threads.values()]).flatMap(t => this.models(t)).filter((m, i, a) => m.id && a.findIndex(x => x.id === m.id) === i);
                if (thread && data.length && !p.threadId && epoch === this.catalogEpoch) {
                    const current = data.find(m => m.isDefault)?.id;
                    if (!p.model || p.model === current) this.modelCatalog.set(key, cacheValue(data));
                    if (current) this.modelCatalog.set(JSON.stringify([cwd, current]), cacheValue(data));
                    while (this.modelCatalog.size > 64) this.modelCatalog.delete(this.modelCatalog.keys().next().value!);
                }
                return { data };
            })();
            if (shared) this.modelFlights.set(key, task);
            try { return await task; } finally { if (this.modelFlights.get(key) === task) this.modelFlights.delete(key); }
        }
        if (method === 'account/login/start') throw Object.assign(new Error(`Login in your terminal using ${AGENT_CLI[this.backend].login}; then reconnect.`), { rpcRejected: true });
        if (method === 'thread/start') {
            const discovery = p.catalogKey && this.catalogTasks.get(p.catalogKey + ':' + p.cwd);
            if (discovery) await discovery;
            const preview = p.catalogKey && this.catalogs.get(p.catalogKey);
            const thread = !p.mcpServers?.length && preview?.cwd === p.cwd ? preview.thread : await this.newThread(p.cwd, p.mcpServers);
            if (preview) { this.catalogs.delete(p.catalogKey); if (preview.thread.id !== thread.id) this.threads.delete(preview.thread.id); }
            await this.resume(thread);
            if (p.model) await this.setModel(thread, p.model);
            this.save(thread);
            return { thread };
        }
        const thread = this.thread(p.threadId);
        if (method === 'thread/mode/set') {
            await this.resume(thread);
            if (p.model) await this.setModel(thread, p.model);
            const option = thread.configOptions?.find(o => o.category === 'mode' || o.id === 'mode');
            const choices = option ? this.values(option).map(v => ({ id: v.value, name: v.name })) : thread.modes?.availableModes || [];
            const current = option?.currentValue || thread.modes?.currentModeId;
            const plan = choices.find((m: any) => /^(plan(?:[-_]mode)?|architect)$/i.test(m.id) || /^plan(?: mode)?$/i.test(m.name));
            if (!thread.normalMode && current && current !== plan?.id) thread.normalMode = current;
            const ids = p.mode === 'craft' ? ['bypassPermissions', 'yolo', 'full-access', 'code', 'build', 'agent', 'default', 'ask'] : ['ask', 'default', 'code', 'build', 'agent'];
            const normal = ids.map(id => choices.find((m: any) => m.id === id)).find(Boolean)
                || choices.find((m: any) => m.id === thread.normalMode && m.id !== plan?.id && (p.mode === 'craft' || !/bypass|yolo|full.?access|auto.?approve|acceptEdits/i.test(m.id)));
            const selected = p.mode === 'plan' ? plan || normal : normal;
            if (!selected && choices.length && p.mode !== 'craft') throw new Error('CLI does not advertise a mode for manual access or planning');
            if (!selected && current && current === plan?.id && p.mode !== 'plan') throw new Error('CLI does not advertise a mode to leave Plan');
            if (selected && selected.id !== current) {
                if (option) await this.setOption(thread, option, selected.id);
                else { await this.rpc('session/set_mode', { sessionId: thread.id, modeId: selected.id }); thread.modes.currentModeId = selected.id; }
            }
            this.save(thread);
            return { nativePlan: p.mode === 'plan' && !!plan };
        }
        if (method === 'thread/resume') { if (p.mcpServers) thread.mcpServers = p.mcpServers; await this.resume(thread); return { thread }; }
        if (method === 'turn/interrupt') {
            const run = this.active.get(thread.id); if (run) run.cancelled = true;
            this.write({ method: 'session/cancel', params: { sessionId: thread.id } }); return {};
        }
        if (method !== 'turn/start') throw Object.assign(new Error('Unsupported harness method'), { rpcRejected: true });
        try {
            await this.resume(thread);
            if (p.model) await this.setModel(thread, p.model);
            if (p.effort) {
                const option = this.effortOption(thread);
                if (!option) throw new Error('This CLI/model does not expose reasoning effort through ACP; use native CLI settings or update the CLI');
                await this.setOption(thread, option, p.effort);
            }
        } catch (error) {
            // No prompt was submitted if native session configuration failed.
            throw Object.assign(error as Error, { rpcRejected: true });
        }
        const run = { id: randomUUID(), items: [] as any[] };
        this.active.set(thread.id, run);
        const user = { id: randomUUID(), type: 'userMessage', content: p.input };
        run.items.push(user);
        this.notify('turn/started', thread.id, { turn: { id: run.id } });
        this.notify('item/completed', thread.id, { item: user });
        // Prompt RPC completes only when the turn finishes. Return acceptance immediately.
        void this.rpc('session/prompt', { sessionId: thread.id, prompt: p.input }, 30 * 60 * 1000).then(result => {
            this.finish(thread, run, result.stopReason === 'cancelled' ? 'interrupted' : result.stopReason === 'end_turn' ? 'completed' : 'failed', result.stopReason === 'end_turn' || result.stopReason === 'cancelled' ? undefined : result.stopReason);
        }, error => this.finish(thread, run, 'failed', error.message));
        return { turn: { id: run.id } };
    }
    private finish(thread: Thread, run: any, status: string, error?: string) {
        if (this.active.get(thread.id) !== run) return;
        this.active.delete(thread.id);
        for (const [id, p] of this.permissions) if (p.sessionId === thread.id) { this.permissions.delete(id); this.notify('serverRequest/resolved', thread.id, { requestId: id }); }
        thread.turns.push({ id: run.id, status, items: run.items });
        thread.turns = thread.turns.slice(-100);
        while (thread.turns.length > 1 && JSON.stringify(thread.turns).length > 2_000_000) thread.turns.shift();
        try { this.save(thread); } catch { status = 'failed'; error = 'Could not persist local CLI history'; }
        this.notify('turn/completed', thread.id, { turn: { id: run.id, status, ...(error ? { error: { message: error } } : {}) } });
    }
    private values(option: any): any[] { return (option?.options || []).flatMap((group: any) => group.options || [group]); }
    private modelOption(thread: Thread) { return thread.configOptions?.find(o => (!o.type || o.type === 'select') && (o.category === 'model' || o.id === 'model')); }
    private effortOption(thread: Thread) {
        return thread.configOptions?.find(o => (!o.type || o.type === 'select') && (o.category === 'thought_level' || /^(reasoning[-_]effort|effort|thinking[-_]level)$/.test(o.id)));
    }
    private models(thread: Thread): any[] {
        const model = this.modelOption(thread), effort = this.effortOption(thread);
        const current = model?.currentValue || thread.models?.currentModelId;
        const models = model ? this.values(model).map(m => ({ id: m.value, displayName: m.name, description: m.description }))
            : (thread.models?.availableModels || []).map((m: any) => ({ id: m.modelId, displayName: m.name, description: m.description }));
        return models.map((m: any) => ({ ...m, isDefault: m.id === current,
            // ACP effort options describe the current model; refresh native configuration on model changes.
            ...(m.id === current && effort ? { defaultReasoningEffort: effort.currentValue,
                supportedReasoningEfforts: this.values(effort).map(e => ({ reasoningEffort: e.value, displayName: e.name, description: e.description })) } : {}) }));
    }
    private async newThread(cwd: string, mcpServers: any[] = []): Promise<Thread> {
        const result = await this.rpc('session/new', { cwd, mcpServers });
        const thread: Thread = { id: result.sessionId, cwd, turns: [], models: result.models, modes: result.modes, configOptions: result.configOptions, loaded: true, mcpServers };
        if (!/^[\w-]{1,160}$/.test(thread.id || '')) throw new Error('ACP did not return a valid session ID');
        this.threads.set(thread.id, thread); return thread;
    }
    private async catalog(key: string, cwd: string): Promise<Thread> {
        const preview = this.catalogs.get(key);
        if (preview?.cwd === cwd) return preview.thread;
        const taskKey = key + ':' + cwd;
        if (this.catalogTasks.has(taskKey)) return this.catalogTasks.get(taskKey)!;
        const task = this.newThread(cwd).then(thread => {
            if (preview) this.threads.delete(preview.thread.id);
            if (this.catalogs.size >= 32) {
                const oldest = this.catalogs.keys().next().value!;
                this.threads.delete(this.catalogs.get(oldest)!.thread.id); this.catalogs.delete(oldest);
            }
            this.catalogs.set(key, { cwd, thread }); return thread;
        });
        this.catalogTasks.set(taskKey, task);
        try { return await task; } finally { this.catalogTasks.delete(taskKey); }
    }
    private discoveryDirectory() {
        // A prompt-free metadata query also works before the browser selects a local root.
        const cwd = path.join(this.directory, 'model-discovery'); fs.mkdirSync(cwd, { recursive: true }); return cwd;
    }
    refreshCapabilities() {
        this.catalogEpoch++; this.modelCatalog.clear(); this.modelFlights.clear();
        // Only unused, prompt-free previews are discarded; owned sessions/processes stay alive.
        for (const { thread } of this.catalogs.values()) this.threads.delete(thread.id);
        this.catalogs.clear();
    }
    private async setOption(thread: Thread, option: any, value: string) {
        if (!this.values(option).some(o => o.value === value)) throw Object.assign(new Error('Unsupported native configuration value: ' + value), { rpcRejected: true });
        if (option.currentValue === value) return;
        const result = await this.rpc('session/set_config_option', { sessionId: thread.id, configId: option.id, value });
        if (result.configOptions) thread.configOptions = result.configOptions;
        else option.currentValue = value;
    }
    private async setModel(thread: Thread, model: string) {
        const option = this.modelOption(thread);
        if (option) await this.setOption(thread, option, model);
        else if (thread.models?.currentModelId !== model) {
            await this.rpc('session/set_model', { sessionId: thread.id, modelId: model });
            if (thread.models) thread.models.currentModelId = model;
        }
    }
    respond(id: string | number, result: any) {
        const delegated = this.scopedRequests.get(String(id));
        if (delegated) { this.scopedRequests.delete(String(id)); delegated.child.respond(delegated.id, result); return; }

        const p = this.permissions.get(id); if (!p) throw new Error('ACP request expired');
        if (p.cursorMethod) {
            let outcome: any;
            if (p.cursorMethod === 'cursor/create_plan') outcome = { outcome: ['accept', 'acceptForSession'].includes(result.decision) ? 'accepted' : 'rejected' };
            else {
                const answers = (p.questions || []).map((q: any) => {
                    const text = result.answers?.[q.id]?.answers?.[0];
                    const selected = (q.options || []).find((o: any) => o.label === text || o.id === text);
                    if (!selected) throw Object.assign(new Error('Choose one of the Cursor question options'), { rpcRejected: true });
                    return { questionId: q.id, selectedOptionIds: [selected.id] };
                });
                outcome = { outcome: 'answered', answers };
            }
            this.write({ id, result: { outcome } }); this.permissions.delete(id); return;
        }
        const kind = result.decision === 'acceptForSession' ? 'allow_always' : result.decision === 'accept' ? 'allow_once' : 'reject_once';
        const option = (p.options || []).find((o: any) => o.kind === kind)
            || (kind === 'allow_once' ? (p.options || []).find((o: any) => o.kind === 'allow_always') : undefined);
        this.write({ id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
        this.permissions.delete(id);
    }
    close() {
        for (const child of this.scoped.values()) child.close(); this.scoped.clear(); this.scopedRequests.clear();

        this.launchEpoch++;
        const child = this.child;
        this.child = undefined; this.ready = undefined;
        this.refreshCapabilities();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ACP closed')); }
        this.pending.clear(); this.permissions.clear(); this.active.clear();
        for (const thread of this.threads.values()) thread.loaded = false;
        if (child) { stopCli(child); this.emit('exit', 'ACP closed'); }
    }
}
