import * as http from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function presenceOriginAllowed(origin: string): boolean {
    try {
        const url = new URL(origin);
        return url.origin === origin && ((url.protocol === 'https:' && ['keepwork.com', 'cdn.keepwork.com'].includes(url.hostname))
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { return false; }
}

const SECRET = /token|password|secret|authorization|api[_-]?key|cookie/i;

export interface AichatClient {
    url: string;
    token: string;
    baseURL: string;
    seenAt: number;
    defaultExecutor?: { backend: string; model: string };
}

interface StoredClient extends AichatClient {
    sessionId: string;
}

let current: StoredClient | null = null;
const owners = new Map<string,StoredClient>();
const connectionOrder = new Map<string, number>();
let nextConnection = 0;
let brain = { order: 0, root: '' };

function validBrainPath(value: unknown): string {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
    try { return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : ''; }
    catch { return ''; }
}

/** Shared local default, independent of login ownership and periodic refresh order. */
export function latestAichatBrainRoot(): string {
    return validBrainPath(brain.root);
}

export function sanitizeClientUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AIChat page must be http(s)');
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (SECRET.test(key)) url.searchParams.delete(key);
    return url.href;
}

function sanitizeBase(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid AIChat base URL');
    return url.origin + url.pathname.replace(/\/+$/, '');
}

function sanitizeDefaultExecutor(value: { backend?: string; model?: string } | undefined) {
    const backends = ['keepwork','copilot','codex','claude','workbuddy','cursor','trae','qwen','gemini','kimi','codebuddy','opencode'];
    if (!value || !backends.includes(String(value.backend))) return undefined;
    return { backend: String(value.backend), model: typeof value.model === 'string' ? value.model.slice(0,256) : '' };
}

export function rememberAichatClient(input: { sessionId: string; url: string; token: string; baseURL?: string; owner?: string; origin?: string; handler?: boolean; brainRoot?: string; defaultExecutor?: { backend?: string; model?: string } }): void {
    if (input.handler) return;
    const token = String(input.token || '');
    if (!input.sessionId || !token || token.length > 8192) throw new Error('AIChat login required');
    current = { sessionId: input.sessionId, url: sanitizeClientUrl(input.url), token, baseURL: sanitizeBase(input.baseURL), defaultExecutor: sanitizeDefaultExecutor(input.defaultExecutor), seenAt: Date.now() };
    if (!connectionOrder.has(input.sessionId)) connectionOrder.set(input.sessionId, ++nextConnection);
    const order = connectionOrder.get(input.sessionId)!;
    const root = validBrainPath(input.brainRoot);
    if (root && order >= brain.order) brain = { order, root };
    if (/^[a-zA-Z0-9-]{32,128}$/.test(input.owner || '') && input.origin) owners.set(createHash('sha256').update(input.origin+'\0'+input.owner).digest('hex'),current);
}

/** Closing or pruning the MCP session must not drop the last page URL and login. */
export function noteAichatSessionClosed(sessionId?: string): void {
    if (sessionId) connectionOrder.delete(sessionId);
}

export function latestAichatClient(owner?: string): AichatClient | null {
    const client = owner ? owners.get(owner) : current;
    return client ? { url: client.url, token: client.token, baseURL: client.baseURL, defaultExecutor: client.defaultExecutor, seenAt: client.seenAt } : null;
}

export function aichatClientRemembered(): boolean {
    return !!current?.token;
}

export function aichatPresenceView(): { remembered: boolean } {
    return { remembered: aichatClientRemembered() };
}

export async function tryHandleAichatPresence(req: http.IncomingMessage, res: http.ServerResponse, sessionLive: (sessionId: string) => boolean, streams: Map<string, http.ServerResponse> = new Map()): Promise<boolean> {
    const pathname = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (pathname !== '/aichat/presence') return false;
    res.setHeader('Cache-Control', 'no-store');
    const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    if (!presenceOriginAllowed(String(req.headers.origin || ''))) { respond(403, { error: 'Explicit allowed Origin required' }); return true; }
    const sessionId = String(req.headers['mcp-session-id'] || '');
    if (!sessionId || !sessionLive(sessionId)) { respond(401, { error: 'Live AIChat session required' }); return true; }
    if (req.method !== 'POST') { respond(405, { error: 'Method not allowed' }); return true; }
    try {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('JSON required');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 16384) throw new Error('Request too large');
            chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string; token?: string; baseURL?: string; owner?: string; origin?: string; handler?: boolean; brainRoot?: string; defaultExecutor?: { backend?: string; model?: string } };
        rememberAichatClient({ sessionId, url: String(body?.url || ''), token: String(body?.token || ''), baseURL: body?.baseURL, handler: body?.handler === true, brainRoot: body?.brainRoot, defaultExecutor: body?.defaultExecutor, owner: body?.owner, origin: String(req.headers.origin||'') });
        if (new URL(req.url || '/', 'http://localhost').searchParams.get('stream') !== '1') {
            respond(200, aichatPresenceView());
        } else {
            streams.get(sessionId)?.end();
            streams.set(sessionId, res);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
            res.write('event: ready\ndata: {}\n\n');
            const heartbeat = setInterval(() => {
                if (!sessionLive(sessionId) || res.destroyed || res.writableEnded) { res.end(); return; }
                // An older tab must not replace the latest tab's login on each heartbeat.
                if (body?.handler !== true && current?.sessionId === sessionId) current.seenAt = Date.now();
                if (!res.write(': presence\n\n')) res.end();
            }, 25000);
            heartbeat.unref();
            res.on('close', () => {
                clearInterval(heartbeat);
                if (streams.get(sessionId) === res) streams.delete(sessionId);
            });
        }
    } catch {
        respond(400, { error: 'AIChat presence rejected' });
    }
    return true;
}
