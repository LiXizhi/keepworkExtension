import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 8089;
export const BIND_HOST = '127.0.0.1';
export const SERVER_NAME = 'keepwork-mcp';
export const SERVER_VERSION = '0.1.1';
export const IDLE_SESSION_MS = 30 * 60 * 1000;
export const HISTORY_MAX = 500;
export const HISTORY_PAGE_DEFAULT = 20;
export const HISTORY_PAGE_MAX = 50;
export const GLOBAL_TERMINAL_CAP = 4;
export const OUTPUT_CHAR_CAP = 24000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;

export interface McpConfigFile {
    workspaceRoot?: string;
    port?: number;
    /** When true, /mcp and /admin require the pairing token. Default false. */
    requireAuth?: boolean;
}

export interface InstanceInfo {
    pid: number;
    port: number;
    startedAt: string;
    name: string;
}

export function mcpHomeDir(): string {
    return path.join(os.homedir(), '.keepwork-mcp');
}

/** Default MCP sandbox parent: ~/.keepwork-mcp/workspace */
export function defaultUserWorkspace(): string {
    return path.join(mcpHomeDir(), 'workspace');
}

/** Slot used when AIChat has no workspace selected. */
export const DEFAULT_WORKSPACE_SLOT = 'default';

export function defaultWorkspaceSlotDir(root?: string): string {
    return path.join(root || defaultUserWorkspace(), DEFAULT_WORKSPACE_SLOT);
}

export function ensureMcpHome(): string {
    const dir = mcpHomeDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function ensureUserWorkspace(dir?: string): string {
    const target = path.resolve(String(dir || '').trim() || defaultUserWorkspace());
    fs.mkdirSync(target, { recursive: true });
    try {
        fs.mkdirSync(path.join(target, DEFAULT_WORKSPACE_SLOT), { recursive: true });
    } catch {
        /* ignore */
    }
    return target;
}

export function configPath(): string {
    return path.join(mcpHomeDir(), 'config.json');
}

export function tokenPath(): string {
    return path.join(mcpHomeDir(), 'token');
}

export function instancePath(): string {
    return path.join(mcpHomeDir(), 'instance.json');
}

export function readConfigFile(): McpConfigFile {
    try {
        const raw = fs.readFileSync(configPath(), 'utf8');
        const parsed = JSON.parse(raw) as McpConfigFile;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function writeConfigFile(partial: McpConfigFile): void {
    ensureMcpHome();
    const next = { ...readConfigFile(), ...partial };
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

export interface TerminalBridgeInfo {
    port: number;
    pid: number;
    token: string;
}

export function terminalBridgePath(): string {
    return path.join(mcpHomeDir(), 'terminal-bridge.json');
}

export function readTerminalBridge(): TerminalBridgeInfo | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(terminalBridgePath(), 'utf8')) as TerminalBridgeInfo;
        if (!parsed || typeof parsed.port !== 'number' || !parsed.token) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeTerminalBridge(info: TerminalBridgeInfo): void {
    ensureMcpHome();
    fs.writeFileSync(terminalBridgePath(), JSON.stringify(info, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
    });
}

export function clearTerminalBridge(ownerPid?: number): void {
    try {
        if (ownerPid) {
            const cur = readTerminalBridge();
            if (cur && cur.pid !== ownerPid) return;
        }
        fs.unlinkSync(terminalBridgePath());
    } catch {
        /* ignore */
    }
}

/** Default is open (no token) so AIChat can connect without a pairing step. */
export function resolveRequireAuth(override?: boolean): boolean {
    if (typeof override === 'boolean') return override;
    const env = String(process.env.KEEPWORK_MCP_REQUIRE_AUTH || '').trim();
    if (env === '1' || /^(true|yes|on)$/i.test(env)) return true;
    if (env === '0' || /^(false|no|off)$/i.test(env)) return false;
    const file = readConfigFile().requireAuth;
    if (typeof file === 'boolean') return file;
    return false;
}

export function resolvePort(override?: number): number {
    if (override && Number.isFinite(override) && override > 0) return override;
    const env = Number(process.env.KEEPWORK_MCP_PORT || '');
    if (Number.isFinite(env) && env > 0) return env;
    const file = readConfigFile().port;
    if (file && Number.isFinite(file) && file > 0) return file;
    return DEFAULT_PORT;
}

export function readOrCreateToken(): string {
    ensureMcpHome();
    const p = tokenPath();
    try {
        const existing = fs.readFileSync(p, 'utf8').trim();
        if (existing) return existing;
    } catch {
        /* create below */
    }
    const token = randomBytes(24).toString('hex');
    fs.writeFileSync(p, token, { encoding: 'utf8', mode: 0o600 });
    return token;
}

export function readToken(): string {
    try {
        return fs.readFileSync(tokenPath(), 'utf8').trim();
    } catch {
        return '';
    }
}

export function writeInstance(info: InstanceInfo): void {
    ensureMcpHome();
    fs.writeFileSync(instancePath(), JSON.stringify(info, null, 2), 'utf8');
}

export function readInstance(): InstanceInfo | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(instancePath(), 'utf8')) as InstanceInfo;
        if (!parsed || typeof parsed.pid !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function clearInstance(): void {
    try {
        fs.unlinkSync(instancePath());
    } catch {
        /* ignore */
    }
}

export function isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
