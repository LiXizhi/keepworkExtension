const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { chromium } = require('playwright-core');
function load(file, mocks) {
    const api = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { exports: api, URL, require: name => Object.hasOwn(mocks, name) ? mocks[name] : createRequire(file)(name) });
    return api;
}

test('real iframe folder picker and file provider use native relay with MCP disabled', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-native-browser-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = path.join(dir, 'chosen'); fs.mkdirSync(folder);
    let selected = [{ scheme: 'file', fsPath: folder }], dialogs = 0;
    const native = load(path.resolve(__dirname, '../src/vscode/brainNative.ts'), { vscode: {
        window: { showOpenDialog: async () => { dialogs++; return selected; } },
    } }).createBrainNative({ globalStorageUri: { fsPath: dir } });
    const api = load(path.resolve(__dirname, '../src/vscode/secondBrain.ts'), { vscode: {}, './brainModels': {}, './brainNative': {}, './brainDevelopment': {}, './daemon': {}, '../../../../src/core/config': {} });
    const source = process.env.AICHAT_SOURCE_DIR || path.resolve(__dirname, '../../../../apps/official/apps/tools/AIChat');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const wrapper = 'https://fixture.vscode-cdn.net', app = 'http://127.0.0.1:3001';
    await page.exposeFunction('nativeCall', async message => {
        try { return { type: 'native-result', session: message.session, requestId: message.requestId, ok: true, result: await native(message.method, message.args) }; }
        catch (error) { return { type: 'native-result', session: message.session, requestId: message.requestId, ok: false, error: error.message }; }
    });
    await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ async postMessage(message) {
            if (message.type === 'ready') window.postMessage({ type: 'second-brain-config', labels: {}, config: { locale: 'en', nativeHost: { version: 1, files: true, session: 'browser' }, localMcp: { enabled: false } } }, window.origin);
            if (message.type === 'native-request') window.postMessage(await window.nativeCall(message), window.origin);
        } });
    });
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === wrapper) return route.fulfill({ contentType: 'text/html', body: api.brainWebviewHTML(new URL(app + '/AIChat.html'), 'en', 'dark', 'test') });
        if (url.origin !== app) return route.abort();
        if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(source, url.pathname.slice(1)), 'utf8') });
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<meta charset="utf-8"><button id="choose">Choose</button><output id="result"></output><script type="module">
            import { pickLocalFolder } from './js/folder_picker.js';
            import { keepworkWriteText, keepworkReadBlob } from './js/keepwork_fs.js';
            import { hasDesktopFiles } from './js/desktop.js';
            window.nativeReady = hasDesktopFiles;
            document.querySelector('#choose').onclick = async () => {
                try {
                    const root = await pickLocalFolder();
                    if (!root) { document.querySelector('#result').textContent = 'cancelled'; return; }
                    await keepworkWriteText(root, 'hello.txt', 'native 你好');
                    document.querySelector('#result').textContent = await (await keepworkReadBlob(root, 'hello.txt')).text();
                } catch(error) { document.querySelector('#result').textContent = error.message; }
            };
            parent.postMessage({ channel:'aichat.external-tool.v1', type:'host:ready', capabilities:['second-brain-sidebar'] }, '*');
        </script>` });
    });
    await page.goto(wrapper);
    const frame = page.frames().find(frame => frame.url().startsWith(app));
    try { await frame.waitForFunction(() => window.nativeReady?.(), null, { timeout: 10000 }); }
    catch (error) { error.message += '\n' + errors.join('\n'); throw error; }
    await frame.click('#choose');
    await frame.waitForFunction(() => document.querySelector('#result').textContent, null, { timeout: 10000 });
    assert.equal(await frame.locator('#result').textContent(), 'native 你好', errors.join('\n'));
    assert.equal(fs.readFileSync(path.join(folder, 'hello.txt'), 'utf8'), 'native 你好');
    assert.equal(await frame.locator('dialog').count(), 0);
    selected = undefined;
    await frame.click('#choose');
    await frame.waitForFunction(() => document.querySelector('#result').textContent === 'cancelled');
    assert.equal(dialogs, 2);
});

