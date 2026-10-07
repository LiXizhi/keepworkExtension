import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { WebTool } from './aichatToolBridge';

type Space = { id: string; type: string; aliases: string[]; name?: string; mountPrefix?: string; root?: string; workspace?: string; sitePath?: string; folderPath?: string; baseUrl?: string; provider?: string; host?: string; owner?: string; repo?: string; branch?: string; subPath?: string; sharePermission?: string };
type Grant = { username: string; token: string; baseURL: string; git: Record<string, string>; primaryId: string; spaces: Space[]; reads: Map<string, string | null> };
type Overlay = { revision: number; files: Record<string, { content: string; updatedAt: number; deleted?: boolean; baseHash?: string }> };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const enc = encodeURIComponent;
const isProtectedDeck = (file: string) => /^whiteboard\/(?:qa-artifacts|teach-artifacts|scenario-artifacts)\.json$/.test(file) || /^whiteboard\/lessons\/[^/]+(?:\/teach-artifacts)?\.json$/i.test(file);
const encodedPath = (v: string) => v.split('/').map(enc).join('/');
function relative(value: unknown): string {
    const raw = String(value || '').replace(/\\/g, '/');
    if (raw === '.' || raw === '/') return '';
    if (raw.startsWith('/') || /[\x00-\x1f:]/.test(raw) || raw.split('/').some(p => p === '..' || /%2e|%2f|%5c/i.test(p))) throw new Error('Invalid relative workspace path');
    return raw.split('/').filter(p => p && p !== '.').join('/');
}
export const WORKSPACE_FILE_TOOL: WebTool = {
    name: 'workspace_file', execution: 'backend',
    description: 'AIChat multi-space File Ops, available while the webpage is closed. // aliases include //.brain/ and //.calendar/. Bare paths use Primary. Local explicit roots normally use CLI native tools. Git writes stay uncommitted until the user clicks Keep in AIChat. Web-only spaces require the page online.',
    inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'search', 'read', 'write', 'replace', 'delete', 'rename'] }, path: { type: 'string' }, content: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, newPath: { type: 'string' }, query: { type: 'string' }, expectedContent: { type: ['string', 'null'] }, expectedRevision: { type: 'integer', minimum: 0 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['operation', 'path'], additionalProperties: false },
};

/** Browser-independent providers. Grants are ephemeral; only Git drafts are persisted. */
export class AichatWorkspaceFiles {
    private grants = new Map<string, Grant>();
    private tails = new Map<string, Promise<unknown>>();
    constructor(private directory: string, private fetchImpl: typeof fetch = fetch) {}
    register(owner: string, conversationId: string, value: any) {
        if (!value || !Array.isArray(value.spaces) || value.spaces.length > 100 || !/^[\w.-]{1,160}$/.test(value.username || '')) throw new Error('Invalid workspace grant');
        const url = new URL(value.baseURL || 'https://api.keepwork.com/core/v0');
        if (url.protocol !== 'https:' || !['api.keepwork.com', 'keepwork.com'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Keepwork API origin');
        const spaces = value.spaces.map((s: any): Space => {
            if (!s.id || !['project', 'git', 'url', 'cdn', 'local'].includes(s.type) || !Array.isArray(s.aliases)) throw new Error('Invalid workspace descriptor');
            const safe: any = {};
            for (const key of ['id', 'type', 'name', 'mountPrefix', 'root', 'workspace', 'sitePath', 'folderPath', 'baseUrl', 'provider', 'host', 'owner', 'repo', 'branch', 'subPath', 'sharePermission']) if (typeof s[key] === 'string') safe[key] = s[key];
            safe.aliases = s.aliases.map(String).filter((a: string) => a && !a.includes('/'));
            if (safe.type === 'local' && (!path.isAbsolute(safe.root || ''))) throw new Error('Local root must be absolute');
            if (safe.workspace) relative(safe.workspace);
            if (safe.sitePath) relative(safe.sitePath);
            if (safe.folderPath) relative(safe.folderPath);
            if (safe.type === 'git' && (!safe.branch || !/^[\w.-]+(?::\d+)?$/.test(safe.host || '') || !safe.owner || !safe.repo)) throw new Error('Resolve the Git branch before connecting');
            return safe;
        });
        const reads = this.grants.get(`${owner}:${conversationId}`)?.reads || new Map<string, string | null>();
        this.grants.set(`${owner}:${conversationId}`, { username: value.username, token: String(value.token || ''), baseURL: url.href.replace(/\/$/, ''), git: { ...(value.git || {}) }, primaryId: String(value.primaryId || ''), spaces, reads });
        return { ok: true };
    }
    snapshot(owner: string, id: string) {
        const grant = this.grants.get(`${owner}:${id}`);
        return grant ? { authorized: true, primaryId: grant.primaryId, spaces: grant.spaces.map(space => ({ ...space })) } : { authorized: false, spaces: [] };
    }
    revoke(owner: string) { for (const key of this.grants.keys()) if (key.startsWith(owner + ':')) this.grants.delete(key); }
    private grant(owner: string, id: string) { const g = this.grants.get(`${owner}:${id}`); if (!g) throw new Error('Workspace authorization expired; reconnect AIChat'); return g; }
    private route(g: Grant, input: string) {
        let file = input, space;
        if (file.startsWith('//')) {
            const slash = file.indexOf('/', 2), alias = decodeURIComponent(slash < 0 ? file.slice(2) : file.slice(2, slash));
            const exact = g.spaces.filter(s => s.aliases.includes(alias));
            const found = exact.length ? exact : g.spaces.filter(s => s.aliases.some(a => a.toLowerCase() === alias.toLowerCase()));
            if (found.length !== 1) throw new Error(found.length ? 'Ambiguous workspace alias; use its stable ID' : 'Workspace alias unavailable in the background; use the online webpage tool');
            space = found[0]; file = slash < 0 ? '' : file.slice(slash + 1);
        } else {
            space = g.spaces.find(s => s.mountPrefix && (file === s.mountPrefix || file.startsWith(s.mountPrefix + '/')));
            if (space) file = file.slice(space.mountPrefix!.length).replace(/^\/+/, '');
            else space = g.spaces.find(s => s.id === g.primaryId);
        }
        if (!space) throw new Error('Primary workspace unavailable');
        return { space, file: relative(file) };
    }
    private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(fn); this.tails.set(key, next);
        try { return await next; } finally { if (this.tails.get(key) === next) this.tails.delete(key); }
    }
    private overlayPath(owner: string, g: Grant, s: Space) { return path.join(this.directory, hash(`${owner}:${g.username}:${s.host}/${s.owner}/${s.repo}:${s.branch}:${s.subPath || ''}`) + '.json'); }
    private async overlay(owner: string, g: Grant, s: Space): Promise<Overlay> {
        try { return JSON.parse(await fs.readFile(this.overlayPath(owner, g, s), 'utf8')); } catch (e) { if ((e as any).code !== 'ENOENT') throw e; return { revision: 0, files: {} }; }
    }
    private async saveOverlay(owner: string, g: Grant, s: Space, overlay: Overlay) {
        const target = this.overlayPath(owner, g, s); await fs.mkdir(this.directory, { recursive: true });
        await fs.writeFile(target + '.tmp', JSON.stringify(overlay), { mode: 0o600 }); await fs.rename(target + '.tmp', target);
    }
    async overlayOperation(owner: string, id: string, input: any) {
        const g = this.grant(owner, id), s = g.spaces.find(s => s.id === input.spaceId && s.type === 'git');
        if (!s) throw new Error('Git space unavailable');
        return this.locked(this.overlayPath(owner, g, s), async () => {
            const overlay = await this.overlay(owner, g, s);
            if (input.operation === 'get') return overlay;
            if (input.operation === 'check') {
                for (const [file, entry] of Object.entries(input.files || {})) {
                    const draft = entry as any; const remote = await this.read(g, s, relative(file));
                    if (draft.baseHash && draft.baseHash !== (remote === null ? 'missing' : hash(remote))) throw new Error('Remote Git file changed; resolve the conflict before committing: ' + file);
                }
                return { ok: true };
            }
            if (input.operation === 'stageValidatedDeck') {
                const file = relative(input.path);
                if (s.sharePermission === 'read') throw new Error('Workspace is read-only');
                if (!isProtectedDeck(file) || typeof input.content !== 'string' || input.content.length > 2_000_000) throw new Error('Invalid protected deck');
                JSON.parse(input.content); // Domain validation has already run in the existing browser deck writer.
                if (input.revision !== overlay.revision) throw new Error('Git draft changed; refresh before saving the deck');
                const remote = overlay.files[file]?.baseHash ? null : await this.read(g, s, file);
                overlay.files[file] = { content: input.content, baseHash: overlay.files[file]?.baseHash || (remote === null ? 'missing' : hash(remote)), updatedAt: Math.max(Date.now(), (overlay.files[file]?.updatedAt || 0) + 1) };
            } else if (input.operation === 'import') {
                if (s.sharePermission === 'read' && Object.keys(input.files || {}).length) throw new Error('Workspace is read-only');
                for (const [name, entry] of Object.entries(input.files || {})) {
                    const file = relative(name), content = (entry as any)?.content;
                    if (!file || typeof content !== 'string' || content.length > 2_000_000) throw new Error('Only text Git drafts can be transferred');
                    if (overlay.files[file] && (overlay.files[file].content !== content || !!overlay.files[file].deleted !== !!(entry as any).deleted)) throw new Error('Git draft conflict; preserve both drafts before connecting');
                    const remote = !overlay.files[file] ? await this.read(g, s, file) : null;
                    if (!overlay.files[file]) overlay.files[file] = { content, baseHash: remote === null ? 'missing' : hash(remote), updatedAt: (entry as any).updatedAt || Date.now(), ...((entry as any).deleted ? { deleted: true } : {}) };
                }
            } else if (input.operation === 'ack') {
                for (const [file, entry] of Object.entries(input.files || {})) {
                    const current = overlay.files[file], committed = entry as any;
                    if (current && current.content === committed.content && current.updatedAt === committed.updatedAt && !!current.deleted === !!committed.deleted) delete overlay.files[file];
                }
            } else if (input.operation === 'drop') {
                if (input.revision !== overlay.revision) throw new Error('Git draft changed; refresh before discarding');
                if (input.path) delete overlay.files[relative(input.path)]; else overlay.files = {};
            } else throw new Error('Unknown overlay operation');
            overlay.revision++; await this.saveOverlay(owner, g, s, overlay); return overlay;
        });
    }
    private async response(url: string, headers: Record<string, string>, method = 'GET', body?: unknown) {
        const response = await this.fetchImpl(url, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw Object.assign(new Error(`Workspace service HTTP ${response.status}`), { status: response.status });
        const raw = await response.text(); if (raw.length > 4_000_000) throw new Error('File response too large');
        if (response.headers.get('content-type')?.includes('json')) { try { return JSON.parse(raw); } catch { /* plain */ } }
        return raw;
    }
    private writable(s: Space, file: string) {
        if (s.sharePermission === 'read' || ['url', 'cdn'].includes(s.type)) throw new Error('Workspace is read-only');
        if (isProtectedDeck(file)) throw new Error('Use the online saveWhiteboardDeck tool for protected whiteboard files');
    }
    private kwHeaders(g: Grant): Record<string, string> { return g.token ? { Authorization: `Bearer ${g.token}` } : {}; }
    private kwLocation(g: Grant, s: Space, file: string) {
        const site = s.type === 'project' ? `${g.username}/edunotes` : s.sitePath!;
        const base = s.type === 'project' ? `store/${s.workspace}` : s.folderPath || '';
        const raw = /\.[^./]+$/.test(file) && !/\.md$/i.test(file);
        const leaf = file && !raw && !/\.md$/i.test(file) ? file + '.md' : file;
        const full = [site, base, leaf].filter(Boolean).join('/');
        return { site, base, full, raw, endpoint: `${g.baseURL}/pageCache/${enc(site)}/files/${enc(full)}` };
    }
    private async gitRequest(g: Grant, s: Space, route: string, accept = '') {
        const base = s.provider === 'github' ? 'https://api.github.com' : s.provider === 'bitbucket' ? 'https://api.bitbucket.org/2.0' : `https://${s.host}/api/${s.provider === 'gitlab' ? 'v4' : s.provider === 'gitee' ? 'v5' : 'v1'}`;
        const credential = g.git[s.host!] || '';
        const headers: Record<string, string> = accept ? { Accept: accept } : {};
        if (credential && s.provider !== 'gitee') headers[s.provider === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization'] = s.provider === 'gitlab' ? credential : s.provider === 'gitea' ? `token ${credential}` : s.provider === 'bitbucket' && credential.includes(':') ? `Basic ${Buffer.from(credential).toString('base64')}` : `Bearer ${credential}`;
        return this.response(base + route + (credential && s.provider === 'gitee' ? `${route.includes('?') ? '&' : '?'}access_token=${enc(credential)}` : ''), headers);
    }
    private async disk(s: Space, file: string, writing = false) {
        const root = await fs.realpath(s.root!), target = path.resolve(root, file);
        const inside = (p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
        if (!inside(target)) throw new Error('Workspace path outside root');
        let probe = target;
        while (true) { try { if (!inside(await fs.realpath(probe))) throw new Error('Workspace link outside root'); break; } catch (e) { if ((e as any).code !== 'ENOENT' || !writing || probe === root) throw e; probe = path.dirname(probe); } }
        return target;
    }
    private async read(g: Grant, s: Space, file: string): Promise<string | null> {
        try {
            if (s.type === 'local') return await fs.readFile(await this.disk(s, file), 'utf8');
            if (s.type === 'git') {
                const full = [s.subPath, file].filter(Boolean).join('/'), ref = enc(s.branch!), repo = `${s.owner}/${s.repo}`;
                const route = s.provider === 'gitlab' ? `/projects/${enc(repo)}/repository/files/${enc(full)}/raw?ref=${ref}` : s.provider === 'bitbucket' ? `/repositories/${repo}/src/${ref}/${encodedPath(full)}` : `/repos/${repo}/${s.provider === 'gitea' ? 'raw' : 'contents'}/${encodedPath(full)}?ref=${ref}`;
                const value = await this.gitRequest(g, s, route, s.provider === 'github' ? 'application/vnd.github.raw+json' : '');
                return s.provider === 'gitee' ? Buffer.from(value.content || '', 'base64').toString('utf8') : typeof value === 'string' ? value : JSON.stringify(value);
            }
            if (s.type === 'cdn') return String(await this.response(new URL(encodedPath(file), s.baseUrl).href, {}));
            const loc = this.kwLocation(g, s, file);
            let value;
            try { value = await this.response(loc.endpoint, this.kwHeaders(g)); }
            catch (e) { if ((e as any).status !== 404) throw e; value = await this.response(`${g.baseURL}/repos/${enc(loc.site)}/files/${enc(loc.full)}/raw`, this.kwHeaders(g)); }
            const raw = typeof value === 'string' ? value : String(value?.content ?? '');
            return s.type === 'project' && !loc.raw ? this.unpack(raw).content : raw;
        } catch (e) { if ((e as any).status === 404 || (e as any).code === 'ENOENT') return null; throw e; }
    }
    private unpack(raw: string) {
        const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
        return { header: match?.[1] || '', content: match ? match[2] : raw };
    }
    private async list(g: Grant, s: Space, folder: string): Promise<string[]> {
        if (s.type === 'local') return (await fs.readdir(await this.disk(s, folder), { withFileTypes: true })).slice(0, 1000).map(e => e.name + (e.isDirectory() ? '/' : ''));
        if (s.type === 'cdn') throw new Error('URL source does not provide a directory manifest');
        if (s.type !== 'git') {
            const loc = this.kwLocation(g, s, '');
            const values = await this.response(`${g.baseURL}/repos/${enc(loc.site)}/tree?folderPath=${enc([loc.site, loc.base, folder].filter(Boolean).join('/'))}&recursive=false`, this.kwHeaders(g));
            if (!Array.isArray(values)) throw new Error('Invalid workspace tree');
            return values.slice(0, 1000).map((e: any) => e.name + (e.isTree ? '/' : ''));
        }
        const repo = `${s.owner}/${s.repo}`, full = [s.subPath, folder].filter(Boolean).join('/'), ref = enc(s.branch!);
        let route: string;
        if (s.provider === 'gitlab') route = `/projects/${enc(repo)}/repository/tree?ref=${ref}&path=${enc(full)}&per_page=100`;
        else if (s.provider === 'bitbucket') route = `/repositories/${repo}/src/${ref}/${encodedPath(full)}?pagelen=100`;
        else route = `/repos/${repo}/contents/${encodedPath(full)}?ref=${ref}`;
        const entries: any[] = [];
        for (let page = 1; page <= 11; page++) {
            const result = await this.gitRequest(g, s, route + (['gitlab', 'bitbucket'].includes(s.provider!) ? '&page=' + page : ''));
            const values = Array.isArray(result) ? result : result.values;
            if (!Array.isArray(values)) throw new Error('Invalid Git directory response');
            entries.push(...values);
            if (entries.length > 1000) throw new Error('Directory exceeds 1000 entries; select a narrower subfolder');
            if (s.provider === 'gitlab' ? values.length < 100 : s.provider === 'bitbucket' ? !result.next : true) break;
        }
        return entries.map((e: any) => (e.name || e.path.split('/').pop()) + (['dir', 'tree', 'commit_directory'].includes(e.type) ? '/' : ''));
    }
    async execute(owner: string, id: string, args: any) {
        const g = this.grant(owner, id), { space: s, file } = this.route(g, args.path);
        const key = s.type === 'git' ? this.overlayPath(owner, g, s) : `${owner}:${s.id}`;
        return this.locked(key, async () => {
            const overlay = s.type === 'git' ? await this.overlay(owner, g, s) : null;
            const readPath = async (target: string) => overlay?.files[target] ? (overlay.files[target].deleted ? null : overlay.files[target].content) : this.read(g, s, target);
            const read = () => readPath(file);
            if (args.expectedRevision !== undefined && overlay?.revision !== args.expectedRevision) throw new Error('Git draft changed; read again before editing');
            const observedKey = `${s.id}:${file}`;
            const write = async (content: string, targetFile = file) => {
                const file = targetFile;
                this.writable(s, file);
                if (content.length > 2_000_000) throw new Error('File too large');
                if (s.sharePermission === 'read' || ['url', 'cdn'].includes(s.type)) throw new Error('Workspace is read-only');
                
                if (overlay) { const remote = overlay.files[file]?.baseHash ? null : await this.read(g, s, file); overlay.files[file] = { content, baseHash: overlay.files[file]?.baseHash || (remote === null ? 'missing' : hash(remote)), updatedAt: Math.max(Date.now(), (overlay.files[file]?.updatedAt || 0) + 1) }; return; }
                if (s.type === 'local') { const target = await this.disk(s, file, true); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return; }
                const loc = this.kwLocation(g, s, file);
                let payload = content;
                if (!loc.raw) {
                    let raw: any = ''; try { raw = await this.response(loc.endpoint, this.kwHeaders(g)); } catch (e) { if ((e as any).status !== 404) throw e; }
                    const header = this.unpack(typeof raw === 'string' ? raw : String(raw?.content || '')).header;
                    const version = Number(/(?:^|\n)\s+version:\s*(\d+)/.exec(header)?.[1] || 0) + 1;
                    const preserved = header.replace(/(?:^|\n)_metadata:\n(?:[ \t]+[^\n]*(?:\n|$))*/g, '\n').trim();
                    const created = /(?:^|\n)\s+created_at:\s*([^\n]+)/.exec(header)?.[1];
                    const now = new Date().toISOString().replace('T', '-').replace(/\..+/, '');
                    payload = `---\n${preserved ? preserved + '\n' : ''}_metadata:\n  version: ${version}\n  created_at: ${created || JSON.stringify(now)}\n  updated_at: "${now}"\n---\n${content}`;
                }
                if (!g.token) throw new Error('Keepwork login required');
                await this.response(loc.endpoint, this.kwHeaders(g), 'PUT', { router_params: { repoPath: enc(loc.site), filePath: enc(loc.full) }, content: payload });
                if (await this.read(g, s, file) !== content) throw new Error('Cloud write result could not be verified; do not repeat automatically');
            };
            let result: any;
            if (args.operation === 'list' || args.operation === 'search') {
                if (args.operation === 'search') {
                    const pending = [file], matches: string[] = [], seen = new Set<string>(); let scanned = 0;
                    while (pending.length && scanned < 1000 && seen.size < 100) {
                        const folder = pending.shift()!; if (seen.has(folder)) continue; seen.add(folder);
                        let children: string[];
                        try { children = await this.list(g, s, folder); } catch (error) { if ((error as any).status !== 404) throw error; children = []; }
                        const prefix = folder ? folder + '/' : '';
                        for (const [name, entry] of Object.entries(overlay?.files || {})) if (!entry.deleted && name.startsWith(prefix)) { const rest = name.slice(prefix.length); children.push(rest.includes('/') ? rest.split('/')[0] + '/' : rest); }
                        for (const child of new Set(children)) {
                            if (++scanned > 1000) break; const name = prefix + child;
                            if (child.endsWith('/')) pending.push(name.slice(0, -1));
                            else if (!overlay?.files[name]?.deleted && name.toLowerCase().includes(String(args.query || '').toLowerCase())) matches.push(name);
                        }
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ matches: matches.slice(0, 200), truncated: !!pending.length || scanned >= 1000 || matches.length > 200 }) }] };
                }
                let entries: string[];
                try { entries = await this.list(g, s, file); } catch (error) { if (!overlay || (error as any).status !== 404) throw error; entries = []; }
                const prefix = file ? file + '/' : '';
                for (const entry of Object.keys(overlay?.files || {})) if (entry.startsWith(prefix) && !overlay?.files[entry].deleted) { const rest = entry.slice(prefix.length), slash = rest.indexOf('/'); entries.push(slash < 0 ? rest : rest.slice(0, slash + 1)); }
                result = [...new Set(entries)].filter(e => !overlay?.files[prefix + e]?.deleted).filter(e => args.operation !== 'search' || e.toLowerCase().includes(String(args.query || '').toLowerCase())).sort();
            } else {
                if (!file) throw new Error('File path required');
                const current = await read();
                if ('expectedContent' in args && args.expectedContent !== current) throw new Error('File changed; read again before editing');
                if (['write', 'delete', 'rename'].includes(args.operation) && !('expectedContent' in args) && args.expectedRevision === undefined && current !== null && (!g.reads.has(observedKey) || g.reads.get(observedKey) !== hash(current))) throw new Error('File changed or not read in this session; read before editing');
                if (args.operation === 'read') {
                    if (current === null) throw new Error('File not found');
                    g.reads.set(observedKey, hash(current));
                    const lines = current.split('\n'), start = Math.max(1, args.startLine || 1), end = Math.min(lines.length, args.endLine || start + 199, start + 999);
                    result = { content: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end, totalLines: lines.length, ...(overlay ? { revision: overlay.revision } : {}) };
                } else if (args.operation === 'write') { if (typeof args.content !== 'string') throw new Error('content required'); await write(args.content); result = { written: true, staged: !!overlay }; }
                else if (args.operation === 'replace') {
                    if (!args.oldString || typeof args.newString !== 'string' || current === null || current.split(args.oldString).length !== 2) throw new Error('oldString must match exactly once');
                    await write(current.replace(args.oldString, args.newString)); result = { written: true, staged: !!overlay };
                } else if (args.operation === 'delete' || args.operation === 'rename') {
                    this.writable(s, file);
                    if (current === null) throw new Error('File not found');
                    if (args.operation === 'rename') {
                        if (typeof args.newPath !== 'string') throw new Error('newPath required');
                        const destination = args.newPath.startsWith('//') ? this.route(g, args.newPath) : { space: s, file: relative(args.newPath) };
                        if (destination.space.id !== s.id || !destination.file || destination.file === file) throw new Error('Rename must stay in the same space with a distinct destination');
                        this.writable(s, destination.file);
                        if (await readPath(destination.file) !== null) throw new Error('Destination already exists');
                        await write(current, destination.file);
                    }
                    if (overlay) { const remote = overlay.files[file]?.baseHash ? null : await this.read(g, s, file); overlay.files[file] = { content: '', deleted: true, baseHash: overlay.files[file]?.baseHash || (remote === null ? 'missing' : hash(remote)), updatedAt: Math.max(Date.now(), (overlay.files[file]?.updatedAt || 0) + 1) }; }
                    else if (s.type === 'local') await fs.unlink(await this.disk(s, file));
                    else {
                        if (!g.token) throw new Error('Keepwork login required');
                        const loc = this.kwLocation(g, s, file);
                        await this.response(loc.endpoint + '/purge', this.kwHeaders(g), 'DELETE').catch(error => { if (error.status !== 404) throw error; });
                        await this.response(`${g.baseURL}/repos/${enc(loc.site)}/files/${enc(loc.full)}`, this.kwHeaders(g), 'DELETE').catch(error => { if (error.status !== 404) throw error; });
                    }
                    result = { [args.operation === 'rename' ? 'renamed' : 'deleted']: true, staged: !!overlay };
                } else throw new Error('Unknown file operation');
            }
            if (['write', 'replace', 'delete', 'rename'].includes(args.operation)) { const final = await read(); g.reads.set(observedKey, final === null ? null : hash(final)); }
            if (overlay && ['write', 'replace', 'delete', 'rename'].includes(args.operation)) { overlay.revision++; await this.saveOverlay(owner, g, s, overlay); }
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        });
    }
}
