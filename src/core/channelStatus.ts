import { dws, resolveDws } from './messagingDingtalk';
import { lark, resolveLark } from './messagingFeishu';

type Channel = 'dingtalk' | 'feishu';
interface BindingStatus { id?: string; transitioning?: boolean; channel?: string; profile: string; enabled: boolean; status: string; lastPollAt?: number | null }
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 160) : '';
export function expiry(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const numeric = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : NaN;
    const time = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(String(value));
    return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? new Date(time).toISOString() : null;
}
// Strict allowlist: never return the raw CLI response, diagnostics or token values.
export function accountStatus(value: any, fallback = '') {
    return { profile: label(value.profile) || fallback, name: label(value.userName || value.name),
        organization: label(value.corpName), status: label(value.status) || 'unknown',
        expiresAt: expiry(value.expiresAt ?? value.expires_at ?? value.accessTokenExpiresAt ?? value.access_token_expires_at),
        refreshExpiresAt: expiry(value.refreshExpAt ?? value.refreshExpiresAt ?? value.refresh_token_expires_at) };
}
export class ChannelStatus {
    private cached = new Map<Channel, { checkedAt: number; value: any }>();
    private pending = new Map<Channel, Promise<any>>();
    constructor(private root: string, private deps = { dws, lark, resolveDws, resolveLark }) {}
    private async probe(channel: Channel, profiles: string[]) {
        const cached = this.cached.get(channel);
        if (cached && Date.now() - cached.checkedAt < 60000) return cached.value;
        if (this.pending.has(channel)) return this.pending.get(channel);
        const work = (async () => {
            let value: any = { channel, installed: false, accounts: [], error: '', checkedAt: Date.now() };
            try { (channel === 'dingtalk' ? this.deps.resolveDws : this.deps.resolveLark)(); }
            catch { value.error = 'CLI 未安装或不可访问'; return value; }
            value.installed = true;
            try {
                if (channel === 'dingtalk') {
                    const result = await this.deps.dws(['profile', 'list', '-f', 'json'], this.root);
                    if (!Array.isArray(result.profiles)) throw Error('Invalid response');
                    value.accounts = result.profiles.slice(0, 30).map((row: any) => accountStatus(row));
                } else {
                    const apps = [...new Set(profiles.map(profile => profile.split(':')[0]))].slice(0, 10);
                    for (const app of apps.length ? apps : ['']) {
                        const result = await this.deps.lark(['auth', 'status', '--json', ...(app ? ['--profile', app] : [])], this.root);
                        const user = result.identities?.user;
                        if (user) value.accounts.push(accountStatus(user, [result.appId || app, user.openId].filter(Boolean).join(':')));
                    }
                }
            } catch { value.error = '无法读取授权状态，请在渠道设置中检查 CLI 登录'; }
            return value;
        })().then(value => { value.checkedAt = Date.now(); this.cached.set(channel, { checkedAt: value.checkedAt, value }); return value; });
        this.pending.set(channel, work);
        try { return await work; } finally { this.pending.delete(channel); }
    }
    async snapshot(bindings: BindingStatus[]) {
        return Promise.all((['dingtalk', 'feishu'] as Channel[]).map(async channel => {
            const rows = bindings.filter(b => (b.channel || 'dingtalk') === channel);
            const auth = await this.probe(channel, rows.map(b => b.profile));
            return { ...auth, bindings: rows.map(b => ({ id: b.id, transitioning: !!b.transitioning, profile: b.profile, enabled: b.enabled, status: b.status, lastPollAt: b.lastPollAt || null })) };
        }));
    }
}
