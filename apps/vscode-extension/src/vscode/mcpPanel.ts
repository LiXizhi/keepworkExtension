import * as vscode from 'vscode';
import { HISTORY_PAGE_DEFAULT, readToken } from '../../../../src/core/config';
import { configuredRoot, ensureDaemon, fetchAdminHistory, fetchAdminStatus, mcpBaseUrl, probeHealth, stopDaemon } from './daemon';
import { formatPanelPayload } from './statusBar';

export function openMcpPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    const isChinese = /^zh(?:-|$)/i.test(vscode.env.language);
    const panel = vscode.window.createWebviewPanel(
        'keepworkMcp',
        isChinese ? 'Keepwork MCP 管理' : 'Keepwork MCP',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.webview.html = panelHtml(isChinese);
    let historyOffset = 0;

    const push = async () => {
        const health = await probeHealth();
        const status = health.ok ? await fetchAdminStatus() : null;
        let history = health.ok
            ? await fetchAdminHistory({ offset: historyOffset, limit: HISTORY_PAGE_DEFAULT })
            : null;
        const total = history?.total ?? 0;
        if (history && total > 0 && historyOffset >= total) {
            historyOffset = Math.max(0, Math.floor((total - 1) / HISTORY_PAGE_DEFAULT) * HISTORY_PAGE_DEFAULT);
            history = await fetchAdminHistory({ offset: historyOffset, limit: HISTORY_PAGE_DEFAULT });
        }
        if (!health.ok) historyOffset = 0;
        void panel.webview.postMessage({
            type: 'update',
            payload: formatPanelPayload(status, history, health.ok, configuredRoot(context)),
        });
    };

    const timer = setInterval(() => { void push(); }, 2000);
    void push();

    panel.onDidDispose(() => clearInterval(timer), null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'restart') {
            const health = await probeHealth();
            const stopped = health.ok ? await stopDaemon() : true;
            if (!stopped) {
                vscode.window.showErrorMessage(isChinese ? 'Keepwork MCP：停止旧服务失败，未执行重启。' : 'Keepwork MCP: failed to stop the existing server; restart was cancelled.');
                await push();
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 400));
            const result = await ensureDaemon(context);
            if (!result.ok) vscode.window.showErrorMessage(isChinese ? `Keepwork MCP：重启失败：${result.error || '启动失败'}` : `Keepwork MCP: restart failed: ${result.error || 'failed to start'}`);
            await push();
        }
        if (msg?.type === 'stop') {
            const ok = await stopDaemon();
          if (!ok) vscode.window.showWarningMessage(isChinese ? 'Keepwork MCP：停止失败（服务是否正在运行？）' : 'Keepwork MCP: stop failed (is the daemon running?)');
            await new Promise(r => setTimeout(r, 400));
            await push();
        }
        if (msg?.type === 'copyToken') {
            const token = readToken();
            if (!token) {
                vscode.window.showWarningMessage(isChinese ? '尚无配对令牌，请先启动 MCP 服务。' : 'No pairing token yet. Start the MCP server first.');
                return;
            }
            await vscode.env.clipboard.writeText(token);
            vscode.window.showInformationMessage(isChinese ? 'Keepwork MCP 令牌已复制' : 'Keepwork MCP token copied');
        }
        if (msg?.type === 'refresh') await push();
        if (msg?.type === 'historyPage') {
            historyOffset = Math.max(0, Math.floor(Number(msg.offset) || 0));
            await push();
        }
        if (msg?.type === 'openWorkspace') await vscode.commands.executeCommand('keepwork.openMcpWorkspace');
        if (msg?.type === 'changeWorkspace') {
            await vscode.commands.executeCommand('keepwork.changeMcpWorkspace');
            await push();
        }
        if (msg?.type === 'showTerminal') await vscode.commands.executeCommand('keepwork.showMcpTerminal');
        if (msg?.type === 'openDashboard') {
          await vscode.env.openExternal(vscode.Uri.parse(`${mcpBaseUrl()}/dashboard`));
        }
    }, undefined, context.subscriptions);

    return panel;
}

function panelHtml(isChinese: boolean): string {
  const text = isChinese ? {
    title: 'Keepwork 本地 MCP', restart: '重启服务', stop: '停止', token: '复制令牌',
    openDir: '打开工作目录', changeDir: '更改工作目录', terminal: '显示终端',
    dashboard: '打开控制面板', refresh: '刷新', loading: '正在加载…', clients: '客户端',
    history: '调用记录', notRunning: '服务未运行。点击“重启服务”启动。',
    root: '工作目录：', adminFailed: '服务已启动，但管理接口不可用（请检查 ~/.keepwork-mcp/token）。',
    running: '状态：<b>运行中</b>', url: '地址：', pid: '进程号：', port: '端口：',
    uptime: '运行时间：', terminalInfo: '终端：复用 VS Code Keepwork 面板。点击“显示终端”可在底部打开。',
    noClients: '暂无连接的 AIChat 会话。', noCalls: '暂无工具调用记录。',
    session: '会话', origin: '来源', connected: '连接时间', lastSeen: '最近活动', calls: '调用数',
    time: '时间', client: '客户端', tool: '工具', summary: '摘要', result: '结果',
    newer: '较新', older: '较旧', of: '共',
  } : {
    title: 'Keepwork local MCP', restart: 'Restart', stop: 'Stop', token: 'Copy token',
    openDir: 'Open directory', changeDir: 'Change directory', terminal: 'Show terminal',
    dashboard: 'Open Dashboard', refresh: 'Refresh', loading: 'Loading…', clients: 'Clients',
    history: 'History', notRunning: 'Daemon is not running. Click Restart to start it.',
    root: 'Working directory: ', adminFailed: 'Daemon is up but admin API failed (check pairing token in ~/.keepwork-mcp/token).',
    running: 'Status: <b>running</b>', url: 'URL: ', pid: 'pid: ', port: 'port: ',
    uptime: 'uptime: ', terminalInfo: 'terminal: VS Code <b>Keepwork</b> panel (reused). Show terminal opens it at the bottom.',
    noClients: 'No connected AIChat sessions.', noCalls: 'No tool calls yet.',
    session: 'Session', origin: 'Origin', connected: 'Connected', lastSeen: 'Last seen', calls: 'Calls',
    time: 'Time', client: 'Client', tool: 'Tool', summary: 'Summary', result: 'Result',
    newer: 'Newer', older: 'Older', of: 'of',
  };
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family, ui-sans-serif, system-ui); padding: 16px; color: var(--vscode-foreground); }
h1 { font-size: 16px; margin: 0 0 12px; }
h2 { font-size: 13px; margin: 20px 0 8px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 12px; cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.meta { font-size: 12px; line-height: 1.6; opacity: .9; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); vertical-align: top; }
.ok { color: var(--vscode-testing-iconPassed, #3c3); }
.fail { color: var(--vscode-testing-iconFailed, #c33); }
code { font-size: 11px; }
.empty { opacity: .6; }
.pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; }
.pager span { opacity: .85; }
button:disabled { opacity: .45; cursor: default; }
</style>
</head>
<body>
<h1>${text.title}</h1>
<div class="row">
  <button id="restart">${text.restart}</button>
  <button id="stop" class="secondary">${text.stop}</button>
  <button id="copy" class="secondary">${text.token}</button>
  <button id="openDir" class="secondary">${text.openDir}</button>
  <button id="changeDir" class="secondary">${text.changeDir}</button>
  <button id="showTerm" class="secondary">${text.terminal}</button>
  <button id="dashboard" class="secondary">${text.dashboard}</button>
  <button id="refresh" class="secondary">${text.refresh}</button>
</div>
<div class="meta" id="meta">${text.loading}</div>
<h2>${text.clients}</h2>
<div id="clients"></div>
<h2>${text.history}</h2>
<div id="history"></div>
<script>
const vscode = acquireVsCodeApi();
const text = ${JSON.stringify(text)};
document.getElementById('restart').onclick = () => vscode.postMessage({ type: 'restart' });
document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
document.getElementById('copy').onclick = () => vscode.postMessage({ type: 'copyToken' });
document.getElementById('openDir').onclick = () => vscode.postMessage({ type: 'openWorkspace' });
document.getElementById('changeDir').onclick = () => vscode.postMessage({ type: 'changeWorkspace' });
document.getElementById('showTerm').onclick = () => vscode.postMessage({ type: 'showTerminal' });
document.getElementById('dashboard').onclick = () => vscode.postMessage({ type: 'openDashboard' });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function short(id) { return (id || '').slice(0, 8) || '—'; }

window.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};
  if (type !== 'update') return;
  const st = payload.status;
  const meta = document.getElementById('meta');
  const root = esc(payload.workspaceRoot || (st && st.workspaceRoot) || '');
  if (!payload.healthOk) {
    meta.innerHTML = text.notRunning
      + (root ? '<br>' + text.root + '<code>' + root + '</code>' : '');
  } else if (!st) {
    meta.innerHTML = text.adminFailed;
  } else {
    meta.innerHTML = [
      text.running,
      text.url + '<code>' + esc(payload.baseUrl) + '/mcp</code>',
      text.pid + esc(st.pid),
      text.port + esc(st.port),
      text.root + '<code>' + esc(st.workspaceRoot || payload.workspaceRoot) + '</code>',
      text.uptime + Math.round((st.uptimeMs || 0) / 1000) + 's',
      text.terminalInfo,
    ].join('<br>');
  }
  const clients = (st && st.clients) || [];
  const ch = document.getElementById('clients');
  if (!clients.length) {
    ch.innerHTML = '<p class="empty">' + text.noClients + '</p>';
  } else {
    ch.innerHTML = '<table><thead><tr><th>' + text.session + '</th><th>' + text.origin + '</th><th>' + text.connected + '</th><th>' + text.lastSeen + '</th><th>' + text.calls + '</th></tr></thead><tbody>'
      + clients.map(c => '<tr><td><code>' + esc(short(c.sessionId)) + '</code></td><td>' + esc(c.origin || '—') + '</td><td>' + esc(c.connectedAt) + '</td><td>' + esc(c.lastSeenAt) + '</td><td>' + esc(c.callCount) + '</td></tr>').join('')
      + '</tbody></table>';
  }
  const hist = payload.history || [];
  const hh = document.getElementById('history');
  const total = payload.historyTotal || 0;
  const offset = payload.historyOffset || 0;
  const limit = payload.historyLimit || 20;
  const hasMore = !!payload.historyHasMore;
  if (!total && !hist.length) {
    hh.innerHTML = '<p class="empty">' + text.noCalls + '</p>';
  } else {
    const from = hist.length ? offset + 1 : 0;
    const to = offset + hist.length;
    const prevOff = Math.max(0, offset - limit);
    const nextOff = offset + limit;
    hh.innerHTML = (hist.length
      ? '<table><thead><tr><th>' + text.time + '</th><th>' + text.client + '</th><th>' + text.tool + '</th><th>' + text.summary + '</th><th>' + text.result + '</th><th>ms</th></tr></thead><tbody>'
        + hist.map(h => '<tr><td>' + esc(h.time) + '</td><td><code>' + esc(short(h.sessionId)) + '</code></td><td>' + esc(h.tool) + '</td><td>' + esc(h.summary) + '</td><td class="' + (h.ok ? 'ok' : 'fail') + '">' + (h.ok ? 'ok' : esc(h.error || 'fail')) + '</td><td>' + esc(h.durationMs) + '</td></tr>').join('')
        + '</tbody></table>'
      : '<p class="empty">' + text.noCalls + '</p>')
      + '<div class="pager">'
      + '<button id="histPrev" class="secondary"' + (offset <= 0 ? ' disabled' : '') + '>' + text.newer + '</button>'
      + '<span>' + from + '–' + to + ' ' + text.of + ' ' + total + '</span>'
      + '<button id="histNext" class="secondary"' + (hasMore ? '' : ' disabled') + '>' + text.older + '</button>'
      + '</div>';
    const prev = document.getElementById('histPrev');
    const next = document.getElementById('histNext');
    if (prev && offset > 0) prev.onclick = () => vscode.postMessage({ type: 'historyPage', offset: prevOff });
    if (next && hasMore) next.onclick = () => vscode.postMessage({ type: 'historyPage', offset: nextOff });
  }
});
</script>
</body>
</html>`;
}
