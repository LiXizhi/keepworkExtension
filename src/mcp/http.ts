import { MODEL_STUDIO_UPLOAD_API, handleModelStudioUpload } from '../core/modelStudioUpload';
import { petPermissionBridge, screenshotPermission } from '../core/petPermissionBridge';
import { computerController } from '../core/computer';
import { hostname } from 'node:os';
import { registerMcpPresence } from './aichatPresence';
import { attachAichatEvents } from './aichatEvents';
import { Personas } from '../core/personas';
import { handlePersonaHttp } from './personaHttp';
import { managedBrowsers } from '../core/browser';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
    BIND_HOST, HISTORY_PAGE_DEFAULT, SERVER_NAME, SERVER_VERSION, writeInstance, clearInstance, readOrCreateToken,
    resolveRequireAuth, mcpHomeDir,
} from '../core/config';
import { FS_API, tryHandleFs } from '../core/fsServe';
import { FOLDER_BROWSER_API, folderLocations, browseFolders } from '../core/folderBrowser';
import { inspectDiskPath, resolveWorkspaceRoot } from '../core/paths';
import { requestContext } from './context';
import { createMcpServer, ServerRuntime } from './server';
import {
    listHistory, listSessions, pruneIdleSessions, removeSession, sessionCount,
    setSessionCloser, upsertSession, touchSession, hasSession,
} from './sessions';
import { liveClientCount, listWebserverRoots, setHubListenPort, startParacraftWatch, stopParacraftWatch, tryHandleParacraft, webserverBaseUrl } from '../core/paracraftClients';
import { tryHandleWebserver } from '../core/webserverProxy';
import { startCalendarWatch, stopCalendarWatch, tryHandleCalendar } from '../core/calendarReminders';
import { TerminalSessionManager } from '../core/terminalSessions';
import { AgentSessions, ownerKey } from '../core/agentSessions';
import { handleAgentHttp } from './agentHttp';
import { tryHandleAichatPresence, aichatClientRemembered } from '../core/aichatPresence';
import { dashboardHtml } from './dashboard';
import { dashboardSkill } from './dashboardSkill';
import { apiDocs } from './apiDocs';
import { mcpCatalog } from './mcpCatalog';
import { MessagingService, channelConflict } from '../core/messaging';
import { runMessagingAgentTurn, setMessagingAgentRunner } from '../core/messagingExecutor';
import { ChannelStatus } from '../core/channelStatus';
import { ClientSupervisor } from '../core/clientSupervisor';
import { handleMessagingHttp } from './messagingHttp';
import { runtimeBuildInfo } from '../core/runtimeBuildInfo';

export interface HttpServerHandle {
    port: number;
    token: string;
    requireAuth: boolean;
    close(): Promise<void>;
}

export type McpHostKind = 'local-helper' | 'vscode-extension' | 'standalone' | 'electron-node-runtime';

export interface HttpServerOptions {
    port?: number;
    root?: string;
    requireAuth?: boolean;
    hostKind?: McpHostKind;
    hostVersion?: string;
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Agent-Owner, X-DashScope-Api-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version, Retry-After');
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

function readBodyBuffer(req: http.IncomingMessage, maxBytes = 16_000_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            size += buf.length;
            if (size > maxBytes) {
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

export async function startHttpServer(opts?: HttpServerOptions): Promise<HttpServerHandle> {
    const port = opts?.port && opts.port > 0 ? opts.port : 8089;
    const authRequired = resolveRequireAuth(opts?.requireAuth);
    setHubListenPort(port);
    const runtime: ServerRuntime = {
        root: resolveWorkspaceRoot(opts?.root),
        port,
        startedAt: new Date().toISOString(),
        requireAuth: authRequired,
    };
    const identity = {
        runtimeVersion: process.env.KEEPWORK_MCP_RUNTIME_VERSION || runtimeBuildInfo.version || undefined,
        runtimeCommit: process.env.KEEPWORK_MCP_RUNTIME_COMMIT || runtimeBuildInfo.commit || undefined,
        runtimeBuiltAt: runtimeBuildInfo.builtAt || undefined,
        hostKind: opts?.hostKind,
        hostVersion: opts?.hostVersion || undefined,
    };
    const token = readOrCreateToken();
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const activeMcpStreams = new Set<string>();
    const presenceStreams = new Map<string, http.ServerResponse>();
    const terminalSessions = new TerminalSessionManager();
    const agentSessions = new AgentSessions(path.join(mcpHomeDir(), 'agent-sessions-v1.json'));
    const messagingHome = path.join(mcpHomeDir(), 'messaging-v1');
    setMessagingAgentRunner((backend, model, input, signal) => runMessagingAgentTurn(agentSessions, path.join(messagingHome, 'readers'), backend, model, input, signal));
    const messaging = new MessagingService(messagingHome, port);
    runtime.messaging = messaging;
    const channelStatus = new ChannelStatus(runtime.root);
    const clientSupervisor = new ClientSupervisor(messaging);
    const personas = new Personas(path.join(mcpHomeDir(),'personas-v1'),agentSessions,messaging);

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
        // Same-origin browser GETs omit Origin. Recover only the dashboard's
        // exact loopback origin so its reads keep the same PTY owner as POSTs.
        if (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'
            && (pathname.startsWith('/agents/') || pathname.startsWith('/terminal/'))) {
            try {
                const referrer = new URL(String(req.headers.referer || ''));
                if ([`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(referrer.origin)
                    && referrer.host === req.headers.host && ['/', '/dashboard', '/dashboard/'].includes(referrer.pathname)) {
                    req.headers.origin = referrer.origin;
                }
            } catch { /* No trusted same-origin dashboard referrer. */ }
        }


        if (req.method === 'OPTIONS') {
            if (pathname.startsWith('/model-studio/') && (!req.headers.origin || !originAllowed(String(req.headers.origin)))) { sendJson(res, 403, { error: 'Explicit allowed Origin required' }); return; }
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            if (pathname.startsWith('/model-studio/')) {
                const origin = String(req.headers.origin || '');
                if (!origin || !originAllowed(origin)) { sendJson(res, 403, { error: 'Explicit allowed Origin required' }); return; }
                if (!assertAuth(req, url, res)) return;
                await handleModelStudioUpload(req, res, url); return;
            }
            if (pathname.startsWith('/messaging/')) {
                const worker = pathname === '/messaging/worker' || pathname.startsWith('/messaging/worker/');
                const origin = String(req.headers.origin || '');
                if (worker ? (origin && origin !== `http://127.0.0.1:${port}`) : (!origin || !originAllowed(origin))) { sendJson(res,403,{error:'Messaging Origin rejected'}); return; }
                if (!worker && !assertAuth(req,url,res)) return;
                await handleMessagingHttp(req,res,url,messaging); return;
            }
            if (pathname.startsWith('/agents/')) {
                const origin = String(req.headers.origin || '');
                if (!origin || !originAllowed(origin)) { sendJson(res, 403, { error: 'Explicit allowed Origin required' }); return; }
                if (!assertAuth(req, url, res)) return;
                if (pathname === '/agents/personas' || pathname.startsWith('/agents/personas/')) { await handlePersonaHttp(req,res,url,personas,messaging); return; }
                await handleAgentHttp(req, res, url, agentSessions);
                return;
            }
            if (pathname === '/aichat/presence') {
                await tryHandleAichatPresence(req, res, hasSession, presenceStreams);
                return;
            }
            if (pathname === '/health' && req.method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    name: SERVER_NAME,
                    version: SERVER_VERSION,
                    ...identity,
                    port,
                    pid: process.pid,
                    clients: sessionCount(),
                    paracraftClients: liveClientCount(),
                    requireAuth: authRequired,
                    workspaceRoot: runtime.root,
                    webserverBase: webserverBaseUrl(),
                    webservers: listWebserverRoots(),
                    fsApi: FS_API,
                    folderBrowserApi: FOLDER_BROWSER_API,
                    modelStudioUploadApi: MODEL_STUDIO_UPLOAD_API,
                    browserApi: 'browser-v1',
                    fsDirApi: 'mkdir-v1',
                    terminalApi: 'pty-session-v1',
                    agentSessionApi: 'v1',
                    agentContextApi: 'v1',
                    agentModeApi: 'v1',
                    agentInventoryApi: 'v1',
                    aichatClient: aichatClientRemembered(),
                    aichatPresenceApi: 'post-sse-v1',
                    messagingApi: 'messaging-v1',
                    personasApi: 'personas-v1',
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

            if ((pathname === '/fs/locations' || pathname === '/fs/browse') && req.method === 'GET') {
                if (!originAllowed(String(req.headers.origin || ''))) {
                    sendJson(res, 403, { error: 'origin not allowed' }); return;
                }
                if (!assertAuth(req, url, res)) return;
                res.setHeader('Cache-Control', 'no-store');
                try {
                    const body = pathname === '/fs/locations' ? await folderLocations() : await browseFolders(url.searchParams.get('path') || '', {
                        hidden: url.searchParams.get('hidden') === '1', filter: (url.searchParams.get('filter') || '').slice(0, 256),
                        offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')),
                    });
                    sendJson(res, 200, { ok: true, ...body });
                } catch (error) {
                    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            const handledFs = await tryHandleFs({
                pathname,
                method: req.method || 'GET',
                url,
                res,
                readBodyBuffer: (maxBytes) => readBodyBuffer(req, maxBytes),
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

            if ((pathname === '/' || pathname === '/dashboard') && req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/xterm-6.0.0.js https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/addon-fit-0.11.0.js; style-src 'unsafe-inline' https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/xterm-6.0.0.css; connect-src 'self'; frame-src https://keepwork.com http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                    'X-Content-Type-Options': 'nosniff',
                });
                res.end(dashboardHtml());
                return;
            }

            if (pathname === '/dashboard/skills/keepwork-mcp-assistant/SKILL.md' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(dashboardSkill(`http://127.0.0.1:${port}`, url.searchParams.get('channel') || ''));
                return;
            }


            if (pathname.startsWith('/admin/')) {
                res.setHeader('Cache-Control', 'no-store');
                if (!originAllowed(String(req.headers.origin || ''))) {
                    sendJson(res, 403, { error: 'origin not allowed' });
                    return;
                }
            }

            if (pathname === '/admin/channels' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, { channels: await channelStatus.snapshot(messaging.list(), messaging.channelRoots()), supervisor: clientSupervisor.snapshot() });
                return;
            }
            if (pathname === '/admin/channels/connection' && req.method === 'POST') {
                if (!assertAuth(req, url, res)) return;
                const body = JSON.parse((await readBodyBuffer(req, 2048)).toString('utf8'));
                const binding = messaging.list().find(row => row.id === body.id);
                if (!binding || !['connect', 'disconnect'].includes(body.action)) { sendJson(res, 400, { error: 'Invalid binding or action' }); return; }
                if (body.action === 'connect') {
                    if (binding.enabled || binding.transitioning) { sendJson(res, 409, { error: 'Disconnect first and wait for completion' }); return; }
                    try { if(body.switchFromRoot !== undefined) await messaging.switchChannel(binding.channel as 'dingtalk'|'feishu',binding.root,String(body.switchFromRoot)); await messaging.start(binding.id); }
                    catch(error) { sendJson(res, 409, channelConflict(error) || { error: 'Connection failed; check CLI authorization and client status', needsHelp: true }); return; }
                } else messaging.stop(binding.id);
                sendJson(res, 200, { ok: true });
                return;
            }
            if (pathname === '/admin/channels/supervisor' && req.method === 'POST') {
                if (!assertAuth(req, url, res)) return;
                const body = JSON.parse((await readBodyBuffer(req, 1024)).toString('utf8'));
                if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled must be boolean' }); return; }
                sendJson(res, 200, { supervisor: await clientSupervisor.configure(body.enabled) });
                return;
            }
            if (pathname === '/admin/messaging-computers' && ['GET','POST'].includes(req.method || '')) {
                if (!assertAuth(req, url, res)) return;
                if(req.method==='POST'){
                    if(!originAllowed(String(req.headers.origin||''))){sendJson(res,403,{error:'Explicit allowed Origin required'});return;}
                    const body=JSON.parse((await readBodyBuffer(req,8192)).toString('utf8'));
                    if(!messaging.coordinationDashboard().some(row=>row.owner===body.owner)){sendJson(res,403,{error:'Unknown owner'});return;}
                    await messaging.configureCoordination(body.owner,body);
                }
                sendJson(res,200,{accounts:messaging.coordinationDashboard()});return;
            }
            if (pathname === '/admin/personas' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, { ...personas.dashboard(), recentMessages: messaging.dashboardMessages() });
                return;
            }

            if (pathname === '/admin/screenshot-permission') {
                if (!assertAuth(req, url, res)) return;
                const origin = String(req.headers.origin || '');
                if ((origin && !originAllowed(origin)) || (req.method === 'POST' && (!origin || !originAllowed(origin)))) { sendJson(res,403,{error:'Explicit allowed Origin required'}); return; }
                const abort = new AbortController();
                res.once('close', () => { if (!res.writableFinished) abort.abort(); });
                try {
                    if (req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        if (typeof body.alwaysAllowScreenshots !== 'boolean' || Object.keys(body).length !== 1) throw Error('Expected alwaysAllowScreenshots boolean');
                        if (!body.alwaysAllowScreenshots) screenshotPermission.disable();
                        else {
                            if (computerController.isBusy) throw Error('Desktop is busy');
                            try { await screenshotPermission.authorize('settings', 'Keepwork screenshot settings', abort.signal, true); } finally { petPermissionBridge.restorePet(); }
                        }
                    } else if (req.method !== 'GET') { sendJson(res,405,{error:'Method not allowed'}); return; }
                    sendJson(res,200,screenshotPermission.status());
                } catch (error) { if (!res.destroyed) sendJson(res,400,{error:error instanceof Error ? error.message : 'Screenshot setting failed'}); }
                return;
            }

            if (pathname === '/admin/status' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, {
                    ok: true,
                    name: SERVER_NAME,
                    version: SERVER_VERSION,
                    ...identity,
                    nodeVersion: process.version,
                    platform: process.platform,
                    hostname: hostname(),
                    arch: process.arch,
                    execPath: process.execPath,
                    entryPath: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
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

            if (pathname === '/admin/api-docs' && req.method === 'GET') {
                if (!assertAuth(req, url, res)) return;
                sendJson(res, 200, { ...apiDocs(port, authRequired), ...await mcpCatalog(runtime) });
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
                    void close().then(() => process.exit(0)).catch(() => console.error('Daemon stop incomplete; owned consumer cleanup required'));
                }, 50);
                return;
            }

            if (pathname === '/mcp') {
                const origin = String(req.headers.origin || '');
                if (origin && !originAllowed(origin)) {
                    sendJson(res, 403, { error: 'origin not allowed' });
                    return;
                }
                if (!assertAuth(req, url, res)) return;
                const sessionId = String(req.headers['mcp-session-id'] || '');
                const userAgent = String(req.headers['user-agent'] || '');
                let parsedBody: unknown;
                if (req.method === 'POST') {
                    const raw = await readBody(req);
                    parsedBody = raw ? JSON.parse(raw) : undefined;
                }

                const requestAbort = new AbortController();
                res.once('close', () => { if (!res.writableFinished) requestAbort.abort(new Error('MCP client disconnected')); });
                await requestContext.run({ sessionId, origin, userAgent, signal: requestAbort.signal }, async () => {
                    if (sessionId && transports.has(sessionId)) {
                        touchSession(sessionId);
                        const transport = transports.get(sessionId)!;
                        if (req.method === 'GET') {
                            const rawOwner = String(req.headers['x-agent-owner'] || '');
                            if (rawOwner && !origin) { sendJson(res, 403, { error: 'Explicit allowed Origin required' }); return; }
                            let owner = '';
                            try { if (rawOwner) owner = ownerKey(origin, rawOwner); }
                            catch { sendJson(res, 400, { error: 'Agent owner key required' }); return; }
                            // A duplicate GET must not steal notifications or clear the
                            // live session's pruning exemption when its 409 closes.
                            if (activeMcpStreams.has(sessionId)) { sendJson(res, 409, { error: 'MCP stream already open' }); return; }
                            activeMcpStreams.add(sessionId);
                            res.once('close', () => activeMcpStreams.delete(sessionId));
                            attachAichatEvents(res, transport, personas, owner);
                        }
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
                                screenshotPermission.cancelOwner(sid);
                                void managedBrowsers.closeOwner(sid);
                            },
                        });
                        transport.onclose = () => {
                            const sid = transport.sessionId;
                            if (sid) {
                                transports.delete(sid);
                                removeSession(sid);
                                screenshotPermission.cancelOwner(sid);
                                void managedBrowsers.closeOwner(sid);
                            }
                        };
                        const mcp = createMcpServer(runtime);
                        registerMcpPresence(mcp, hasSession);
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
        pruneIdleSessions(new Set([...activeMcpStreams, ...(screenshotPermission.waitingOwner ? [screenshotPermission.waitingOwner] : [])]));
        terminalSessions.prune();
        void managedBrowsers.prune();
    }, 60_000);
    pruneTimer.unref();

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, BIND_HOST, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    agentSessions.toolBridge.configureNative(() => ({ url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`, token }));
    writeInstance({
        pid: process.pid,
        port,
        startedAt: runtime.startedAt,
        name: SERVER_NAME,
    });
    await petPermissionBridge.start().catch(() => { /* A capture reports companion startup failure. */ });
    startParacraftWatch();
    startCalendarWatch();
    clientSupervisor.start();

    const close = async () => {
        screenshotPermission.close(); petPermissionBridge.close();
        clientSupervisor.close();
        clearInterval(pruneTimer);
        stopParacraftWatch();
        stopCalendarWatch();
        terminalSessions.closeAll();
        personas.close();
        agentSessions.close();
        for (const response of presenceStreams.values()) response.end();
        presenceStreams.clear();
        await managedBrowsers.closeAll();
        for (const t of transports.values()) {
            try { await t.close(); } catch { /* ignore */ }
        }
        transports.clear();
        messaging.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        clearInstance();
    };

    process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });

    return { port, token, requireAuth: authRequired, close };
}
