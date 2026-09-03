import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DEFAULT_WORKSPACE_SLOT, SERVER_NAME, mcpHomeDir, readToken, resolvePort } from '../../../../src/core/config';
import { resolveWorkspaceRoot } from '../../../../src/core/paths';

export interface HealthInfo {
    ok: boolean;
    name?: string;
    version?: string;
    port?: number;
    pid?: number;
    clients?: number;
    requireAuth?: boolean;
    workspaceRoot?: string;
    error?: string;
    stranger?: boolean;
}

export interface AdminStatus {
    ok: boolean;
    name?: string;
    version?: string;
    pid?: number;
    port?: number;
    uptimeMs?: number;
    startedAt?: string;
    workspaceRoot?: string;
    clients?: Array<{
        sessionId: string;
        origin: string;
        userAgent: string;
        connectedAt: string;
        lastSeenAt: string;
        callCount: number;
    }>;
}

export interface HistoryRow {
    time: string;
    sessionId: string;
    origin: string;
    tool: string;
    summary: string;
    ok: boolean;
    error?: string;
    durationMs: number;
}

export interface HistoryPayload {
    ok: boolean;
    history?: HistoryRow[];
    total?: number;
    offset?: number;
    limit?: number;
    hasMore?: boolean;
}

function configuredPort(): number {
    const cfg = vscode.workspace.getConfiguration('keepwork.mcp');
    return resolvePort(cfg.get<number>('port') || undefined);
}

export function mcpBaseUrl(): string {
    return `http://127.0.0.1:${configuredPort()}`;
}

export function mcpEnabled(): boolean {
    return vscode.workspace.getConfiguration('keepwork.mcp').get<boolean>('enableHttp', true);
}

export function configuredRoot(_context?: vscode.ExtensionContext): string {
    const cfg = vscode.workspace.getConfiguration('keepwork.mcp').get<string>('workspaceRoot') || '';
    if (cfg.trim()) {
        const abs = path.resolve(cfg.trim());
        fs.mkdirSync(abs, { recursive: true });
        fs.mkdirSync(path.join(abs, DEFAULT_WORKSPACE_SLOT), { recursive: true });
        return abs;
    }
    return resolveWorkspaceRoot();
}

export async function probeHealth(): Promise<HealthInfo> {
    const url = `${mcpBaseUrl()}/health`;
    try {
        const res = await fetch(url, { method: 'GET' });
        const body = await res.json() as HealthInfo;
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        if (body.name && body.name !== SERVER_NAME) {
            return { ...body, ok: false, stranger: true, error: `port in use by ${body.name}` };
        }
        return { ...body, ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

async function adminFetch(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
    const token = readToken();
    const url = `${mcpBaseUrl()}${pathname}`;
    return fetch(url, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
}

export async function fetchAdminStatus(): Promise<AdminStatus | null> {
    try {
        const res = await adminFetch('/admin/status');
        if (!res.ok) return null;
        return await res.json() as AdminStatus;
    } catch {
        return null;
    }
}

export async function fetchAdminHistory(opts?: { offset?: number; limit?: number }): Promise<HistoryPayload | null> {
    try {
        const params = new URLSearchParams();
        if (opts?.offset != null) params.set('offset', String(Math.max(0, opts.offset)));
        if (opts?.limit != null) params.set('limit', String(opts.limit));
        const q = params.toString();
        const res = await adminFetch(`/admin/history${q ? `?${q}` : ''}`);
        if (!res.ok) return null;
        return await res.json() as HistoryPayload;
    } catch {
        return null;
    }
}

export async function stopDaemon(): Promise<boolean> {
    try {
        const res = await adminFetch('/admin/stop', 'POST');
        return res.ok;
    } catch {
        return false;
    }
}

function findNode(): Promise<string> {
    return new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execFile(cmd, ['node'], { windowsHide: true }, (err, stdout) => {
            const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (first) resolve(first);
            else reject(err || new Error('node not found on PATH'));
        });
    });
}

export async function ensureDaemon(context: vscode.ExtensionContext): Promise<HealthInfo> {
    if (!mcpEnabled()) return { ok: false, error: 'disabled' };
    const wanted = configuredRoot(context);
    const health = await probeHealth();
    if (health.ok) {
        const current = String(health.workspaceRoot || '').trim();
        if (!current || path.resolve(current) === path.resolve(wanted)) return health;
        await stopDaemon();
        await new Promise(r => setTimeout(r, 400));
    } else if (health.stranger) {
        return health;
    }

    const cli = path.join(context.extensionPath, 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
        return { ok: false, error: `CLI missing: ${cli} (run npm run compile)` };
    }

    let nodePath: string;
    try {
        nodePath = await findNode();
    } catch {
        return { ok: false, error: 'node not found on PATH' };
    }

    const home = mcpHomeDir();
    fs.mkdirSync(home, { recursive: true });
    const logPath = path.join(home, 'daemon.log');
    const logFd = fs.openSync(logPath, 'a');
    const requireAuth = vscode.workspace.getConfiguration('keepwork.mcp').get<boolean>('requireAuth', false);
    const args = [cli, '--port', String(configuredPort()), '--root', configuredRoot(context)];
    if (requireAuth) args.push('--require-auth');
    const child = spawn(nodePath, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        cwd: context.extensionPath,
        env: {
            ...process.env,
            KEEPWORK_MCP_ROOT: configuredRoot(context),
            KEEPWORK_MCP_PORT: String(configuredPort()),
            KEEPWORK_MCP_REQUIRE_AUTH: requireAuth ? '1' : '0',
        },
    });
    child.unref();
    fs.closeSync(logFd);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        const again = await probeHealth();
        if (again.ok) return again;
        if (again.stranger) return again;
    }
    return { ok: false, error: 'daemon did not become healthy (see ~/.keepwork-mcp/daemon.log)' };
}
