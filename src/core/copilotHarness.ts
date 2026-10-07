import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcpHarness } from './acpHarness';
import { HarnessAdapter } from './codexHarness';
import { resolveAgentCli } from './agentCliProcess';
import { editorModels, EditorModel, ModelBridge } from './vscodeModels';

const PREFIX = 'vscode:';
export const editorModelId = (id: string) => PREFIX + Buffer.from(id).toString('base64url');
const isEditorModel = (id: unknown): id is string => typeof id === 'string' && id.startsWith(PREFIX);
const unavailable = () => Object.assign(new Error('VS Code custom model unavailable. Open VS Code with Keepwork and its model provider, then reconnect.'), { rpcRejected: true });
const switchError = () => Object.assign(new Error('Start a new Copilot chat to switch between CLI and VS Code providers, or between VS Code models. Existing history is preserved.'), { rpcRejected: true });

/** Probe help, not account/config files. An old CLI must never ignore BYOK settings
 * and silently send a custom-model prompt to its subscription default instead. */
export async function supportsCopilotByok(): Promise<boolean> {
    const launch = resolveAgentCli('copilot', ['help', 'environment', '--no-auto-update']);
    return new Promise(resolve => execFile(launch.executable, launch.args, { windowsHide: true, timeout: 10000, maxBuffer: 256000 }, (error, stdout) => {
        resolve(!error && ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_OFFLINE'].every(name => stdout.includes(name)));
    }));
}
type Discovery = { bridge?: ModelBridge; models: EditorModel[] };
type Factory = (directory: string, environment?: () => Promise<NodeJS.ProcessEnv>) => HarnessAdapter;
type Entry = { adapter: HarnessAdapter; bridge?: ModelBridge; active: Set<string> };

/** Keep native ACP intact. Custom models run in isolated BYOK CLI processes, with
 * CLI-owned tools/history and VS Code-owned inference/credentials. */
export class CopilotHarness extends EventEmitter implements HarnessAdapter {
    private native: HarnessAdapter;
    private routes: Record<string, string> = {};
    private entries = new Map<string, Entry>();
    private supported?: Promise<boolean>;
    private requests = new Map<string, { adapter: HarnessAdapter; id: string | number }>();
    constructor(private directory: string, private discover: () => Promise<Discovery> = editorModels,
        private support = supportsCopilotByok,
        private factory: Factory = (dir, environment) => new AcpHarness('copilot', dir, undefined, undefined, environment)) {
        super();
        this.native = factory(directory);
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(directory, 'editor-routes.json'), 'utf8'));
            for (const [id, model] of Object.entries(saved)) if (/^[\w-]{1,160}$/.test(id) && isEditorModel(model)) this.routes[id] = model;
        } catch { /* first use */ }
        this.connect('', { adapter: this.native, active: new Set() });
    }
    cliInfo() { return this.native.cliInfo?.(); }
    private connect(key: string, entry: Entry) {
        const adapter = entry.adapter;
        adapter.on('notification', m => {
            const id = m.params?.threadId;
            if (m.method === 'turn/started') entry.active.add(id);
            if (m.method === 'turn/completed') entry.active.delete(id);
            if (m.method === 'serverRequest/resolved') {
                const requestId = `${key || 'native'}:${m.params.requestId}`;
                this.requests.delete(requestId); m = { ...m, params: { ...m.params, requestId } };
            }
            this.emit('notification', m);
        });
        adapter.on('request', m => {
            const id = `${key || 'native'}:${m.id}`;
            this.requests.set(id, { adapter, id: m.id }); this.emit('request', { ...m, id });
        });
        adapter.on('exit', message => {
            entry.active.clear();
            for (const [id, request] of this.requests) if (request.adapter === adapter) this.requests.delete(id);
            // A failed custom process must not interrupt unrelated Copilot sessions.
            this.emit('exit', message, key ? Object.keys(this.routes).filter(id => this.routes[id] === key) : { exclude: Object.keys(this.routes) });
        });
    }
    private canBridge() { return this.supported ||= this.support().catch(() => false); }
    private async requireModel(key: string) {
        const found = await this.discover();
        const model = found.models.find(m => editorModelId(m.id) === key);
        if (!model || !found.bridge) throw unavailable();
        if (!await this.canBridge()) throw Object.assign(new Error('Update Copilot CLI to a version with BYOK provider environment support, then reconnect to use VS Code custom models.'), { rpcRejected: true });
        return { model, bridge: found.bridge };
    }
    private entry(key: string): Entry {
        let entry = this.entries.get(key);
        if (entry) return entry;
        const dir = path.join(this.directory, 'editor', createHash('sha256').update(key).digest('hex'));
        entry = { active: new Set(), adapter: this.factory(dir, async () => {
            const { model, bridge } = await this.requireModel(key);
            entry!.bridge = bridge;
            const env = { ...process.env };
            // Do not mix the user's CLI-wide BYOK settings with this private route.
            for (const name of Object.keys(env)) if (/^COPILOT_PROVIDER/i.test(name)) delete env[name];
            return { ...env, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions',
                COPILOT_OFFLINE: 'true',
                COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${bridge.port}/v1`, COPILOT_PROVIDER_API_KEY: bridge.token,
                COPILOT_MODEL: model.id, COPILOT_PROVIDER_WIRE_MODEL: model.id,
                COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(model.maxInputTokens) };
        }) };
        this.entries.set(key, entry); this.connect(key, entry); return entry;
    }
    private saveRoutes() {
        fs.mkdirSync(this.directory, { recursive: true });
        const file = path.join(this.directory, 'editor-routes.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(this.routes), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    }
    async call(method: string, p: any = {}): Promise<any> {
        const route = p.threadId && this.routes[p.threadId];
        if (method === 'model/list') {
            let native: any = { data: [] }, nativeError: unknown;
            try { native = await this.native.call(method, { ...p, threadId: route ? undefined : p.threadId, model: isEditorModel(p.model) ? undefined : p.model }); }
            catch (error) { nativeError = error; }
            const found = await this.discover().catch(() => ({ models: [] }));
            const supported = found.models.length ? await this.canBridge() : false;
            const extra = supported ? found.models.map(m => ({ id: editorModelId(m.id), displayName: `${m.name} (VS Code · ${m.vendor})`,
                source: 'vscode', isDefault: route === editorModelId(m.id), supportedReasoningEfforts: [] })) : [];
            if (nativeError && !extra.length) throw nativeError;
            return { data: [...(native.data || []).map((m: any) => route ? { ...m, isDefault: false } : m), ...extra],
                ...(found.models.length && !supported ? { modelsError: 'VS Code custom models detected. Update Copilot CLI for BYOK support, then reconnect.' } : {}),
                ...(nativeError ? { modelsError: 'Copilot subscription models unavailable; VS Code custom models are available.' } : {}) };
        }
        const key = route || (method === 'thread/start' && isEditorModel(p.model) ? p.model : undefined);
        if (p.threadId && p.model && (route ? route !== p.model : isEditorModel(p.model))) throw switchError();
        if (!key) return this.native.call(method, p);
        if (p.effort) throw Object.assign(new Error('VS Code models do not expose reasoning effort through this bridge. Clear the effort selection.'), { rpcRejected: true });
        const entry = this.entry(key);
        // Reading local history never requires an open editor or starts a process.
        if (['thread/read', 'thread/archive', 'thread/unarchive', 'thread/name/set', 'turn/interrupt'].includes(method)) return entry.adapter.call(method, p);
        const { model, bridge } = await this.requireModel(key);
        if (entry.bridge && (entry.bridge.port !== bridge.port || entry.bridge.token !== bridge.token)) {
            if (entry.active.size) throw unavailable();
            entry.adapter.close(); entry.bridge = undefined;
        }
        const result = await entry.adapter.call(method, { ...p, model: model.id, effort: undefined });
        if (method === 'thread/start') { this.routes[result.thread.id] = key; this.saveRoutes(); }
        return result;
    }
    respond(id: string | number, result: unknown) {
        const key = String(id), request = this.requests.get(key);
        if (!request) throw new Error('Copilot request expired');
        request.adapter.respond(request.id, result); this.requests.delete(key);
    }
    refreshCapabilities() {
        this.supported = undefined; this.native.refreshCapabilities?.();
        for (const entry of this.entries.values()) entry.adapter.refreshCapabilities?.();
    }
    close() { this.native.close(); for (const entry of this.entries.values()) entry.adapter.close(); this.requests.clear(); }
}
