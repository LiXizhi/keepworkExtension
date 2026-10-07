import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CodexHarness, HarnessAdapter } from './codexHarness';
import { AcpHarness } from './acpHarness';
import { CopilotHarness } from './copilotHarness';
import { ClaudeHarness } from './claudeHarness';
import { AGENT_BACKENDS, AGENT_CLI } from './agentCliBackends';
import { resolveAgentCli } from './agentCliProcess';
import { AichatToolBridge } from './aichatToolBridge';
import { AichatWorkspaceFiles, WORKSPACE_FILE_TOOL } from './aichatWorkspaceFiles';
import { agentMode, agentAccess, AgentMode, PLAN_FALLBACK } from './agentModes';
export { AGENT_BACKENDS } from './agentCliBackends';
type Backend = typeof AGENT_BACKENDS[number];

type Item = { id: string; type: string; [key: string]: any };
type Session = {
    backend: Backend; id: string; owner: string; conversationId: string; threadId: string; title: string;
    roots: string[]; rootNames?: string[]; worktrees: string[]; sandboxPolicy?: any; model?: string; effort?: string; archived: boolean; removed: boolean; aichatContext?: boolean;
    status: string; mode?: AgentMode; nativePlan?: boolean; turnId?: string; error?: string; retrying?: boolean; cursor: number; items: Item[]; pending: any[];
    submissions: Record<string, { state: string; turnId?: string }>;
    events: any[]; updatedAt: number;
};
const ACTIVE = new Set(['starting', 'running', 'waiting', 'uncertain']);
function visibleItem(item: any) {
    if (item?.type !== 'userMessage' || !Array.isArray(item.content)) return item;
    const marker = '\n</aichat_context>\n<aichat_user_message>\n';
    return { ...item, content: item.content.map((part: any) => part.type === 'text' && part.text?.startsWith('<aichat_context ') && part.text.includes(marker) ? { ...part, text: part.text.slice(part.text.indexOf(marker) + marker.length) } : part) };
}
const RESPONDABLE = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
function bounded(value: any, budget = { remaining: 2_000_000 }, depth = 0): any {
    if (budget.remaining <= 0 || depth > 24) return '';
    budget.remaining -= 16;
    if (typeof value === 'string') { const out = value.slice(0, Math.max(0, Math.min(131072, budget.remaining))); budget.remaining -= out.length; return out; }
    if (Array.isArray(value)) {
        const out: any[] = [];
        for (const item of value.slice(0, 2000)) { if (budget.remaining <= 0) break; out.push(bounded(item, budget, depth + 1)); }
        return out;
    }
    if (value && typeof value === 'object') {
        const entries: [string, any][] = [];
        for (const [k,v] of Object.entries(value)) {
            if (budget.remaining <= 0 || entries.length >= 2000) break;
            if (/token|password|secret|authorization|cookie/i.test(k)) continue;
            budget.remaining -= k.length;
            entries.push([k, bounded(v, budget, depth + 1)]);
        }
        return Object.fromEntries(entries);
    }
    return value;
}
export function ownerKey(origin: string, owner: string) {
    if (!/^[a-zA-Z0-9-]{32,128}$/.test(owner)) throw new Error('Agent owner key required');
    return createHash('sha256').update(origin + '\0' + owner).digest('hex');
}
export function canonicalRoot(input: string) {
    if (!path.isAbsolute(input) || !fs.statSync(input).isDirectory()) throw new Error('Existing absolute local folder required');
    const real = fs.realpathSync(input);
    return process.platform === 'win32' ? real.toLowerCase() : real;
}
function overlap(a: string, b: string) { return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep); }
function inside(root: string, file: string) { return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep); }
function verifyRoots(roots: string[]) {
    for (const root of roots) if (canonicalRoot(root) !== root) throw new Error('Workspace root changed; reconnect the original local folder');
}
export function workspacePrompt(text: string, roots: string[], names = roots.map(root => path.basename(root))) {
    const refs = text.replace(/\[#ref\s+([^\]]+?)\]/g, (_tag, raw: string) => {
        const ref = raw.trim().replace(/\\/g, '/');
        if (/^(?:\/\/)?\.(?:brain|calendar|paraworld)(?:\/|$)/.test(ref)) throw new Error('Global workspace aliases are not available in CLI sessions; select a local workspace file');
        let candidate: string;
        if (path.isAbsolute(ref) && !ref.startsWith('//')) candidate = ref;
        else {
            const normalized = ref.replace(/^\/\//, ''), slash = normalized.indexOf('/');
            const matching = names.map((name, index) => name === normalized.slice(0, slash) ? index : -1).filter(index => index >= 0);
            if (matching.length > 1) throw new Error('Ambiguous workspace file reference; use its absolute local path');
            candidate = matching.length ? path.resolve(roots[matching[0]], normalized.slice(slash + 1)) : path.resolve(roots[0], normalized);
        }
        if (!fs.existsSync(candidate)) throw new Error('Referenced local file is unavailable: ' + raw);
        const real = fs.realpathSync(candidate), canonical = process.platform === 'win32' ? real.toLowerCase() : real;
        if (!roots.some(root => inside(root, canonical))) throw new Error('File reference is outside the session workspace roots');
        return `[#ref ${real}]`;
    });
    return `Workspace folders (primary first):\n${roots.map((r,i) => `${i+1}. ${names[i] || path.basename(r)}: ${r}`).join('\n')}\n\n${refs}`;
}

export class AgentSessions {
    readonly toolBridge = new AichatToolBridge();
    readonly workspaceFiles: AichatWorkspaceFiles;
    registerWorkspaceGrant(owner: string, conversationId: string, input: any) {
        if (!this.toolBridge.has(owner, conversationId)) throw new Error('Register context first');
        const result = this.workspaceFiles.register(owner, conversationId, input);
        this.toolBridge.setBackend(owner, conversationId, [WORKSPACE_FILE_TOOL], (_name, args) => this.workspaceFiles.execute(owner, conversationId, args));
        return result;
    }
    private sessions = new Map<string, Session>();
    private listeners = new Map<string, Set<(event: any) => void>>();
    private loaded = new Set<string>();
    private loading = new Map<string, Promise<void>>();
    private creating = new Map<string, Promise<any>>();
    private flushTimers = new Map<string, NodeJS.Timeout>();
    private closing = false;
    private adapters: Record<string, HarnessAdapter>;
    private capabilities = new Map<string, Promise<any>>();
    constructor(private file: string, adapter: HarnessAdapter = new CodexHarness(), adapters?: Record<string, HarnessAdapter>) {
        this.toolBridge.setPolicy((owner, id, name, execution, args) => {
            const planning = [...this.sessions.values()].some(s => s.owner === owner && s.conversationId === id && !s.removed && s.mode === 'plan');
            if (!planning) return true;
            if (execution === 'native') return ['web_search', 'fetch_url', 'grep', 'grep_files'].includes(name);
            if (execution === 'backend') return name === 'workspace_file' && (!args || ['read', 'list', 'search'].includes(args.operation));
            return ['read_file', 'list_dir', 'search_files', 'create_file', 'replace_string_in_file'].includes(name);
        });
        this.workspaceFiles = new AichatWorkspaceFiles(path.join(path.dirname(file), 'agent-git-drafts'));
        this.adapters = adapters || Object.fromEntries(AGENT_BACKENDS.map(backend => [backend, backend === 'codex' ? adapter : backend === 'claude' ? new ClaudeHarness(file + '.claude') : backend === 'copilot' ? new CopilotHarness(file + '.copilot') : new AcpHarness(backend, file + '.' + backend)]));
        try {
            const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const row of rows) if (row.id && row.owner && row.threadId) this.sessions.set(row.id, { ...row, backend: row.backend || 'codex', status: ACTIVE.has(row.status) ? 'interrupted' : row.status, pending: [], events: [], items: [] });
        } catch { /* first run */ }
        for (const [backend, adapter] of Object.entries(this.adapters)) {
            adapter.on('notification', m => this.notification(m, backend));
            adapter.on('request', m => this.request(m, backend));
            adapter.on('exit', (_message, scope?: string[] | { exclude: string[] }) => {
                this.clearCapabilities(backend);
                if (this.closing) return;
                for (const s of this.sessions.values()) {
                    if (s.backend !== backend) continue;
                    if (scope && (Array.isArray(scope) ? !scope.includes(s.threadId) : scope.exclude.includes(s.threadId))) continue;
                    this.loaded.delete(s.id); this.loading.delete(s.id); s.pending = [];
                    if (ACTIVE.has(s.status)) { s.status = 'interrupted'; this.emit(s); }
                }
            });
        }
    }
    private adapterFor(backend: string = 'codex') {
        if (!AGENT_BACKENDS.includes(backend as Backend) || !this.adapters[backend]) throw new Error('Unsupported agent backend');
        return this.adapters[backend];
    }
    private forSession(s: Session) { return this.adapterFor(s.backend); }
    private clearCapabilities(backend: string, modelsOnly = false) {
        this.capabilities.delete(backend + ':model/list');
        if (!modelsOnly) this.capabilities.delete(backend + ':account/read');
    }
    private capability(backend: string, method: string) {
        const key = backend + ':' + method;
        if (this.capabilities.has(key)) return this.capabilities.get(key)!;
        const task = Promise.resolve().then(() => this.adapterFor(backend).call(method, method === 'account/read' ? { refreshToken: false } : { limit: 100 })).then(result => {
            if (method === 'model/list' && !result.data?.length && this.capabilities.get(key) === task) this.capabilities.delete(key);
            return result;
        });
        this.capabilities.set(key, task);
        void task.catch(() => { if (this.capabilities.get(key) === task) this.capabilities.delete(key); });
        return task;
    }
    async backends() {
        return Object.fromEntries(await Promise.all(AGENT_BACKENDS.map(async backend => [backend, await this.status(backend)])));
    }
    inventory() {
        // Installation discovery only: never start eleven native servers for a picker.
        return Object.fromEntries(AGENT_BACKENDS.map(backend => {
            const spec = AGENT_CLI[backend];
            try {
                const cli = resolveAgentCli(backend, spec.args);
                return [backend, { name: spec.name, installUrl: spec.installUrl, available: true, authenticated: null, probe: 'executable', cli: { path: cli.path, source: cli.source }, models: [] }];
            } catch (error) {
                return [backend, { name: spec.name, installUrl: spec.installUrl, available: false, probe: 'executable', models: [], error: (error as Error).message }];
            }
        }));
    }
    private save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const rows = [...this.sessions.values()].map(({ items, events, pending, ...row }) => row);
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(rows), { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
    }
    private get(id: string, owner: string) {
        const s = this.sessions.get(id);
        if (!s || s.owner !== owner || s.removed) throw new Error('Agent session not found');
        return s;
    }
    private view(s: Session, includeItems = true) {
        const { owner, submissions, events, worktrees, sandboxPolicy, items, pending, ...view } = s;
        const last = Object.entries(submissions).at(-1);
        const visibleItems = items.map(item => item.type === 'userMessage' && Array.isArray(item.content) ? { ...item, content: item.content.map((part: any) => {
            const marker = '\n</aichat_context>\n<aichat_user_message>\n';
            return part.type === 'text' && part.text?.startsWith('<aichat_context ') && part.text.includes(marker) ? { ...part, text: part.text.slice(part.text.indexOf(marker) + marker.length) } : part;
        }) } : item);
        return { ...bounded(view), ...(s.aichatContext ? { context: { ...this.toolBridge.snapshot(s.owner, s.conversationId), workspace: this.workspaceFiles.snapshot(s.owner, s.conversationId) } } : {}), items: includeItems ? bounded(visibleItems) : [], pending: includeItems ? bounded(pending, {remaining:500000}) : [], lastSubmission: last ? { requestId: last[0], ...last[1] } : null };
    }
    private emit(s: Session, delayed = false) {
        if (this.closing) return;
        if (delayed) {
            if (!this.flushTimers.has(s.id)) this.flushTimers.set(s.id, setTimeout(() => { this.flushTimers.delete(s.id); this.emit(s); }, 100));
            return;
        }
        const timer = this.flushTimers.get(s.id); if (timer) { clearTimeout(timer); this.flushTimers.delete(s.id); }
        s.updatedAt = Date.now(); s.cursor++;
        // Keep replay/output bounded even when a tool emits very large results.
        while (s.items.length > 1 && JSON.stringify(s.items).length > 2_000_000) s.items.shift();
        // Events carry snapshots: reconnects and duplicate events are idempotent.
        const event = { cursor: s.cursor, session: this.view(s) };
        s.events = [event]; this.save();
        for (const listener of this.listeners.get(s.id) || []) listener(event);
    }
    async status(backend: string = 'codex', scope: { owner?: string; cwd?: string; conversationId?: string; sessionId?: string; model?: string; refresh?: boolean } = {}) {
        // Resolve scope before provider I/O. Never reveal or configure another owner's session.
        let session: Session | undefined;
        if (scope.sessionId) { session = this.get(scope.sessionId, scope.owner || ''); if (session.backend !== backend) throw new Error('Agent backend mismatch'); }
        const cwd = scope.cwd ? canonicalRoot(scope.cwd) : undefined;
        if (scope.conversationId && !/^[\w-]{1,160}$/.test(scope.conversationId)) throw new Error('Invalid conversation ID');
        let adapter: HarnessAdapter | undefined;
        try {
            adapter = this.adapterFor(backend);
            if (scope.refresh) { this.clearCapabilities(backend); adapter.refreshCapabilities?.(); }
            const account = await this.capability(backend, 'account/read');
            let result: any = {}, modelsError: string | undefined;
            try { result = AGENT_CLI[backend as Backend].protocol === 'acp' ? await adapter.call('model/list', { limit: 100, cwd, threadId: session?.threadId,
                catalogKey: scope.owner && scope.conversationId ? scope.owner + ':' + scope.conversationId : undefined,
                readOnly: !!session && (session.archived || ACTIVE.has(session.status)),
                model: session && (session.archived || ACTIVE.has(session.status)) ? undefined : scope.model }) : await this.capability(backend, 'model/list'); }
            catch (error) { modelsError = (error as Error).message; }
            modelsError ||= result.modelsError;
            const loginRequired = !!modelsError && /^Authentication required[.!]?$/i.test(modelsError.trim());
            return { name: AGENT_CLI[backend as Backend]?.name, protocol: AGENT_CLI[backend as Backend]?.protocol, installUrl: AGENT_CLI[backend as Backend]?.installUrl, probe: account.probe || 'protocol', available: true, cli: adapter.cliInfo?.(), authenticated: loginRequired ? false : account.authUnknown ? null : !!account.account || account.requiresOpenaiAuth === false, authState: loginRequired ? 'required' : account.authUnknown ? 'unknown' : 'verified', models: bounded(result.data || []), ...(modelsError ? { modelsError } : {}) };
        } catch (error) { return { name: AGENT_CLI[backend as Backend]?.name, protocol: AGENT_CLI[backend as Backend]?.protocol, installUrl: AGENT_CLI[backend as Backend]?.installUrl, available: false, cli: adapter?.cliInfo?.(), authenticated: false, models: [], error: (error as Error).message }; }
    }
    async login(backend: string = 'codex') {
        this.clearCapabilities(backend);
        if (backend !== 'codex') { this.adapterFor(backend); return { command: AGENT_CLI[backend as Backend].login, message: 'Run this command in your terminal to sign in, then reconnect.' }; }
        const result = await this.adapterFor(backend).call('account/login/start', { type: 'chatgpt' });
        if (typeof result.authUrl !== 'string' || !result.authUrl.startsWith('https://')) throw new Error('Codex did not return a browser login URL');
        return { url: result.authUrl };
    }
    list(owner: string, offset = 0, limit = 100) { return [...this.sessions.values()].filter(s => s.owner === owner && !s.removed).slice(offset, offset + limit).map(s => this.view(s, false)); }
    async create(owner: string, input: any) {
        if (typeof input.conversationId !== 'string' || !/^[\w-]{1,160}$/.test(input.conversationId)) throw new Error('Conversation ID required');
        const backend = input.backend || 'codex'; this.adapterFor(backend);
        const existing = [...this.sessions.values()].find(s => s.owner === owner && s.conversationId === input.conversationId && s.backend === backend && !s.removed);
        if (existing) return this.view(existing);
        const key = owner + backend + input.conversationId;
        if (this.creating.has(key)) return this.creating.get(key);
        const task = this.createNew(owner, input); this.creating.set(key, task);
        try { return await task; } finally { this.creating.delete(key); }
    }
    private async createNew(owner: string, input: any) {
        const aichatContext = input.contextVersion === 1;
        if (aichatContext && !this.toolBridge.has(owner, input.conversationId)) throw new Error('Register AIChat tool context before creating a session');
        if (aichatContext && (!input.roots?.length || input.cloudPrimary)) {
            const cwd = path.join(path.dirname(this.file), 'agent-workspaces', owner, input.conversationId);
            fs.mkdirSync(cwd, { recursive: true });
            input = { ...input, roots: [cwd, ...(input.roots || [])], rootNames: ['CLI temporary runtime', ...(input.rootNames || [])] };
        }
        if (!Array.isArray(input.roots) || !input.roots.length || input.roots.length > 16) throw new Error('Select 1–16 local workspace folders');
        if ([...this.sessions.values()].filter(s => !s.removed).length >= 1000) throw new Error('Agent session limit reached');
        const roots = [...new Set<string>(input.roots.map((p: any) => canonicalRoot(String(p))))];
        const rootNames = roots.map(root => {
            const index = input.roots.findIndex((r: string) => canonicalRoot(r) === root);
            return String(input.rootNames?.[index] || path.basename(root)).replace(/[\r\n]/g, ' ').slice(0, 200);
        });
        const worktrees = roots.map(root => {
            try { return canonicalRoot(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
            catch { return root; }
        });
        const backend: Backend = input.backend || 'codex';
        const bridgeOptions = aichatContext ? await this.bridgeOptions(owner, input.conversationId, backend) : {};
        const mode = agentMode(input.mode), { sandbox, approvalPolicy } = agentAccess(mode);
        const result = await this.adapterFor(backend).call('thread/start', { cwd: roots[0], roots, catalogKey: owner + ':' + input.conversationId, ...bridgeOptions, sandbox, approvalPolicy, ...(input.model ? { model: String(input.model) } : {}) });
        if (!result.thread?.id) throw new Error('Incompatible agent provider: no thread ID');
        const s: Session = { backend, id: randomUUID(), owner, conversationId: input.conversationId, threadId: result.thread.id, roots, rootNames, worktrees, sandboxPolicy: result.sandbox, title: AGENT_CLI[backend].name, model: input.model, archived: false, removed: false, status: 'idle', cursor: 0, items: [], pending: [], submissions: {}, events: [], updatedAt: Date.now(), ...(aichatContext ? { aichatContext: true } : {}) };
        s.mode = mode;
        this.sessions.set(s.id, s); this.loaded.add(s.id); this.emit(s); return this.view(s);
    }
    revokeContext(owner: string) {
        this.toolBridge.revoke(owner); this.workspaceFiles.revoke(owner);
        for (const session of this.sessions.values()) if (session.owner === owner && session.aichatContext) this.loaded.delete(session.id);
    }
    private async bridgeOptions(owner: string, conversationId: string, backend: string) {
        const server = await this.toolBridge.descriptor(owner, conversationId);
        const instructions = 'AIChat context is supplied in the versioned aichat_context block each turn. Discover tools through keepwork_aichat. Preserve your native instructions.';
        if (backend === 'codex') return { developerInstructions: instructions, config: { mcp_servers: { keepwork_aichat: { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(e => [e.name, e.value])) } } } };
        return { mcpServers: [server], aichatInstructions: instructions };
    }
    private async load(s: Session) {
        if (this.loaded.has(s.id)) return;
        if (this.loading.has(s.id)) return this.loading.get(s.id);
        const task = (async () => {
            verifyRoots(s.roots);
            if (s.aichatContext && !this.toolBridge.has(s.owner, s.conversationId)) {
                const result = await this.forSession(s).call('thread/read', { threadId: s.threadId, includeTurns: true });
                s.items = (result.thread?.turns || []).flatMap((turn: any) => turn.items || []).slice(-2000).map((item: any) => bounded(visibleItem(item)));
                return; // History is readable without restoring a capability or resuming execution.
            }
            const bridgeOptions = s.aichatContext && !s.archived ? await this.bridgeOptions(s.owner, s.conversationId, s.backend) : {};
            const result = await this.forSession(s).call(s.archived ? 'thread/read' : 'thread/resume', { threadId: s.threadId, cwd: s.roots[0], includeTurns: true, ...bridgeOptions,
                ...(!s.archived ? { sandbox: agentAccess(agentMode(s.mode)).sandbox, approvalPolicy: agentAccess(agentMode(s.mode)).approvalPolicy } : {}) });
            if (result.sandbox) s.sandboxPolicy = result.sandbox;
            s.items = (result.thread?.turns || []).flatMap((turn: any) => turn.items || []).slice(-2000).map((item: any) => bounded(visibleItem(item)));
            this.loaded.add(s.id); this.emit(s);
        })();
        this.loading.set(s.id, task);
        try { await task; } finally { this.loading.delete(s.id); }
    }
    async read(id: string, owner: string) {
        const s = this.get(id, owner); await this.load(s);
        if (s.status === 'uncertain') {
            const result = await this.forSession(s).call('thread/read', { threadId: s.threadId, includeTurns: true });
            const turns = result.thread?.turns || [], last = turns[turns.length - 1];
            if (result.thread?.status?.type === 'active') s.status = 'running';
            else if (last && last.id === s.turnId && ['completed','failed','interrupted'].includes(last.status)) s.status = last.status;
            if (s.status !== 'uncertain' && s.turnId) {
                const submission = Object.values(s.submissions).at(-1);
                if (submission?.state === 'unknown') { submission.state = 'accepted'; submission.turnId = s.turnId; }
            }
            // Unknown acceptance remains locked until a definitive provider event or restart.
            this.emit(s);
        }
        return this.view(s);
    }
    async turn(id: string, owner: string, input: any) {
        const s = this.get(id, owner);
        if (input.contextVersion === 1 && !s.aichatContext) throw new Error('This older CLI session has no AIChat MCP connection; start a new chat to enable context and tools');
        if (!/^[\w-]{1,160}$/.test(input.requestId || '')) throw new Error('requestId required');
        if (s.submissions[input.requestId]) return { submission: s.submissions[input.requestId], session: this.view(s) };
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 200000) throw new Error('Text required (maximum 200000 characters)');
        if (s.archived || ACTIVE.has(s.status)) throw new Error('Session is archived or already running');
        const mode = agentMode(input.mode ?? s.mode);
        verifyRoots(s.roots);
        const context = s.aichatContext ? this.toolBridge.context(owner, s.conversationId) : null;
        const text = context ? `<aichat_context revision="${context.revision.replace(/[^\w-]/g, '')}">\n${context.instructions}\n</aichat_context>\n<aichat_user_message>\n${input.text}` : workspacePrompt(input.text, s.roots, s.rootNames);
        const overlapping = [...this.sessions.values()].filter(other => other.id !== id && !other.removed && ACTIVE.has(other.status)
            && (s.roots.some(a => other.roots.some(b => overlap(a,b))) || s.worktrees.some(a => other.worktrees.includes(a))));
        // Overlap is advisory. Only expose session identities belonging to this owner.
        const warnings = overlapping.length ? [{ code: 'workspace_overlap',
            sessions: overlapping.filter(other => other.owner === owner).slice(0, 10).map(other => ({ id: other.id, title: other.title.slice(0, 160) })),
        }] : [];
        // Claim before the first await, including resume/config lookup.
        s.mode = mode; s.status = 'starting'; s.error = ''; s.retrying = false; s.turnId = undefined;
        if (Object.keys(s.submissions).length > 500) s.submissions = Object.fromEntries(Object.entries(s.submissions).slice(-250));
        s.submissions[input.requestId] = { state: 'starting' }; this.emit(s);
        let dispatched = false;
        try {
            await this.load(s);
            const configured = await this.forSession(s).call('thread/mode/set', { threadId: s.threadId, mode, model: input.model || s.model, effort: input.effort });
            s.nativePlan = mode === 'plan' && configured?.nativePlan === true;
            const { sandboxPolicy, approvalPolicy } = agentAccess(mode);
            const prompt = mode === 'plan' && !s.nativePlan ? (context
                ? text.replace('\n</aichat_context>', PLAN_FALLBACK + '\n</aichat_context>')
                : PLAN_FALLBACK + text) : text;
            dispatched = true;
            const result = await this.forSession(s).call('turn/start', { threadId: s.threadId, input: [{ type: 'text', text: prompt }], cwd: s.roots[0], sandboxPolicy, approvalPolicy, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...configured?.turnOverrides });
            s.turnId = result.turn?.id; s.model = input.model || s.model; s.effort = input.effort;
            s.submissions[input.requestId] = { state: 'accepted', turnId: s.turnId };
            if (s.status === 'starting') s.status = 'running';
            this.emit(s); return { submission: s.submissions[input.requestId], session: this.view(s), warnings };
        } catch (error) {
            const unknown = dispatched && !(error as any).rpcRejected;
            s.submissions[input.requestId].state = unknown ? 'unknown' : 'rejected';
            s.status = unknown ? (s.status === 'interrupted' ? 'interrupted' : 'uncertain') : 'error'; s.error = (error as Error).message;
            this.emit(s); throw Object.assign(error as Error, { acceptanceUnknown: unknown });
        }
    }
    async interrupt(id: string, owner: string) {
        const s = this.get(id, owner);
        if (s.status === 'starting' && !s.turnId) throw new Error('Turn is starting; retry Stop shortly');
        if (s.aichatContext) this.toolBridge.cancel(owner, s.conversationId);
        if (ACTIVE.has(s.status) && s.turnId) await this.forSession(s).call('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
        return this.view(s);
    }
    async update(id: string, owner: string, input: any) {
        const s = this.get(id, owner);
        if (s.archived && input.archived === false) {
            await this.forSession(s).call('thread/unarchive', { threadId: s.threadId }); s.archived = false; this.loaded.delete(s.id);
        }
        if (typeof input.title === 'string') {
            const title = input.title.trim().slice(0, 200); if (!title) throw new Error('Title required');
            await this.forSession(s).call('thread/name/set', { threadId: s.threadId, name: title }); s.title = title;
        }
        if (typeof input.archived === 'boolean' || input.remove === true) {
            const archive = input.remove === true || input.archived;
            if (ACTIVE.has(s.status)) {
                await this.interrupt(id, owner);
                // Wait for the provider's completion event before releasing workspace ownership.
                const deadline = Date.now() + 5000;
                while (ACTIVE.has(s.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
                if (ACTIVE.has(s.status)) throw new Error('CLI has not confirmed interruption; retry archive/removal after it stops');
            }
            if (archive) await this.forSession(s).call('thread/archive', { threadId: s.threadId });
            s.archived = !!archive; s.removed = input.remove === true;
            if (archive) this.loaded.delete(s.id);
        }
        this.emit(s); return this.view(s);
    }
    respond(id: string, owner: string, input: any) {
        const s = this.get(id, owner), p = s.pending.find(p => String(p.id) === String(input.id));
        if (!p) throw new Error('Request expired or already answered');
        let result: any;
        if (p.method === 'item/tool/requestUserInput') {
            const answers: any = {};
            for (const q of p.params.questions || []) {
                const answer = input.answers?.[q.id];
                if (typeof answer !== 'string' || answer.length > 10000) throw new Error('Answer required');
                answers[q.id] = { answers: [answer] };
            }
            result = { answers };
        } else if (p.method === 'item/permissions/requestApproval') {
            result = { permissions: input.decision === 'accept' ? p.params.permissions : {}, scope: 'turn' };
        } else {
            if (!['accept','acceptForSession','decline','cancel'].includes(input.decision)) throw new Error('Invalid approval decision');
            result = { decision: input.decision };
        }
        this.forSession(s).respond(p.id, result); s.pending = s.pending.filter(x => x !== p); s.status = s.pending.length ? 'waiting' : 'running'; this.emit(s); return this.view(s);
    }
    subscribe(id: string, owner: string, listener: (event: any) => void) {
        const s = this.get(id, owner);
        let set = this.listeners.get(id); if (!set) this.listeners.set(id, set = new Set());
        if (set.size >= 8) throw new Error('Too many session viewers');
        set.add(listener); listener({ cursor: s.cursor, session: this.view(s) });
        return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(id); };
    }
    private find(params: any, backend: string) { return [...this.sessions.values()].find(s => s.backend === backend && s.threadId === (params.threadId || params.thread?.id)); }
    private request(message: any, backend: string) {
        const s = this.find(message.params || {}, backend);
        if (!s || s.pending.length >= 32 || !RESPONDABLE.has(message.method)) {
            // Unknown interactive requests cannot hang or silently gain privileges.
            this.adapterFor(backend).respond(message.id, message.method === 'item/tool/call' ? { success: false, contentItems: [] } : { decision: 'decline' }); return;
        }
        // AIChat sessions default to Full access across all adapters. ACP and
        // Claude can still request tool approval despite approvalPolicy=never.
        // Actual questions remain interactive; unknown requests stay rejected.
        if (agentMode(s.mode) === 'craft' && message.method !== 'item/tool/requestUserInput' && !message.params?.requiresUserDecision) {
            this.forSession(s).respond(message.id, message.method === 'item/permissions/requestApproval'
                ? { permissions: message.params?.permissions || {}, scope: 'turn' }
                : { decision: 'accept' });
            return;
        }
        if (s.mode === 'plan' && message.method !== 'item/tool/requestUserInput') {
            this.forSession(s).respond(message.id, message.method === 'item/permissions/requestApproval'
                ? { permissions: {}, scope: 'turn' } : { decision: message.params?.readOnly === true && !message.params?.requiresUserDecision ? 'accept' : 'decline' });
            return;
        }
        s.pending.push(bounded(message)); s.status = 'waiting'; this.emit(s);
    }
    private notification(message: any, backend: string) {
        if (['account/updated', 'account/login/completed'].includes(message.method)) { this.clearCapabilities(backend); this.adapterFor(backend).refreshCapabilities?.(); }
        if (message.method === 'model/updated') this.clearCapabilities(backend, true);
        const p = message.params || {}, s = this.find(p, backend); if (!s) return;
        if (s.retrying && (message.method === 'turn/started' || message.method === 'item/started' || message.method === 'item/completed' || message.method.endsWith('/delta') || message.method.endsWith('/outputDelta'))) {
            s.retrying = false; s.error = '';
        }
        if (message.method === 'turn/started') {
            s.turnId = p.turn?.id; s.status = 'running';
            const last = Object.values(s.submissions).at(-1);
            if (last && ['starting', 'unknown'].includes(last.state)) { last.state = 'accepted'; last.turnId = s.turnId; }
        }
        if (message.method === 'turn/completed') { s.status = p.turn?.status || 'completed'; s.pending = []; s.retrying = false; s.error = p.turn?.error?.message || ''; }
        if (message.method === 'error') { s.retrying = !!p.willRetry; s.status = p.willRetry ? (s.pending.length ? 'waiting' : 'running') : 'error'; s.error = p.error?.message || 'Codex error'; }
        if (message.method === 'serverRequest/resolved') s.pending = s.pending.filter(x => String(x.id) !== String(p.requestId));
        if (message.method === 'item/started' || message.method === 'item/completed') {
            const item = bounded(visibleItem(p.item)); if (item?.id) {
                const index = s.items.findIndex(i => i.id === item.id);
                if (index < 0) s.items.push(item); else s.items[index] = { ...s.items[index], ...item };
                s.items = s.items.slice(-2000);
            }
        }
        if (message.method.endsWith('/delta') || message.method.endsWith('/outputDelta')) {
            const item = s.items.find(i => i.id === p.itemId);
            if (item) { const key = item.type === 'commandExecution' ? 'aggregatedOutput' : 'text'; item[key] = String((item[key] || '') + (p.delta || '')).slice(-131072); }
        }
        this.emit(s, message.method.endsWith('/delta') || message.method.endsWith('/outputDelta'));
    }
    close() {
        this.toolBridge.close();
        this.closing = true;
        this.capabilities.clear();
        for (const s of this.sessions.values()) { if (ACTIVE.has(s.status)) s.status = 'interrupted'; s.pending = []; }
        if (this.sessions.size) this.save();
        for (const timer of this.flushTimers.values()) clearTimeout(timer);
        this.flushTimers.clear();
        for (const listeners of this.listeners.values()) for (const listener of listeners) listener({ closed: true });
        this.listeners.clear(); for (const adapter of Object.values(this.adapters)) adapter.close();
    }
}
