import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readToken } from '../../../../src/core/config';
import { ensureDaemon, mcpBaseUrl, mcpEnabled, probeHealth } from './daemon';

export const SECOND_BRAIN_URL = 'https://keepwork.com/official/apps/tools/AIChat/AIChat.html';
export function brainEntryURL(override = ''): URL {
    const url = new URL(override || SECOND_BRAIN_URL);
    if (override && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('Second Brain development URL must use loopback HTTP.');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('Use an entry URL without credentials, query or fragment.');
    return url;
}
export function brainLocale(setting: string, language: string): 'en' | 'zh-CN' {
    return setting === 'zh-CN' || setting === 'auto' && /^zh\b/i.test(language) ? 'zh-CN' : 'en';
}
const labels = {
    en: { loading: 'Loading Second Brain…', retry: 'Retry', status: 'MCP status', browser: 'Open in browser', connected: 'MCP connected', disconnected: 'MCP unavailable — retry or check status', timeout: 'AIChat did not respond. Retry or open in browser.', update: 'This AIChat page needs the sidebar update. Retry after the website is updated.' },
    'zh-CN': { loading: '正在加载第二大脑…', retry: '重试', status: 'MCP 状态', browser: '在浏览器打开', connected: 'MCP 已连接', disconnected: 'MCP 不可用，请重试或查看状态', timeout: 'AIChat 未响应，请重试或在浏览器打开。', update: '此 AIChat 页面尚未支持侧栏，请在网站更新后重试。' },
};
function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

export function brainWebviewHTML(entry: URL, locale: 'en' | 'zh-CN', theme: string, nonce: string): string {
    const url = new URL(entry);
    const config = { experience: 'simple', locale, theme, chat: 'keep', localOnly: '1' };
    Object.entries(config).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('hide', 'client');
    if (entry.href === SECOND_BRAIN_URL) url.searchParams.set('sidebar', 'second-brain');
    const data = JSON.stringify({ origin: url.origin, labels: labels[locale] }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="${locale}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(url.origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
html,body{height:100%;margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}body{display:flex;flex-direction:column}header{padding:6px;display:flex;gap:6px;flex-wrap:wrap}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:5px;cursor:pointer}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}#status{padding:0 8px 6px}iframe{border:0;flex:1;width:100%;min-height:0}
</style></head><body><header><button id="retry">${labels[locale].retry}</button><button id="mcp">${labels[locale].status}</button><button id="browser">${labels[locale].browser}</button></header><div id="status" role="status">${labels[locale].loading}</div>
<iframe id="chat" title="${locale === 'en' ? 'Second Brain' : '第二大脑'}" src="${escape(url.href)}" allow="clipboard-read; clipboard-write; microphone; camera; local-network-access" referrerpolicy="origin"></iframe>
<script nonce="${nonce}">
(() => {
 const vscode = acquireVsCodeApi(), data = ${data}, frame = document.getElementById('chat'), status = document.getElementById('status');
 const channel = 'aichat.external-tool.v1'; let ready = false, appWindow = null, config = null, sequence = 0, requestId = '';
 let timer = setTimeout(() => { status.textContent = data.labels.timeout; }, 30000);
 const send = () => { if (ready && config) { requestId = 'sidebar-' + (++sequence); appWindow.postMessage({channel,type:'host:config',requestId,config}, data.origin); } };
 document.getElementById('retry').onclick = () => vscode.postMessage({type:'retry'});
 document.getElementById('mcp').onclick = () => vscode.postMessage({type:'status'});
 document.getElementById('browser').onclick = () => vscode.postMessage({type:'browser'});
 window.addEventListener('message', event => {
   // The canonical Keepwork page renders AIChat as its immediate srcdoc child.
   const fromApp = event.source === frame.contentWindow || (data.origin === 'https://keepwork.com' && event.source?.parent === frame.contentWindow);
   if (fromApp) {
     if (event.origin !== data.origin || event.data?.channel !== channel) return;
     const msg = event.data;
     if (msg.type === 'host:ready') {
       clearTimeout(timer);
       if (!msg.capabilities?.includes('second-brain-sidebar')) { status.textContent = data.labels.update; return; }
       appWindow = event.source; ready = true; vscode.postMessage({type:'ready'});
     }
     if (msg.type === 'host:config-result' && msg.requestId === requestId) {
       status.textContent = msg.ok ? (config?.localMcp?.enabled ? data.labels.connected : data.labels.disconnected) : data.labels.timeout;
     }
     return;
   }
   // VS Code replaces window.parent with window; its real outer frame posts from
   // the same webview origin. The hosted app can never enter this branch.
   if (event.source !== null && event.source !== window && event.origin !== window.origin) return;
   if (event.data?.type !== 'second-brain-config') return;
   config = event.data.config; data.labels = event.data.labels;
   document.documentElement.lang = config.locale;
   for (const [id,key] of [['retry','retry'],['mcp','status'],['browser','browser']]) document.getElementById(id).textContent = data.labels[key];
   send();
 });
})();
</script></body></html>`;
}

export function registerSecondBrain(context: vscode.ExtensionContext): void {
    let current: vscode.WebviewView | undefined;
    const locale = () => brainLocale(vscode.workspace.getConfiguration('keepwork.secondBrain').get('language', 'auto'), vscode.env.language);
    const theme = () => [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
    const entry = () => brainEntryURL(vscode.workspace.getConfiguration('keepwork.secondBrain').get('developmentUrl', ''));
    let request = 0;
    async function configure(start = false) {
        const view = current, ticket = ++request;
        if (!view) return;
        const health = mcpEnabled() ? await (start ? ensureDaemon(context) : probeHealth()) : { ok: false };
        if (view !== current || ticket !== request) return;
        await view.webview.postMessage({ type: 'second-brain-config', labels: labels[locale()], config: {
            experience: 'simple', locale: locale(), theme: theme(), chat: 'keep',
            sessionPersistence: { localOnly: true },
            localMcp: { url: mcpBaseUrl(), enabled: health.ok, token: health.ok && health.requireAuth ? readToken() || '' : '' },
        } });
    }
    function render(view: vscode.WebviewView) {
        try { view.webview.html = brainWebviewHTML(entry(), locale(), theme(), randomBytes(18).toString('hex')); }
        catch (error) { view.webview.html = `<p>${escape(String(error instanceof Error ? error.message : error))}</p>`; }
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('keepwork.secondBrain', {
        resolveWebviewView(view) {
            current = view;
            view.webview.options = { enableScripts: true, localResourceRoots: [] };
            const listener = view.webview.onDidReceiveMessage(async message => {
                if (current !== view) return;
                if (message?.type === 'ready') await configure(true);
                if (message?.type === 'retry') render(view);
                if (message?.type === 'status') await vscode.commands.executeCommand('keepwork.showMcpServer');
                if (message?.type === 'browser') {
                    try { await vscode.env.openExternal(vscode.Uri.parse(entry().href)); }
                    catch (error) { vscode.window.showErrorMessage(String(error)); }
                }
            });
            view.onDidDispose(() => { listener.dispose(); if (current === view) { current = undefined; request++; } });
            render(view);
        },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('keepwork.openSecondBrain', () => vscode.commands.executeCommand('keepwork.secondBrain.focus')),
    vscode.window.onDidChangeActiveColorTheme(() => { void configure(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('keepwork.secondBrain.developmentUrl')) { if (current) render(current); }
        else if (event.affectsConfiguration('keepwork.secondBrain.language') || event.affectsConfiguration('keepwork.mcp')) void configure(true);
    }));
}
