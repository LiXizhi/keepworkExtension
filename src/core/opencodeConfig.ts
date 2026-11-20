import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Provider = { name: string; baseUrl: string; model: string; apiKey: string };
const fields = ['name', 'baseUrl', 'model', 'apiKey'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const isManagedOpenCodeModel = (model: unknown): model is string => typeof model === 'string' && /^keepwork-openai-[a-f0-9]{16}\//.test(model);

function validate(input: unknown, previous?: Provider | null): Provider {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid OpenCode provider fields');
    const source = input as Record<string, unknown>;
    const value = (key: string, limit: number, raw = source[key]) => {
        if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > limit || /[\x00-\x1f\x7f{}]/.test(raw)) throw new Error(`Invalid OpenCode provider ${key}`);
        return raw.trim();
    };
    const name = value('name', 80);
    const model = value('model', 200);
    if (!/^[A-Za-z0-9@._~+-][A-Za-z0-9@._:/~+=-]*$/.test(model) || ['constructor', 'prototype', '__proto__'].includes(model)) throw new Error('Invalid OpenCode model ID');
    const rawUrl = value('baseUrl', 2048);
    let baseUrl: string;
    try {
        if (!/^https?:\/\//i.test(rawUrl) || /[?#\\]/.test(rawUrl)) throw new Error();
        const url = new URL(rawUrl);
        if (url.username || url.password || !url.hostname) throw new Error();
        baseUrl = url.href.replace(/\/+$/, '');
        if (Buffer.byteLength(baseUrl) > 2048) throw new Error();
    } catch { throw new Error('OpenCode Base URL must be HTTP(S) without credentials, query or fragment'); }
    const apiKey = value('apiKey', 4096, source.apiKey === undefined && previous?.baseUrl === baseUrl ? previous.apiKey : source.apiKey);
    return { name, baseUrl, model, apiKey };
}

export class OpenCodeConfig {
    constructor(private file: string) {}

    private load(): Provider | null {
        try {
            if (fs.statSync(this.file).size > 20_000) throw new Error();
            const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (stored.version !== 1 || !Object.prototype.hasOwnProperty.call(stored, 'provider')) throw new Error();
            return stored.provider === null ? null : validate(stored.provider);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error('Could not read the local OpenCode API configuration');
        }
    }

    private snapshot(provider: Provider | null) {
        if (!provider) return { version: 1, provider: null };
        const { name, baseUrl, model } = provider;
        return { version: 1, provider: { name, baseUrl, model, hasApiKey: true } };
    }

    call(method: 'GET' | 'PATCH' | 'DELETE', input: unknown) {
        if (method === 'GET') return this.snapshot(this.load());
        const provider = method === 'DELETE' ? null : validate(input, this.load());
        const temp = `${this.file}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify({ version: 1, provider }), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, this.file);
        } catch { throw new Error('Could not save the local OpenCode API configuration'); }
        finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
        return this.snapshot(provider);
    }

    launch() {
        const provider = this.load();
        if (!provider) return null;
        const { name, baseUrl, model, apiKey } = provider;
        const id = 'keepwork-openai-' + digest(`${baseUrl}\0${model}`).slice(0, 16);
        return {
            model: `${id}/${model}`,
            generation: digest(JSON.stringify(provider)),
            environment: (): NodeJS.ProcessEnv => {
                let native: any;
                try {
                    native = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
                    if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error();
                    if ('provider' in native && (!native.provider || typeof native.provider !== 'object' || Array.isArray(native.provider))) throw new Error();
                } catch { throw new Error('Custom OpenCode API requires OPENCODE_CONFIG_CONTENT to be a JSON object'); }
                const envKey = 'KEEPWORK_OPENCODE_API_KEY';
                const settings = { baseURL: baseUrl, apiKey: `{env:${envKey}}` };
                const models = { [model]: { name: `${model} (${name})` } };
                native.provider = { ...native.provider, [id]: { name, npm: '@ai-sdk/openai-compatible', options: settings, models } };
                return { OPENCODE_CONFIG_CONTENT: JSON.stringify(native), [envKey]: apiKey };
            },
        };
    }
}
