const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function fixture() {
    const state = { port: 8097, starts: 0, language: 'en', requireAuth: true, health: true, messages: [], settings: {}, htmlWrites: 0, opened: [] };
    const disposable = { dispose() {} };
    const vscode = {
        ColorThemeKind: { Light: 1, Dark: 2, HighContrastLight: 4 }, env: { language: 'en', openExternal: async uri => state.opened.push(uri) }, Uri: { parse: x => x },
        window: { activeColorTheme: { kind: 2 }, showErrorMessage() {}, registerWebviewViewProvider(id, provider, options) { Object.assign(state, { id, provider, options }); return disposable; }, onDidChangeActiveColorTheme(fn) { state.theme = fn; return disposable; } },
        commands: { registerCommand(id, fn) { state.command = fn; state.commandId = id; return disposable; }, executeCommand: async id => state.executed = id },
        workspace: { getConfiguration: name => ({ get: (key, fallback) => state.settings[name + '.' + key] ?? fallback }), onDidChangeConfiguration(fn) { state.change = fn; return disposable; } },
    };
    const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/vscode/secondBrain.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, URL, require(name) {
        if (name === 'vscode') return vscode;
        if (name.endsWith('/config')) return { readToken: () => 'fixture-token' };
        if (name === './daemon') return { mcpEnabled: () => true, mcpBaseUrl: () => `http://127.0.0.1:${state.port}`, probeHealth: async () => ({ ok: state.health, requireAuth: state.requireAuth }), ensureDaemon: async () => { state.starts++; return { ok: state.health, requireAuth: state.requireAuth }; } };
        return require(name);
    } });
    exports.registerSecondBrain({ subscriptions: [] });
    state.view = { webview: { set html(value) { state.html = value; state.htmlWrites++; }, postMessage: async m => state.messages.push(m), onDidReceiveMessage(fn) { state.receive = fn; return disposable; } }, onDidDispose(fn) { state.dispose = fn; } };
    state.provider.resolveWebviewView(state.view);
    return { state, api: exports, vscode };
}
test('sidebar restores rather than forcing new chats; credentials are sent only on ready and refreshed with configuration', async () => {
    const { state } = fixture();
    assert.equal(state.id, 'keepwork.secondBrain');
    assert.equal(state.options.webviewOptions.retainContextWhenHidden, true);
    assert.match(state.html, /chat=keep/); assert.match(state.html, /localOnly=1/);
    assert.doesNotMatch(state.html, /fixture-token/); assert.equal(state.starts, 0);
    await state.receive({ type: 'ready' });
    assert.equal(state.starts, 1);
    assert.equal(state.messages.at(-1).config.localMcp.url, 'http://127.0.0.1:8097');
    assert.equal(state.messages.at(-1).config.localMcp.token, 'fixture-token');
    state.requireAuth = false;
    await state.receive({ type: 'ready' });
    assert.equal(state.messages.at(-1).config.localMcp.token, '');
    const writes = state.htmlWrites;
    state.theme(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.htmlWrites, writes, 'theme update preserves iframe');
    await state.receive({ type: 'browser', url: 'https://attacker.invalid' });
    assert.equal(state.opened[0], state.api?.SECOND_BRAIN_URL || 'https://keepwork.com/official/apps/tools/AIChat/AIChat.html');
    state.dispose(); await state.receive({ type: 'ready' }); assert.equal(state.starts, 2);
});
test('development entry accepts only bare loopback HTTP URLs and locale follows VS Code', () => {
    const { api } = fixture();
    for (const url of ['https://attacker.invalid', 'http://127.0.0.1.evil/AIChat.html', 'http://u:p@localhost/a', 'http://localhost/a?token=secret', 'file:///tmp/a']) assert.throws(() => api.brainEntryURL(url));
    assert.equal(api.brainEntryURL('http://127.0.0.1:3000/AIChat.html').port, '3000');
    assert.equal(api.brainLocale('auto', 'zh-cn'), 'zh-CN'); assert.equal(api.brainLocale('en', 'zh-cn'), 'en');
});
test('wrapper ignores unrelated frames and origins and requires advertised capability before passing configuration', () => {
    const { state } = fixture();
    const posted = [], outbound = [], nodes = new Map();
    const frameWindow = { postMessage: (...args) => outbound.push(args) };
    for (const id of ['chat', 'status', 'retry', 'mcp', 'browser']) nodes.set(id, { contentWindow: frameWindow });
    let listener;
    const win = { origin: 'vscode-webview://fixture', addEventListener(type, fn) { listener = fn; } };
    vm.runInNewContext(state.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1], { acquireVsCodeApi: () => ({ postMessage: m => posted.push(m) }), document: { getElementById: id => nodes.get(id), documentElement: {} }, window: win, setTimeout: () => 1, clearTimeout() {} });
    const msg = { channel: 'aichat.external-tool.v1', type: 'host:ready', capabilities: ['second-brain-sidebar'] };
    listener({ source: {}, origin: 'https://keepwork.com', data: msg });
    listener({ source: frameWindow, origin: 'https://evil.invalid', data: msg });
    listener({ source: { parent: {} }, origin: 'https://keepwork.com', data: msg });
    assert.equal(posted.length, 0);
    listener({ source: frameWindow, origin: 'https://keepwork.com', data: { ...msg, capabilities: [] } });
    assert.equal(posted.length, 0, 'older hosted pages never receive credentials');
    listener({ source: frameWindow, origin: 'https://keepwork.com', data: msg });
    assert.equal(posted[0].type, 'ready');
    listener({ source: {}, origin: win.origin, data: { type: 'second-brain-config', config: { locale: 'en', localMcp: { token: 'test-secret' } }, labels: { status: 'MCP', retry: 'Retry', browser: 'Browser' } } });
    assert.equal(outbound[0][1], 'https://keepwork.com');
    assert.equal(outbound[0][0].config.localMcp.token, 'test-secret');
    assert.equal(posted.length, 1, 'no transcript, token or arbitrary payload is relayed to VS Code');
    const nested = [];
    listener({ source: { parent: frameWindow, postMessage: (...args) => nested.push(args) }, origin: 'https://keepwork.com', data: msg });
    listener({ source: {}, origin: win.origin, data: { type: 'second-brain-config', config: { locale: 'en', localMcp: { token: 'test-secret' } }, labels: {} } });
    assert.equal(nested[0][0].config.localMcp.token, 'test-secret', 'canonical srcdoc child receives the handshake directly');
});
