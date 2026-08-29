import type * as http from 'node:http';
import {
    enqueueHttpRequest,
    getClientIdForWebserverInstance,
} from './paracraftClients';

const INSTANCE_WAIT_MS = 2500;
const COOKIE = 'Keepwork-WebServer';
const MAX_BODY = 16_000_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWebserverClient(instance: string): Promise<string | null> {
    const deadline = Date.now() + INSTANCE_WAIT_MS;
    for (;;) {
        const id = getClientIdForWebserverInstance(instance);
        if (id) return id;
        if (Date.now() >= deadline) return null;
        await sleep(100);
    }
}
const HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function cookieInstance(req: http.IncomingMessage): string | null {
    const raw = String(req.headers.cookie || '');
    const m = raw.match(/(?:^|;\s*)Keepwork-WebServer=([^;]+)/i);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1].trim());
    } catch {
        return m[1].trim();
    }
}

function looksLikeWikiPath(pathname: string): boolean {
    const p = pathname || '';
    if (!p || p === '/') return false;
    const first = p.split('/').filter(Boolean)[0] || '';
    if (['health', 'exists', 'fs', 'mcp', 'admin', 'paracraft', 'calendar', 'webserver'].includes(first)) {
        return false;
    }
    if (/\.page$/i.test(p) || /\.lua$/i.test(p)) return true;
    return /^\/(wp-|ajax\/|console|debugger|nplcad3|tafcad|www\/|script\/|~|robots\.txt)/i.test(p);
}

function parseInstancePath(pathname: string): { instance: string; rest: string } | null {
    const m = pathname.match(/^\/webserver\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    const instance = decodeURIComponent(m[1] || '').trim();
    if (!instance) return null;
    const rest = m[2] && m[2] !== '' ? m[2] : '/';
    return { instance, rest };
}

function pickHeaders(req: http.IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (!value || HOP.has(name.toLowerCase())) continue;
        out[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return out;
}

function innerResult(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') return {};
    const top = payload as Record<string, unknown>;
    if (top.result && typeof top.result === 'object') return top.result as Record<string, unknown>;
    return top;
}

function writeCaptured(res: http.ServerResponse, captured: Record<string, unknown>, instance: string, setCookie: boolean): void {
    const status = Number(captured.status) || (captured.ok === false ? 502 : 200);
    const headersIn = (captured.headers && typeof captured.headers === 'object')
        ? captured.headers as Record<string, unknown>
        : {};
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headersIn)) {
        if (!value || HOP.has(name.toLowerCase())) continue;
        if (Array.isArray(value)) headers[name] = value.map((v) => String(v));
        else headers[name] = String(value);
    }
    if (setCookie) {
        const prev = headers['Set-Cookie'];
        const cookie = `${COOKIE}=${encodeURIComponent(instance)}; Path=/; HttpOnly`;
        headers['Set-Cookie'] = prev
            ? (Array.isArray(prev) ? [...prev, cookie] : [String(prev), cookie])
            : cookie;
    }
    const b64 = typeof captured.bodyBase64 === 'string' ? captured.bodyBase64 : '';
    let body = Buffer.alloc(0);
    if (b64) {
        try {
            body = Buffer.from(b64, 'base64');
        } catch {
            body = Buffer.alloc(0);
        }
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
}

export async function tryHandleWebserver(opts: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    pathname: string;
    method: string;
    url: URL;
    readBodyBuffer: () => Promise<Buffer>;
    sendJson: (status: number, body: unknown) => void;
}): Promise<boolean> {
    const { pathname, method, url, sendJson } = opts;
    let instance: string | null = null;
    let rest = pathname;
    let setCookie = false;

    const parsed = parseInstancePath(pathname);
    if (parsed) {
        instance = parsed.instance;
        rest = parsed.rest;
        setCookie = true;
    } else if (looksLikeWikiPath(pathname)) {
        instance = cookieInstance(opts.req);
        rest = pathname;
        if (!instance) return false;
    } else {
        return false;
    }

    const clientId = await waitForWebserverClient(instance);
    if (!clientId) {
        sendJson(404, {
            ok: false,
            error: `unknown webserver instance: ${instance} (WASM not registered — press F11 or /webserver in web-paracraft)`,
        });
        return true;
    }

    let body: Buffer = Buffer.alloc(0);
    if (method !== 'GET' && method !== 'HEAD') {
        body = await opts.readBodyBuffer();
        if (body.length > MAX_BODY) {
            sendJson(413, { ok: false, error: 'request too large' });
            return true;
        }
    }

    const pathWithQuery = rest + (url.search || '');
    try {
        const payload = await enqueueHttpRequest(clientId, {
            method,
            path: pathWithQuery,
            headers: pickHeaders(opts.req),
            bodyBase64: body.length ? body.toString('base64') : '',
        });
        const captured = innerResult(payload);
        if (captured.ok === false && captured.status == null) {
            sendJson(502, { ok: false, error: String(captured.error || 'webserver proxy failed') });
            return true;
        }
        writeCaptured(opts.res, captured, instance, setCookie);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /timeout/i.test(message) ? 504 : 502;
        if (!opts.res.headersSent) {
            sendJson(status, { ok: false, error: message });
        }
        return true;
    }
}
