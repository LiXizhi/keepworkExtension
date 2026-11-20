import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Provider = { name: string; baseUrl: string; model: string; models: string[]; apiKey: string };
type SavedV1 = { name: string; baseUrl: string; model: string; apiKey: string };
type SavedV2 = { name: string; baseUrl: string; models: string[]; apiKey: string };
type DiscoveredModel = { id: string; name?: string };
type DiscoveryStatus = 'ok' | 'empty' | 'auth' | 'unreachable' | 'timeout' | 'error';

const fields = ['name', 'baseUrl', 'model', 'models', 'apiKey'];
const discoveryFields = ['baseUrl', 'apiKey'];
const MAX_MODELS = 50;
const MAX_DISCOVERED = 500;
const DISCOVERY_TIMEOUT_MS = 12_000;
const DISCOVERY_BODY_LIMIT = 2_000_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const modelId = /^[A-Za-z0-9@._~+-][A-Za-z0-9@._:/~+=-]{0,199}$/;
const safeModel = (value: unknown): value is string => typeof value === 'string' && modelId.test(value)
    && !['prototype', 'constructor', '__proto__'].includes(value);
const unsafe = /[\x00-\x1f\x7f{}]/;
export const isManagedOpenCodeModel = (model: unknown): model is string => typeof model === 'string' && /^keepwork-openai-[a-f0-9]{16}\//.test(model);

function baseUrl(value: unknown, label = 'OpenCode Base URL'): string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 2048 || unsafe.test(value)) throw new Error(`Invalid ${label}`);
    try {
        if (!/^https?:\/\//i.test(value) || /[?#\\]/.test(value)) throw new Error();
        const url = new URL(value);
        if (url.username || url.password || !url.hostname) throw new Error();
        const normalized = url.href.replace(/\/+$/, '');
        if (Buffer.byteLength(normalized) > 2048) throw new Error();
        return normalized;
    } catch { throw new Error(`${label} must be HTTP(S) without credentials, query or fragment`); }
}

function text(value: unknown, limit: number, label: string): string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || unsafe.test(value)) throw new Error(`Invalid ${label}`);
    return value.trim();
}

function modelList(input: Record<string, unknown>, fallback?: string): string[] {
    const raw = input.models;
    if (raw === undefined) {
        if (typeof fallback !== 'string' || !safeModel(fallback)) throw new Error('Invalid OpenCode model ID');
        return [fallback];
    }
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MODELS) throw new Error('Invalid OpenCode model list');
    const models: string[] = [];
    for (const item of raw) {
        if (!safeModel(item)) throw new Error('Invalid OpenCode model ID');
        if (!models.includes(item)) models.push(item);
    }
    if (!models.length) throw new Error('Invalid OpenCode model list');
    if (input.model !== undefined && input.model !== models[0]) throw new Error('OpenCode model must match the first models entry');
    return models;
}

function validate(input: unknown, previous?: Provider | null): Provider {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid OpenCode provider fields');
    const source = input as Record<string, unknown>;
    const name = text(source.name, 80, 'OpenCode provider name');
    const url = baseUrl(source.baseUrl);
    const models = modelList(source, source.model as string | undefined);
    const saved = source.apiKey === undefined && previous?.baseUrl === url ? previous.apiKey : source.apiKey;
    const apiKey = text(saved, 4096, 'OpenCode provider apiKey');
    return { name, baseUrl: url, model: models[0], models, apiKey };
}

function providerV1(value: unknown): SavedV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'baseUrl', 'model', 'apiKey'].includes(key))) throw new Error();
    const source = value as Record<string, unknown>;
    if (!safeModel(source.model)) throw new Error();
    return {
        name: text(source.name, 80, 'name'),
        baseUrl: baseUrl(source.baseUrl),
        model: source.model,
        apiKey: text(source.apiKey, 4096, 'apiKey'),
    };
}

function providerV2(value: unknown): SavedV2 {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'baseUrl', 'models', 'apiKey'].includes(key))) throw new Error();
    const source = value as Record<string, unknown>;
    return {
        name: text(source.name, 80, 'name'),
        baseUrl: baseUrl(source.baseUrl),
        models: modelList(source),
        apiKey: text(source.apiKey, 4096, 'apiKey'),
    };
}

const sameProvider = (v1: SavedV1, v2: SavedV2) => v1.name === v2.name && v1.baseUrl === v2.baseUrl
    && v1.model === v2.models[0] && v1.apiKey === v2.apiKey;

function parseJson(text: string): any {
    try { return JSON.parse(text); } catch { return undefined; }
}

function cleanName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = value.replace(/[\x00-\x1f\x7f{}]/g, '').trim();
    return name && Buffer.byteLength(name) <= 200 ? name : undefined;
}

async function readBounded(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > DISCOVERY_BODY_LIMIT) {
                await reader.cancel().catch(() => undefined);
                throw Object.assign(new Error('OpenCode model list is too large'), { code: 'UPSTREAM_INVALID' });
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock?.();
    }
    return Buffer.concat(chunks).toString('utf8');
}

function discoveryRows(value: any): any[] | null {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.models)) return value.models;
    return null;
}

function discovered(value: any): DiscoveredModel | null {
    const id = typeof value === 'string' ? value : value?.id ?? value?.name;
    if (!safeModel(id)) return null;
    const name = cleanName(value?.name ?? value?.display_name ?? value?.displayName);
    return name && name !== id ? { id, name } : { id };
}

export class OpenCodeConfig {
    private modelsFile: string;

    constructor(private file: string) {
        this.modelsFile = path.join(path.dirname(file), 'opencode-provider-v2.json');
    }

    private read(file: string): any {
        if (fs.statSync(file).size > 20_000) throw new Error();
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Object.prototype.hasOwnProperty.call(stored, 'provider')) throw new Error();
        return stored;
    }

    private loadV1(): SavedV1 | null {
        try {
            const stored = this.read(this.file);
            if (stored.version !== 1) throw new Error();
            return stored.provider === null ? null : providerV1(stored.provider);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error('Could not read the local OpenCode API configuration');
        }
    }

    private loadV2(): SavedV2 | null {
        try {
            const stored = this.read(this.modelsFile);
            if (stored.version !== 2) throw new Error();
            return stored.provider === null ? null : providerV2(stored.provider);
        } catch { return null; }
    }

    private load(): Provider | null {
        const v1 = this.loadV1();
        if (!v1) return null;
        const v2 = this.loadV2();
        if (v2 && sameProvider(v1, v2)) return { ...v2, model: v2.models[0] };
        return { ...v1, models: [v1.model] };
    }

    private write(file: string, value: unknown) {
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, file);
        } catch { throw new Error('Could not save the local OpenCode API configuration'); }
        finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
    }

    private save(provider: Provider | null) {
        if (!provider) {
            this.write(this.file, { version: 1, provider: null });
            try { fs.unlinkSync(this.modelsFile); } catch { /* no extended model list */ }
            return;
        }
        const { name, baseUrl: url, model, models, apiKey } = provider;
        if (models.length > 1) this.write(this.modelsFile, { version: 2, provider: { name, baseUrl: url, models, apiKey } });
        try {
            this.write(this.file, { version: 1, provider: { name, baseUrl: url, model, apiKey } });
        } catch (error) {
            if (models.length > 1) try { fs.unlinkSync(this.modelsFile); } catch { /* not written */ }
            throw error;
        }
        if (models.length === 1) try { fs.unlinkSync(this.modelsFile); } catch { /* no extended model list */ }
    }

    private snapshot(provider: Provider | null) {
        if (!provider) return { version: 1, provider: null };
        const { name, baseUrl: url, model, models } = provider;
        return { version: 1, provider: { name, baseUrl: url, model, models, hasApiKey: true } };
    }

    call(method: 'GET' | 'PATCH' | 'DELETE', input: unknown) {
        if (method === 'GET') return this.snapshot(this.load());
        const provider = method === 'DELETE' ? null : validate(input, this.load());
        this.save(provider);
        return this.snapshot(provider);
    }

    /** Fetch the provider's model catalog server-side so the key never reaches a
     * cross-origin browser request and CORS does not decide what the user sees. */
    async discoverModels(input: unknown): Promise<{ version: 1; status: DiscoveryStatus; models: DiscoveredModel[]; message?: string; truncated?: boolean }> {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !discoveryFields.includes(key))) throw new Error('Invalid OpenCode model discovery fields');
        const source = input as Record<string, unknown>;
        const url = baseUrl(source.baseUrl);
        if (source.apiKey !== undefined && (typeof source.apiKey !== 'string' || Buffer.byteLength(source.apiKey) > 4096 || unsafe.test(source.apiKey))) throw new Error('Invalid OpenCode provider apiKey');
        const saved = this.load();
        const apiKey = typeof source.apiKey === 'string' && source.apiKey.trim() ? source.apiKey.trim() : saved?.baseUrl === url ? saved.apiKey : '';
        if (!apiKey) throw Object.assign(new Error('OpenCode API Key required for this Base URL'), { code: 'AUTH_REQUIRED' });
        let response: Response;
        try {
            response = await fetch(`${url}/models`, {
                headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
                redirect: 'follow',
                signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            });
        } catch (error: any) {
            const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
            return { version: 1, status: timeout ? 'timeout' : 'unreachable', models: [] };
        }
        if (response.status === 401 || response.status === 403) {
            try { await response.body?.cancel(); } catch { /* ignore */ }
            return { version: 1, status: 'auth', models: [], message: `HTTP ${response.status}` };
        }
        if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* ignore */ }
            return { version: 1, status: 'error', models: [], message: `HTTP ${response.status}` };
        }
        let body: string;
        try { body = await readBounded(response); } catch (error: any) {
            return { version: 1, status: 'error', models: [], message: String(error?.message || 'Invalid response').slice(0, 200) };
        }
        const rows = discoveryRows(parseJson(body));
        if (!rows) return { version: 1, status: 'error', models: [], message: 'Invalid JSON model list' };
        const models: DiscoveredModel[] = [];
        for (const row of rows) {
            const model = discovered(row);
            if (model && !models.some(item => item.id === model.id)) models.push(model);
            if (models.length >= MAX_DISCOVERED) break;
        }
        return { version: 1, status: models.length ? 'ok' : 'empty', models, ...(rows.length > models.length && models.length >= MAX_DISCOVERED ? { truncated: true } : {}) };
    }

    launch(selected?: string) {
        const provider = this.load();
        if (!provider) return null;
        const managed = provider.models.map(model => `${'keepwork-openai-' + digest(`${provider.baseUrl}\0${model}`).slice(0, 16)}/${model}`);
        const model = selected && managed.includes(selected) ? selected : managed[0];
        const generation = digest(JSON.stringify({ ...provider, selected: model }));
        return {
            model,
            generation,
            environment: (): NodeJS.ProcessEnv => {
                let native: any;
                try {
                    native = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
                    if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error();
                    if ('provider' in native && (!native.provider || typeof native.provider !== 'object' || Array.isArray(native.provider))) throw new Error();
                } catch { throw new Error('Custom OpenCode API requires OPENCODE_CONFIG_CONTENT to be a JSON object'); }
                const envKey = 'KEEPWORK_OPENCODE_API_KEY';
                const providers: Record<string, unknown> = {};
                for (const item of provider.models) {
                    const id = 'keepwork-openai-' + digest(`${provider.baseUrl}\0${item}`).slice(0, 16);
                    providers[id] = {
                        name: provider.name,
                        npm: '@ai-sdk/openai-compatible',
                        options: { baseURL: provider.baseUrl, apiKey: `{env:${envKey}}` },
                        models: { [item]: { name: `${item} (${provider.name})` } },
                    };
                }
                native.provider = { ...native.provider, ...providers };
                return { OPENCODE_CONFIG_CONTENT: JSON.stringify(native), [envKey]: provider.apiKey };
            },
        };
    }
}
