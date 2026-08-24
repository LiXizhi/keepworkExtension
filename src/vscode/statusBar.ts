import * as vscode from 'vscode';
import { readToken } from '../core/config';
import { fetchAdminHistory, fetchAdminStatus, mcpBaseUrl, probeHealth, type AdminStatus, type HistoryPayload } from './daemon';

export function createMcpStatusBar(onClick: string): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    item.command = onClick;
    item.text = '$(server) Keepwork MCP';
    item.tooltip = 'Keepwork local MCP';
    item.show();
    return item;
}

function shortId(id: string): string {
    return id ? id.slice(0, 8) : '—';
}

function ago(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return iso;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3600_000)}h ago`;
}

export async function refreshStatusBar(item: vscode.StatusBarItem): Promise<void> {
    const health = await probeHealth();
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportThemeIcons = true;

    if (!health.ok) {
        item.text = '$(server) Keepwork MCP';
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        md.appendMarkdown(health.stranger
            ? `**Keepwork MCP** — port in use by another process\n\n${health.error || ''}`
            : `**Keepwork MCP** — not running\n\n${health.error || 'Click to start / inspect'}\n\n\`${mcpBaseUrl()}\``);
        item.tooltip = md;
        return;
    }

    const status = await fetchAdminStatus();
    const history = await fetchAdminHistory({ offset: 0, limit: 6 });
    const clients = status?.clients || [];
    item.text = clients.length ? `$(server) Keepwork MCP · ${clients.length}` : '$(server) Keepwork MCP';
    item.backgroundColor = undefined;

    const lines = [
        `**Keepwork MCP** running`,
        '',
        `- URL: \`${mcpBaseUrl()}/mcp\``,
        `- pid: ${status?.pid ?? health.pid ?? '?'}`,
        `- root: \`${status?.workspaceRoot || '?'}\``,
        `- terminal: VS Code Keepwork panel (reused)`,
        `- clients: ${clients.length}`,
        `- auth: ${health.requireAuth ? 'token required' : 'open'}`,
        '',
    ];
    if (clients.length) {
        lines.push('**Clients**');
        for (const c of clients.slice(0, 8)) {
            lines.push(`- \`${shortId(c.sessionId)}\` ${c.origin || '(no origin)'} · ${c.callCount} calls · ${ago(c.lastSeenAt)}`);
        }
        lines.push('');
    }
    const rows = history?.history || [];
    if (rows.length) {
        lines.push('**Recent calls**');
        for (const h of rows.slice(0, 6)) {
            const mark = h.ok ? 'ok' : 'fail';
            lines.push(`- ${mark} \`${h.tool}\` ${h.summary.slice(0, 60)} · ${h.durationMs}ms`);
        }
    }
    if (health.requireAuth && !readToken()) {
        lines.push('', '_Token file missing: ~/.keepwork-mcp/token_');
    }
    md.appendMarkdown(lines.join('\n'));
    item.tooltip = md;
}

export function formatPanelPayload(
    status: AdminStatus | null,
    history: HistoryPayload | null,
    healthOk: boolean,
    workspaceRoot = '',
) {
    return {
        status,
        history: history?.history || [],
        historyTotal: history?.total ?? (history?.history || []).length,
        historyOffset: history?.offset ?? 0,
        historyLimit: history?.limit ?? (history?.history || []).length,
        historyHasMore: !!history?.hasMore,
        healthOk,
        baseUrl: mcpBaseUrl(),
        workspaceRoot: workspaceRoot || status?.workspaceRoot || '',
    };
}
