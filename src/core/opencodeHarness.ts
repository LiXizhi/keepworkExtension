import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AcpHarness } from './acpHarness';
import { HarnessAdapter } from './codexHarness';
import { isManagedOpenCodeModel, OpenCodeConfig } from './opencodeConfig';

type Launch = NonNullable<ReturnType<OpenCodeConfig['launch']>>;
type Process = { model?: string; generation?: string; cli: AcpHarness; threads: Set<string>; calls: number };
const changed = () => Object.assign(new Error('The saved OpenCode provider changed. Select its current model in a new conversation.'), { rpcRejected: true });

/** Native sessions keep their default environment. Only sessions selecting the
 * managed model and prompt-free discovery receive the private provider. */
export class OpenCodeHarness extends EventEmitter implements HarnessAdapter {
    private native: AcpHarness;
    private processes = new Map<string, Process>();
    private isolated = new Set<Process>();
    private threads = new Map<string, Process>();
    private requests = new Map<string, { cli: AcpHarness; id: string | number }>();

    constructor(private directory: string, private config: OpenCodeConfig, private canSuspend: (threadId: string) => boolean) {
        super();
        this.native = new AcpHarness('opencode', directory);
        this.connect(this.native);
    }

    private connect(cli: AcpHarness, entry?: Process) {
        cli.on('notification', message => this.emit('notification', message));
        cli.on('request', message => {
            const id = randomUUID();
            this.requests.set(id, { cli, id: message.id });
            this.emit('request', { ...message, id });
        });
        cli.on('exit', message => {
            for (const [id, request] of this.requests) if (request.cli === cli) this.requests.delete(id);
            const scope = entry ? [...entry.threads] : { exclude: [...this.threads.keys()] };
            if (entry) {
                for (const id of entry.threads) this.threads.delete(id);
                for (const [key, process] of this.processes) if (process === entry) this.processes.delete(key);
                this.isolated.delete(entry);
            }
            this.emit('exit', message, scope);
        });
    }

    cliInfo() { return this.native.cliInfo(); }

    private process(config: Launch) {
        const entry = this.processes.get(config.generation);
        if (entry) return entry;
        this.discardPreviews(config.generation);
        const preview = this.startProcess(config);
        this.processes.set(config.generation, preview);
        return preview;
    }

    private startProcess(config: Launch | null, cwd?: string): Process {
        if (this.processes.size + this.isolated.size >= 32) {
            const idle = [...this.isolated].find(entry => !entry.calls && entry.cli.canReleaseSession()
                && [...entry.threads].every(this.canSuspend)
                && this.canRestore(entry));
            if (!idle) throw new Error('OpenCode CLI process limit reached');
            idle.cli.close();
        }
        const cli = new AcpHarness('opencode', this.directory, undefined, undefined,
            config ? async () => config.environment() : undefined, undefined, cwd);
        const entry = { model: config?.model, generation: config?.generation, cli, threads: new Set<string>(), calls: 0 };
        this.connect(cli, entry);
        if (cwd) this.isolated.add(entry);
        return entry;
    }

    private canRestore(entry: Process) {
        try { return !entry.generation || this.config.launch(entry.model)?.generation === entry.generation; }
        catch { return false; }
    }

    private discardPreviews(current?: string) {
        for (const [generation, entry] of this.processes) {
            if (generation !== current && !entry.threads.size && !entry.calls) {
                this.processes.delete(generation); entry.cli.close();
            }
        }
    }

    async call(method: string, params: any = {}) {
        if (method === 'config/models') return this.config.discoverModels(params);
        if (method.startsWith('config/')) {
            const action = method.slice(7);
            if (action !== 'GET' && action !== 'PATCH' && action !== 'DELETE') throw new Error('Unknown OpenCode configuration operation');
            const snapshot = this.config.call(action, params);
            if (action !== 'GET') this.discardPreviews();
            return snapshot;
        }
        const bound = this.threads.get(params.threadId);
        if (method === 'thread/read') return (bound?.cli || this.native).call(method, params);
        const preview = method === 'model/list' && !params.threadId && params.includeManagedOpenCode;
        const model = method === 'thread/start' ? params.model : params.routeModel;
        const config = !bound && (preview || isManagedOpenCodeModel(model)) ? this.config.launch(isManagedOpenCodeModel(model) ? model : undefined) : null;
        if (!bound && isManagedOpenCodeModel(model) && config?.model !== model) throw changed();
        // OpenCode's ACP MCP registry is shared by sessions in one process.
        // Keep each conversation's bridge capability in a dedicated process.
        const bindsContext = (method === 'thread/start' || method === 'thread/resume') && params.mcpServers?.length;
        const isolated = !bound && bindsContext ? this.startProcess(config, params.cwd) : undefined;
        const entry = bound || isolated || (config ? this.process(config) : undefined);
        if (!entry) {
            if (isManagedOpenCodeModel(params.model)) throw changed();
            return this.native.call(method, params);
        }
        if (!preview && params.model && params.model !== entry.model && (entry.model || isManagedOpenCodeModel(params.model))) throw changed();
        const options = preview ? { ...params, model: undefined, catalogKey: params.catalogKey || 'opencode-api' } : params;
        entry.calls++;
        try {
            const result = await entry.cli.call(method, options);
            if (method === 'thread/start' || method === 'thread/resume') {
                const id = result.thread.id;
                entry.threads.add(id); this.threads.set(id, entry);
            }
            const managedPrefix = entry.model ? entry.model.split('/')[0] + '/' : '';
            return preview ? { ...result, data: result.data.map((model: any) => managedPrefix && isManagedOpenCodeModel(model.id) && model.id.startsWith(managedPrefix) ? { ...model, isDefault: false } : model) } : result;
        } catch (error) {
            if (isolated) { this.isolated.delete(isolated); isolated.cli.close(); }
            throw error;
        } finally { entry.calls--; }
    }

    respond(id: string | number, result: unknown) {
        const request = this.requests.get(String(id));
        if (!request) throw new Error('OpenCode approval expired');
        request.cli.respond(request.id, result); this.requests.delete(String(id));
    }

    refreshCapabilities() {
        this.native.refreshCapabilities();
        for (const entry of this.processes.values()) entry.cli.refreshCapabilities();
    }

    close() {
        this.native.close();
        for (const entry of this.processes.values()) entry.cli.close();
        for (const entry of this.isolated) entry.cli.close();
        this.processes.clear(); this.isolated.clear(); this.threads.clear(); this.requests.clear();
    }
}
