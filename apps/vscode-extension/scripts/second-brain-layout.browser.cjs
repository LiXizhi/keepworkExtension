// Explicit browser regression: node --test scripts/second-brain-layout.browser.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { chromium } = require('playwright-core');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/vscode/secondBrain.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, URL, require: name => name === 'node:path' || name === 'node:crypto' ? require(name) : {} });

test('AIChat fills the webview; recovery UI appears only on errors; local timeout requests fallback', async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    let result = true, announce = true;
    await page.addInitScript(() => {
        window.messages = [];
        window.acquireVsCodeApi = () => ({ postMessage(message) {
            window.messages.push(message);
            if (message.type === 'ready') window.postMessage({ type: 'second-brain-config', labels: { retry: 'Retry', status: 'MCP status', browser: 'Open in browser', timeout: 'AIChat did not respond.' }, config: { locale: 'en', localMcp: { enabled: true } } }, '*');
        } });
    });
    await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname === 'wrapper.test') {
            const html = api.brainWebviewHTML(new URL('http://127.0.0.1:3001/AIChat.html'), 'en', 'dark', 'fixture')
                .replace('<head>', '<head><style nonce="fixture">body{padding:0 20px}</style>');
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        return route.fulfill({ contentType: 'text/html', body: `<body>AIChat fixture<script>
            const channel='aichat.external-tool.v1';
            window.addEventListener('message', event => { if(event.data.type==='host:config') parent.postMessage({ channel, type:'host:config-result', requestId:event.data.requestId, ok:${result} }, '*'); });
            ${announce ? "parent.postMessage({channel,type:'host:ready',capabilities:['second-brain-sidebar']},'*');" : ''}
        </script>` });
    });
    for (const width of [360, 800]) {
        await page.setViewportSize({ width, height: 700 });
        await page.goto('http://wrapper.test/');
        await page.waitForFunction(() => window.messages.some(message => message.type === 'ready'));
        const bounds = await page.locator('#chat').boundingBox();
        assert.deepEqual(bounds, { x: 0, y: 0, width, height: 700 });
        assert.equal(await page.locator('#notice').isVisible(), false);
    }
    result = false;
    await page.reload();
    await page.locator('#notice').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.equal(await page.evaluate(() => window.messages.at(-1).type), 'retry');
    announce = false;
    await page.clock.install();
    await page.reload();
    await page.clock.fastForward(31000);
    assert.equal(await page.evaluate(() => window.messages.at(-1).type), 'fallback');
});
