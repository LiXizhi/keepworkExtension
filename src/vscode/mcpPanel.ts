import * as vscode from 'vscode';
import { HISTORY_PAGE_DEFAULT, readToken } from '../core/config';
import { configuredRoot, ensureDaemon, fetchAdminHistory, fetchAdminStatus, probeHealth, stopDaemon } from './daemon';
import { formatPanelPayload } from './statusBar';

export function openMcpPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'keepworkMcp',
        'Keepwork MCP',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.webview.html = panelHtml();
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
        if (msg?.type === 'start') {
            const result = await ensureDaemon(context);
            if (!result.ok) vscode.window.showErrorMessage(`Keepwork MCP: ${result.error || 'failed to start'}`);
            await push();
        }
        if (msg?.type === 'stop') {
            const ok = await stopDaemon();
            if (!ok) vscode.window.showWarningMessage('Keepwork MCP: stop failed (is the daemon running?)');
            await new Promise(r => setTimeout(r, 400));
            await push();
        }
        if (msg?.type === 'copyToken') {
            const token = readToken();
            if (!token) {
                vscode.window.showWarningMessage('No pairing token yet. Start the MCP server first.');
                return;
            }
            await vscode.env.clipboard.writeText(token);
            vscode.window.showInformationMessage('Keepwork MCP token copied');
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
    }, undefined, context.subscriptions);

    return panel;
}

function panelHtml(): string {
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
<h1>Keepwork local MCP</h1>
<div class="row">
  <button id="start">Start</button>
  <button id="stop" class="secondary">Stop</button>
  <button id="copy" class="secondary">Copy token</button>
  <button id="openDir" class="secondary">Open directory</button>
  <button id="changeDir" class="secondary">Change directory</button>
  <button id="showTerm" class="secondary">Show terminal</button>
  <button id="refresh" class="secondary">Refresh</button>
</div>
<div class="meta" id="meta">Loading…</div>
<h2>Clients</h2>
<div id="clients"></div>
<h2>History</h2>
<div id="history"></div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('start').onclick = () => vscode.postMessage({ type: 'start' });
document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
document.getElementById('copy').onclick = () => vscode.postMessage({ type: 'copyToken' });
document.getElementById('openDir').onclick = () => vscode.postMessage({ type: 'openWorkspace' });
document.getElementById('changeDir').onclick = () => vscode.postMessage({ type: 'changeWorkspace' });
document.getElementById('showTerm').onclick = () => vscode.postMessage({ type: 'showTerminal' });
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
    meta.innerHTML = 'Daemon is <b>not running</b>. Click Start, or run <code>npm start</code> in keepworkExtension.'
      + (root ? '<br>Working directory: <code>' + root + '</code>' : '');
  } else if (!st) {
    meta.innerHTML = 'Daemon is up but admin API failed (check pairing token in ~/.keepwork-mcp/token).';
  } else {
    meta.innerHTML = [
      'Status: <b>running</b>',
      'URL: <code>' + esc(payload.baseUrl) + '/mcp</code>',
      'pid: ' + esc(st.pid),
      'port: ' + esc(st.port),
      'root: <code>' + esc(st.workspaceRoot || payload.workspaceRoot) + '</code>',
      'uptime: ' + Math.round((st.uptimeMs || 0) / 1000) + 's',
      'terminal: VS Code <b>Keepwork</b> panel (reused). Show terminal opens it at the bottom.',
    ].join('<br>');
  }
  const clients = (st && st.clients) || [];
  const ch = document.getElementById('clients');
  if (!clients.length) {
    ch.innerHTML = '<p class="empty">No connected AIChat sessions.</p>';
  } else {
    ch.innerHTML = '<table><thead><tr><th>Session</th><th>Origin</th><th>Connected</th><th>Last seen</th><th>Calls</th></tr></thead><tbody>'
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
    hh.innerHTML = '<p class="empty">No tool calls yet.</p>';
  } else {
    const from = hist.length ? offset + 1 : 0;
    const to = offset + hist.length;
    const prevOff = Math.max(0, offset - limit);
    const nextOff = offset + limit;
    hh.innerHTML = (hist.length
      ? '<table><thead><tr><th>Time</th><th>Client</th><th>Tool</th><th>Summary</th><th>Result</th><th>ms</th></tr></thead><tbody>'
        + hist.map(h => '<tr><td>' + esc(h.time) + '</td><td><code>' + esc(short(h.sessionId)) + '</code></td><td>' + esc(h.tool) + '</td><td>' + esc(h.summary) + '</td><td class="' + (h.ok ? 'ok' : 'fail') + '">' + (h.ok ? 'ok' : esc(h.error || 'fail')) + '</td><td>' + esc(h.durationMs) + '</td></tr>').join('')
        + '</tbody></table>'
      : '<p class="empty">No tool calls on this page.</p>')
      + '<div class="pager">'
      + '<button id="histPrev" class="secondary"' + (offset <= 0 ? ' disabled' : '') + '>Newer</button>'
      + '<span>' + from + '–' + to + ' of ' + total + '</span>'
      + '<button id="histNext" class="secondary"' + (hasMore ? '' : ' disabled') + '>Older</button>'
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
