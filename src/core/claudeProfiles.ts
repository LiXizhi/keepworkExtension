import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Profile = {
    id: string; name: string; baseUrl: string; authType: 'apiKey' | 'authToken'; secret: string;
    model?: string; sonnetModel?: string; opusModel?: string; haikuModel?: string;
};
type State = { version: 1; revision: number; activeProfileId: string | null; profiles: Profile[] };
const fields = ['name', 'baseUrl', 'authType', 'secret', 'model', 'sonnetModel', 'opusModel', 'haikuModel'];
const models = ['model', 'sonnetModel', 'opusModel', 'haikuModel'] as const;
const modelEnv = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];

/** Local, write-only credentials for harness-owned Claude processes. No native settings are edited. */
export class ClaudeProfiles {
    private state: State;
    constructor(private file: string) {
        try {
            const stat = fs.statSync(file);
            if (stat.size > 512_000) throw new Error();
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.profiles) || saved.profiles.length > 50) throw new Error();
            const profiles = saved.profiles.map((p: any) => {
                if (!p || typeof p.id !== 'string' || !/^[\w-]{1,160}$/.test(p.id)) throw new Error();
                const { id, ...input } = p;
                return { id, ...this.validate(input) };
            });
            if (new Set(profiles.map((p: Profile) => p.id)).size !== profiles.length
                || (saved.activeProfileId !== null && !profiles.some((p: Profile) => p.id === saved.activeProfileId))) throw new Error();
            this.state = { version: 1, revision: saved.revision, activeProfileId: saved.activeProfileId, profiles };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read Claude profiles; repair the local configuration before changing providers');
            this.state = { version: 1, revision: 0, activeProfileId: null, profiles: [] };
        }
    }
    private validate(input: any, previous?: Profile): Omit<Profile, 'id'> {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid Claude profile fields');
        const value = { ...previous, ...input };
        const string = (key: string, max: number, required = true) => {
            const raw = value[key];
            if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > max || (required && !raw.trim())) throw new Error(`Invalid Claude profile ${key}`);
            return raw.trim();
        };
        const name = string('name', 80), baseUrl = string('baseUrl', 2048);
        try {
            const url = new URL(baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { throw new Error('Claude baseUrl must be an HTTP(S) URL without credentials, query or fragment'); }
        if (!['apiKey', 'authToken'].includes(value.authType)) throw new Error('Invalid Claude profile authType');
        const secret = string('secret', 4096);
        const result: Omit<Profile, 'id'> = { name, baseUrl, authType: value.authType, secret };
        for (const key of models) {
            if (value[key] === undefined) continue;
            const model = string(key, 200, false);
            if (model) result[key] = model;
        }
        return result;
    }
    private commit(next: State) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        try {
            const serialized = JSON.stringify(next);
            if (Buffer.byteLength(serialized, 'utf8') > 512_000) throw new Error();
            fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, this.file);
        } catch {
            throw new Error('Could not save Claude profiles; the previous configuration is unchanged');
        } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
        this.state = next;
        return this.snapshot();
    }
    snapshot() {
        return { version: 1, activeProfileId: this.state.activeProfileId,
            profiles: this.state.profiles.map(({ secret, ...profile }) => ({ ...profile, hasSecret: !!secret })) };
    }
    get key() {
        const active = this.state.profiles.find(p => p.id === this.state.activeProfileId);
        return active ? createHash('sha256').update(JSON.stringify(active)).digest('hex') : 'native';
    }
    configuredModels() {
        const active = this.state.profiles.find(p => p.id === this.state.activeProfileId);
        return active ? models.flatMap(key => active[key] ? [{ value: active[key], displayName: active[key], isDefault: key === 'model' }] : []) : [];
    }
    create(input: any) {
        if (this.state.profiles.length >= 50) throw new Error('Claude profile limit reached (50)');
        const profile = { id: randomUUID(), ...this.validate(input) };
        return this.commit({ ...this.state, revision: this.state.revision + 1, profiles: [...this.state.profiles, profile] });
    }
    update(id: string, input: any) {
        const previous = this.state.profiles.find(p => p.id === id);
        if (!previous) throw new Error('Claude profile not found');
        const profile = { id, ...this.validate(input, previous) };
        return this.commit({ ...this.state, revision: this.state.revision + 1, profiles: this.state.profiles.map(p => p.id === id ? profile : p) });
    }
    remove(id: string) {
        if (!this.state.profiles.some(p => p.id === id)) throw new Error('Claude profile not found');
        if (this.state.activeProfileId === id) throw new Error('Switch to another Claude profile or native configuration before deleting the active profile');
        return this.commit({ ...this.state, revision: this.state.revision + 1, profiles: this.state.profiles.filter(p => p.id !== id) });
    }
    activate(profileId: string | null) {
        if (profileId !== null && !this.state.profiles.some(p => p.id === profileId)) throw new Error('Claude profile not found');
        return this.commit({ ...this.state, revision: this.state.revision + 1, activeProfileId: profileId });
    }
    private providerEnvironment(): Record<string, string> | undefined {
        const profile = this.state.profiles.find(p => p.id === this.state.activeProfileId);
        if (!profile) return;
        return {
            ANTHROPIC_BASE_URL: profile.baseUrl,
            ANTHROPIC_API_KEY: profile.authType === 'apiKey' ? profile.secret : '',
            ANTHROPIC_AUTH_TOKEN: profile.authType === 'authToken' ? profile.secret : '',
            CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
            ANTHROPIC_CUSTOM_HEADERS: '', ANTHROPIC_SMALL_FAST_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL: '',
            ANTHROPIC_DEFAULT_MODEL: '', ANTHROPIC_DEFAULT_FABLE_MODEL: '',
            CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
            CLAUDE_CODE_USE_ANTHROPIC_AWS: '0', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0', CLAUDE_CODE_USE_MANTLE: '0',
            ...Object.fromEntries(models.map((key, i) => [modelEnv[i], profile[key] || ''])),
        };
    }
    environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const overrides = this.providerEnvironment();
        if (!overrides) return { ...base };
        const names = new Set(Object.keys(overrides));
        return { ...Object.fromEntries(Object.entries(base).filter(([key]) => !names.has(key.toUpperCase()))), ...overrides };
    }
    /** CLI settings env overrides native settings env; secrets never enter argv. Managed policy still wins. */
    launch(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; args: string[]; cleanup: () => void } {
        const overrides = this.providerEnvironment();
        if (!overrides) return { env: { ...base }, args: [], cleanup() {} };
        const directory = path.join(path.dirname(this.file), 'claude-launch');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = fs.mkdtempSync(path.join(directory, 'provider-'));
        const cleanup = () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort after exit */ } };
        try {
            const settings = path.join(temporary, 'settings.json');
            const active = this.state.profiles.find(p => p.id === this.state.activeProfileId)!;
            fs.writeFileSync(settings, JSON.stringify({ env: overrides, model: active.model || 'default', apiKeyHelper: '' }), { mode: 0o600, flag: 'wx' });
            return { env: this.environment(base), args: ['--settings', settings], cleanup };
        } catch { cleanup(); throw new Error('Could not prepare private Claude provider settings'); }
    }
}
