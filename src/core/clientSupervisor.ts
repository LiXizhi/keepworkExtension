import { execFile } from 'node:child_process';
import { readConfigFile, writeConfigFile } from './config';
import { dws } from './messagingDingtalk';
import { feishuIdentity } from './messagingFeishu';
import type { MessagingService } from './messaging';

type Channel = 'dingtalk' | 'feishu';
type Binding = { id: string; channel?: string; root: string; profile: string; enabled: boolean; status?: string };
export const CLIENT_POLL_MS = 5 * 60 * 1000;
export function processChannels(platform: string, output: string) {
    const lines = output.split(/\r?\n/).map(line => line.trim());
    // Match main executables only, never helpers, crash reporters or substring matches.
    const match = (windows: RegExp, mac: RegExp) => lines.some(line => (platform === 'win32' ? windows : mac).test(line));
    return {
        dingtalk: match(/^DingTalk\.exe$/i, /\/DingTalk\.app\/Contents\/MacOS\/DingTalk$/),
        feishu: match(/^(Feishu|Lark)\.exe$/i, /\/(Feishu|Lark)\.app\/Contents\/MacOS\/(Feishu|Lark)$/),
    };
}
export async function desktopClients(platform = process.platform): Promise<{ dingtalk: boolean; feishu: boolean; error: string }> {
    if (!['win32', 'darwin'].includes(platform)) return { dingtalk: false, feishu: false, error: '当前系统不支持客户端进程检测' };
    const command = platform === 'win32' ? 'powershell.exe' : '/bin/ps';
    const args = platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name DingTalk,Feishu,Lark -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + '.exe' }; exit 0"]
        : ['-ax', '-o', 'comm='];
    try {
        const output = await new Promise<string>((resolve, reject) => execFile(command, args,
            { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
            (error, stdout) => error ? reject(error) : resolve(stdout)));
        return { ...processChannels(platform, output), error: '' };
    } catch { return { dingtalk: false, feishu: false, error: '无法检测客户端进程' }; }
}
export async function cliAuthorized(binding: Binding) {
    if (binding.channel === 'feishu') {
        await feishuIdentity(binding.root, binding.profile);
        return true;
    }
    const result = await dws(['auth', 'status', '--profile', binding.profile, '-f', 'json'], binding.root);
    return result.authenticated === true;
}

// Only deterministic process/CLI checks. No model, chat content, interactive login or new binding.
export class ClientSupervisor {
    private timer?: NodeJS.Timeout;
    private pending?: Promise<void>;
    private closed = false;
    private enabled: boolean;
    private checks = new Map<string, { profile: string; channel: string; authorized: boolean; checkedAt: number }>();
    private clients = { dingtalk: false, feishu: false, error: '', checkedAt: 0 };
    constructor(private messaging: Pick<MessagingService, 'list' | 'start' | 'suspend' | 'setStartGuard'>,
        private deps = { desktopClients, cliAuthorized, readConfigFile, writeConfigFile }) {
        this.enabled = deps.readConfigFile().autoFollowImClients !== false;
        messaging.setStartGuard(binding => this.allowed(binding));
    }
    snapshot() { return { enabled: this.enabled, intervalMs: CLIENT_POLL_MS, clients: this.clients, accounts: [...this.checks.values()] }; }
    async configure(enabled: boolean) {
        this.deps.writeConfigFile({ autoFollowImClients: enabled });
        this.enabled = enabled;
        if (this.pending) await this.pending;
        await this.poll();
        return this.snapshot();
    }
    private async allowed(binding: Binding) {
        if (this.closed) return false;
        if (!this.enabled) return true;
        if (Date.now() - this.clients.checkedAt > 10000) {
            this.clients = { ...await this.deps.desktopClients(), checkedAt: Date.now() };
        }
        const channel = (binding.channel || 'dingtalk') as Channel;
        if (this.clients.error || !this.clients[channel]) return false;
        let check = this.checks.get(binding.id);
        if (!check || Date.now() - check.checkedAt > 10000) {
            let authorized = false;
            try { authorized = await this.deps.cliAuthorized(binding); } catch { /* fail closed */ }
            check = { channel, profile: binding.profile, authorized, checkedAt: Date.now() };
            this.checks.set(binding.id, check);
        }
        return !this.closed && (!this.enabled || check.authorized);
    }
    poll(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.pending) return this.pending;
        this.pending = (async () => {
            this.checks.clear();
            this.clients = { ...await this.deps.desktopClients(), checkedAt: Date.now() };
            for (const binding of this.messaging.list()) {
                if (this.closed) break;
                if (!binding.enabled) continue;
                const allowed = await this.allowed(binding);
                // Re-read user intent after asynchronous checks; never undo manual Stop.
                const current = this.messaging.list().find(row => row.id === binding.id);
                if (this.closed || !current?.enabled) continue;
                if (!allowed) this.messaging.suspend(binding.id);
                else if (current.status !== 'listening' && current.status !== 'connecting') {
                    try { await this.messaging.start(binding.id); } catch { /* listener exposes its own error */ }
                }
            }
        })().finally(() => { this.pending = undefined; });
        return this.pending;
    }
    start() {
        if (this.timer || this.closed) return;
        void this.poll().catch(() => {});
        this.timer = setInterval(() => { void this.poll().catch(() => {}); }, CLIENT_POLL_MS);
        this.timer.unref();
    }
    close() { this.closed = true; clearInterval(this.timer); }
}
