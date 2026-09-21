import * as http from 'node:http';

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
}

interface StoredClient extends AichatClient {
    sessionId: string;
}

let current: StoredClient | null = null;

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

export function rememberAichatClient(input: { sessionId: string; url: string; token: string; baseURL?: string; handler?: boolean }): void {
    if (input.handler) return;
    const token = String(input.token || '');
    if (!input.sessionId || !token || token.length > 8192) throw new Error('AIChat login required');
    current = { sessionId: input.sessionId, url: sanitizeClientUrl(input.url), token, baseURL: sanitizeBase(input.baseURL), seenAt: Date.now() };
}

/** Closing or pruning the MCP session must not drop the last page URL and login. */
export function noteAichatSessionClosed(_sessionId?: string): void {}

export function latestAichatClient(): AichatClient | null {
    return current ? { url: current.url, token: current.token, baseURL: current.baseURL, seenAt: current.seenAt } : null;
}

export function aichatClientRemembered(): boolean {
    return !!current?.token;
}

export function aichatPresenceView(): { remembered: boolean } {
    return { remembered: aichatClientRemembered() };
}

export async function tryHandleAichatPresence(req: http.IncomingMessage, res: http.ServerResponse, sessionLive: (sessionId: string) => boolean): Promise<boolean> {
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string; token?: string; baseURL?: string; handler?: boolean };
        rememberAichatClient({ sessionId, url: String(body?.url || ''), token: String(body?.token || ''), baseURL: body?.baseURL, handler: body?.handler === true });
        respond(200, aichatPresenceView());
    } catch {
        respond(400, { error: 'AIChat presence rejected' });
    }
    return true;
}
