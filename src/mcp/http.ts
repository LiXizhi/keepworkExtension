import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
    BIND_HOST, HISTORY_PAGE_DEFAULT, SERVER_NAME, SERVER_VERSION, writeInstance, clearInstance, readOrCreateToken,
    resolveRequireAuth,
} from '../core/config';
import { FS_API, tryHandleFs } from '../core/fsServe';
import { inspectDiskPath, resolveWorkspaceRoot } from '../core/paths';
import { requestContext } from './context';
import { createMcpServer, ServerRuntime } from './server';
import {
    listHistory, listSessions, pruneIdleSessions, removeSession, sessionCount,
    setSessionCloser, upsertSession, touchSession,
} from './sessions';
import { liveClientCount, listWebserverRoots, setHubListenPort, startParacraftWatch, stopParacraftWatch, tryHandleParacraft, webserverBaseUrl } from '../core/paracraftClients';
import { tryHandleWebserver } from '../core/webserverProxy';
import { startCalendarWatch, stopCalendarWatch, tryHandleCalendar } from '../core/calendarReminders';
import { TerminalSessionManager } from '../core/terminalSessions';

export interface HttpServerHandle {
    port: number;
    token: string;
    requireAuth: boolean;
    close(): Promise<void>;
}

const ALLOWED_ORIGIN_HOSTS = new Set(['keepwork.com', 'cdn.keepwork.com', 'localhost', '127.0.0.1']);

function originAllowed(origin: string): boolean {
    if (!origin) return true;
    try {
        const u = new URL(origin);
        if (u.hostname === 'keepwork.com' || u.hostname.endsWith('.keepwork.com')) return true;
        if (ALLOWED_ORIGIN_HOSTS.has(u.hostname)) return true;
        return false;
    } catch {
        return false;
    }
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = String(req.headers.origin || '');
    if (origin && originAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (!origin) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
}

function extractToken(req: http.IncomingMessage, url: URL): string {
    const header = String(req.headers.authorization || '');
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    return String(url.searchParams.get('token') || '').trim();
}

function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            size += buf.length;
            if (size > 16_000_000) {
                reject(new Error('request too large'));
                req.destroy();
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return readBodyBuffer(req).then((buf) => buf.toString('utf8'));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
}

function terminalOwner(req: http.IncomingMessage): string {
    return String(req.headers.origin || 'local-no-origin');
}

function terminalErrorStatus(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/.test(message)) return 404;
    if (/required|too long|already running|closed|blocked|does not exist|not a directory|limit reached/i.test(message)) return 400;
    return 500;
}

function statusPageHtml(runtime: ServerRuntime, port: number): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Keepwork local MCP</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f5;padding:.1em .35em;border-radius:4px}
</style></head>
<body>
<h1>Keepwork local MCP</h1>
<p>Daemon is running on <code>http://127.0.0.1:${port}</code>.</p>
<ul>
<li>workspace root: <code>${escapeHtml(runtime.root)}</code></li>
<li>pid: ${process.pid}</li>
<li>clients: ${sessionCount()}</li>
<li>auth: ${runtime.requireAuth ? 'token required' : 'open (no token)'}</li>
</ul>
<p>AIChat at keepwork.com/chat connects automatically when auth is open. To require a pairing token, set <code>keepwork.mcp.requireAuth</code> or <code>KEEPWORK_MCP_REQUIRE_AUTH=1</code>.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export async function startHttpServer(opts?: { port?: number; root?: string; requireAuth?: boolean }): Promise<HttpServerHandle> {
    const port = opts?.port && opts.port > 0 ? opts.port : 8089;
    const authRequired = resolveRequireAuth(opts?.requireAuth);
    setHubListenPort(port);
    const runtime: ServerRuntime = {
        root: resolveWorkspaceRoot(opts?.root),
        port,
        startedAt: new Date().toISOString(),
        requireAuth: authRequired,
    };
    const token = readOrCreateToken();
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const terminalSessions = new TerminalSessionManager();

    const assertAuth = (req: http.IncomingMessage, url: URL, res: http.ServerResponse): boolean => {
        if (!authRequired) return true;
        if (extractToken(req, url) === token) return true;
        sendJson(res, 401, { error: 'unauthorized', hint: 'Pass Authorization: Bearer <token> from ~/.keepwork-mcp/token' });
        return false;
    };

    const server = http.createServer(async (req, res) => {
        applyCors(req, res);
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            if (pathname === '/health' && req.method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    name: SERVER_NAME,
                    version: SERVER_VERSION,
                    port,
                    pid: process.pid,
                    clients: sessionCount(),
                    paracraftClients: liveClientCount(),
                    requireAuth: authRequired,
                    workspaceRoot: runtime.root,
                    webserverBase: webserverBaseUrl(),
                    webservers: listWebserverRoots(),
                    fsApi: FS_API,
                    fsDirApi: 'mkdir-v1',
                    terminalApi: 'pty-session-v1',
                });
                return;
            }

            if (pathname === '/exists' && req.method === 'GET') {
                const raw = String(url.searchParams.get('path') || '').trim();
                if (!raw) {
                    sendJson(res, 400, { ok: false, error: 'path is required' });
                    return;
                }
                const info = inspectDiskPath(raw);
                sendJson(res, 200, { ok: true, ...info });
                return;
            }

            const handledFs = await tryHandleFs({
                pathname,
                method: req.method || 'GET',
                url,
                res,
                readBodyBuffer: () => readBodyBuffer(req),
                sendJson: (status, body) => sendJson(res, status, body),
            });
            if (handledFs) return;

            if (pathname === '/terminal/sessions' && req.method === 'POST') {
                if (!assertAuth(req, url, res)) return;
                const origin = String(req.headers.origin || '');
                if (origin && !originAllowed(origin)) {
                    sendJson(res, 403, { ok: false, error: 'origin not allowed' });
                    return;
                }
                try {
                    const body = JSON.parse((await readBody(req)) || '{}') as { cwd?: string; cols?: number; rows?: number };
                    sendJson(res, 201, {
                        ok: true,
                        ...terminalSessions.create(runtime.root, body.cwd, terminalOwner(req), body),
                    });
                } catch (error) {
                    sendJson(res, terminalErrorStatus(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }

            const terminalMatch = pathname.match(/^\/terminal\/sessions\/([^/]+)(?:\/(commands|input|output|stream|resize|interrupt))?$/);
            if (terminalMatch) {
                if (!assertAuth(req, url, res)) return;
                const origin = String(req.headers.origin || '');
                if (origin && !originAllowed(origin)) {
                    sendJson(res, 403, { ok: false, error: 'origin not allowed' });
                    return;
                }
                const id = decodeURIComponent(terminalMatch[1]);
                const action = terminalMatch[2] || '';
                const owner = terminalOwner(req);
                try {
                    if (action === 'commands' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}') as { command?: string };
                        sendJson(res, 202, { ok: true, ...terminalSessions.send(id, owner, String(body.command || '')) });
                        return;
                    }
                    if (action === 'input' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}') as { data?: string };
                        sendJson(res, 202, { ok: true, ...terminalSessions.write(id, owner, String(body.data || '')) });
                        return;
                    }
                    if (action === 'output' && req.method === 'GET') {
                        const cursor = Number(url.searchParams.get('cursor') || 0);
                        sendJson(res, 200, { ok: true, ...terminalSessions.output(id, owner, cursor) });
                        return;
                    }
                    if (action === 'stream' && req.method === 'GET') {
                        const cursor = Number(url.searchParams.get('cursor') || 0);
                        res.writeHead(200, {
                            'Content-Type': 'application/x-ndjson; charset=utf-8',
                            'Cache-Control': 'no-store, no-transform',
                            Connection: 'keep-alive',
                            'X-Accel-Buffering': 'no',
                        });
                        res.flushHeaders();
                        let unsubscribe: (() => void) | undefined;
                        const detach = () => {
                            unsubscribe?.();
                            unsubscribe = undefined;
                        };
                        unsubscribe = terminalSessions.subscribe(id, owner, cursor, event => {
                            if (res.writableEnded || res.destroyed) return;
                            res.write(`${JSON.stringify(event)}\n`);
                            if (event.closed) res.end();
                        });
                        res.once('close', detach);
                        if (res.writableEnded) detach();
                        return;
                    }
                    if (action === 'interrupt' && req.method === 'POST') {
                        terminalSessions.interrupt(id, owner);
                        sendJson(res, 200, { ok: true });
                        return;
                    }
                    if (action === 'resize' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}') as { cols?: number; rows?: number };
                        sendJson(res, 200, { ok: true, ...terminalSessions.resize(id, owner, body.cols, body.rows) });
                        return;
                    }
                    if (!action && req.method === 'DELETE') {
                        terminalSessions.close(id, owner);
                        sendJson(res, 200, { ok: true });
                        return;
                    }
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                } catch (error) {
                    sendJson(res, terminalErrorStatus(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }

            const handledCalendar = await tryHandleCalendar({
                pathname,
                method: req.method || 'GET',
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body),
            });
            if (handledCalendar) return;

            if (pathname === '/' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(statusPageHtml(runtime, port));
                return;
            }

            if (pathname === '/admin/status' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, {
                    ok: true,
                    name: SERVER_NAME,
                    version: SERVER_VERSION,
                    pid: process.pid,
                    port,
                    uptimeMs: Date.now() - Date.parse(runtime.startedAt),
                    startedAt: runtime.startedAt,
                    workspaceRoot: runtime.root,
                    requireAuth: authRequired,
                    clients: listSessions(),
                });
                return;
            }

            if (pathname === '/admin/history' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                const offset = Number(url.searchParams.get('offset') || 0);
                const limitRaw = url.searchParams.get('limit');
                const limit = limitRaw == null || limitRaw === '' ? HISTORY_PAGE_DEFAULT : Number(limitRaw);
                sendJson(res, 200, { ok: true, ...listHistory(offset, limit) });
                return;
            }

            if (pathname === '/admin/stop' && req.method === 'POST') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, { ok: true, stopping: true });
                setTimeout(() => {
                    server.close();
                    clearInstance();
                    process.exit(0);
                }, 50);
                return;
            }

            if (pathname === '/mcp') {
                if (!assertAuth(req, url, res)) return;
                const sessionId = String(req.headers['mcp-session-id'] || '');
                const origin = String(req.headers.origin || '');
                const userAgent = String(req.headers['user-agent'] || '');
                let parsedBody: unknown;
                if (req.method === 'POST') {
                    const raw = await readBody(req);
                    parsedBody = raw ? JSON.parse(raw) : undefined;
                }

                await requestContext.run({ sessionId, origin, userAgent }, async () => {
                    if (sessionId && transports.has(sessionId)) {
                        touchSession(sessionId);
                        const transport = transports.get(sessionId)!;
                        await transport.handleRequest(req, res, parsedBody);
                        return;
                    }

                    if (!sessionId && req.method === 'POST' && isInitializeRequest(parsedBody)) {
                        const transport = new StreamableHTTPServerTransport({
                            sessionIdGenerator: () => randomUUID(),
                            enableJsonResponse: true,
                            onsessioninitialized: async (sid) => {
                                transports.set(sid, transport);
                                upsertSession(sid, origin, userAgent);
                                setSessionCloser(sid, () => { void transport.close(); });
                            },
                            onsessionclosed: async (sid) => {
                                transports.delete(sid);
                                removeSession(sid);
                            },
                        });
                        transport.onclose = () => {
                            const sid = transport.sessionId;
                            if (sid) {
                                transports.delete(sid);
                                removeSession(sid);
                            }
                        };
                        const mcp = createMcpServer(runtime);
                        await mcp.connect(transport);
                        await transport.handleRequest(req, res, parsedBody);
                        return;
                    }

                    sendJson(res, 400, { error: 'invalid session', hint: 'POST initialize without Mcp-Session-Id to start a session' });
                });
                return;
            }

            const handled = await tryHandleParacraft({
                req,
                res,
                pathname,
                method: req.method || 'GET',
                readBody: () => readBody(req),
                sendJson: (status, body) => sendJson(res, status, body),
                assertAuth: () => assertAuth(req, url, res),
            });
            if (handled) return;

            const handledWeb = await tryHandleWebserver({
                req,
                res,
                pathname: url.pathname || '/',
                method: req.method || 'GET',
                url,
                readBodyBuffer: () => readBodyBuffer(req),
                sendJson: (status, body) => sendJson(res, status, body),
            });
            if (handledWeb) return;

            sendJson(res, 404, { error: 'not found' });
        } catch (err) {
            if (!res.headersSent) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
        }
    });

    const pruneTimer = setInterval(() => {
        pruneIdleSessions();
        terminalSessions.prune();
    }, 60_000);
    pruneTimer.unref();

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, BIND_HOST, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    writeInstance({
        pid: process.pid,
        port,
        startedAt: runtime.startedAt,
        name: SERVER_NAME,
    });
    startParacraftWatch();
    startCalendarWatch();

    const close = async () => {
        clearInterval(pruneTimer);
        stopParacraftWatch();
        stopCalendarWatch();
        terminalSessions.closeAll();
        for (const t of transports.values()) {
            try { await t.close(); } catch { /* ignore */ }
        }
        transports.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        clearInstance();
    };

    process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });

    return { port, token, requireAuth: authRequired, close };
}
