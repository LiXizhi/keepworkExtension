const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { ManagedBrowserManager, browserUrl, browserRedact } = require('../src/core/browser.ts');
const { browserToolSchemas } = require('../src/mcp/browserTools.ts');
const { resolveBrowser } = require('../src/core/headless.ts');

test('browser schema and URL boundaries', () => {
    for (const url of ['file:///c:/secret', 'javascript:alert(1)', 'chrome://settings', 'https://user:pass@example.com']) assert.throws(() => browserUrl(url));
    assert.equal(browserUrl('http://localhost:5500/'), 'http://localhost:5500/');
    assert.match(browserRedact('token=abc password:private'), /redacted/);
    assert.doesNotMatch(browserRedact('token=abc password:private'), /abc|private/);
    assert.equal(browserToolSchemas.browser_action.safeParse({ treeId: 'a', sessionId: 'b', action: 'evaluate', code: '1' }).success, false);
    assert.equal(browserToolSchemas.browser_session.safeParse({ treeId: 'a\nb', action: 'list' }).success, false);
    assert.equal(browserToolSchemas.browser_action.safeParse({ treeId: 'a', sessionId: 'b', action: 'viewport', width: 99999 }).success, false);
});

test('discovery/listing does not launch; disconnected owners are rejected', async () => {
    const manager = new ManagedBrowserManager();
    assert.deepEqual(await manager.run('mcp\ntree', 'browser_session', { action: 'list' }), { sessions: [] });
    const headless = require('../src/core/headless.ts');
    const originalResolver = headless.resolveBrowser;
    try {
        headless.resolveBrowser = () => null;
        await assert.rejects(manager.run('mcp\ntree', 'browser_session', { action: 'create' }), /Install Edge or Chrome/);
        assert.deepEqual(await manager.run('mcp\ntree', 'browser_session', { action: 'list' }), { sessions: [] });
    } finally { headless.resolveBrowser = originalResolver; }
    await manager.closeOwner('mcp');
    await assert.rejects(manager.run('mcp\ntree', 'browser_session', { action: 'create' }), /disconnected/);
    await manager.closeAll();
});

test('managed browser DOM, diagnostics, screenshots, isolation and cleanup', { skip: !resolveBrowser(), timeout: 60000 }, async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/missing.png') { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><title>Browser fixture</title>
          <form onsubmit="event.preventDefault();document.querySelector('#result').textContent=document.querySelector('input').value">
          <input aria-label="Name"><button>Submit</button></form><div id="result"></div>
          <select><option>a</option><option>b</option></select><input type="checkbox" id="check">
          <input type="password" value="private-password"><div style="height:1800px"></div><h2 id="bottom">Bottom</h2>
          <script>console.log('token=private-token');setTimeout(()=>{throw Error('fixture-error')},20)</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const manager = new ManagedBrowserManager();
    const owner = 'mcp-a\ntree-a';
    try {
        const session = await manager.run(owner, 'browser_session', { action: 'create', url: `http://127.0.0.1:${server.address().port}/` });
        const target = { sessionId: session.sessionId, pageId: session.pages[0].pageId };
        const run = (name, args = {}) => manager.run(owner, name, { ...target, ...args });
        await assert.rejects(manager.run('mcp-b\ntree-a', 'browser_snapshot', target), /Unknown/);
        await assert.rejects(manager.run('mcp-a\ntree-b', 'browser_snapshot', target), /Unknown/);
        const snapshot = await run('browser_snapshot');
        assert.equal(snapshot.title, 'Browser fixture');
        assert.doesNotMatch(JSON.stringify(snapshot), /private-password/);
        const input = snapshot.elements.find(e => e.name === 'Name');
        await run('browser_action', { action: 'fill', ref: input.ref, value: 'Ada' });
        await run('browser_action', { action: 'press', ref: input.ref, key: 'Enter' });
        await run('browser_action', { action: 'assert', selector: '#result', assertion: 'textContains', expected: 'Ada' });
        await run('browser_action', { action: 'select', selector: 'select', value: 'b' });
        await run('browser_action', { action: 'click', selector: '#check' });
        await run('browser_action', { action: 'assert', selector: '#check', assertion: 'checked', expected: true });
        await run('browser_action', { action: 'assert', selector: '#absent', assertion: 'hidden' });
        await run('browser_action', { action: 'scroll', selector: '#bottom' });
        await run('browser_action', { action: 'viewport', width: 390, height: 844 });
        const shot = await run('browser_screenshot');
        assert.equal(shot.content[1].type, 'image');
        assert.equal(shot.content[1].mimeType, 'image/jpeg');
        assert.ok(Buffer.from(shot.content[1].data, 'base64').length > 100);
        assert.equal(JSON.parse(shot.content[0].text).viewport.width, 390);
        const diagnostics = await run('browser_diagnostics');
        assert.ok(diagnostics.entries.some(e => e.text.includes('fixture-error')));
        assert.doesNotMatch(JSON.stringify(diagnostics), /private-token/);
        assert.equal((await run('browser_diagnostics', { cursor: diagnostics.cursor })).entries.length, 0);
        await run('browser_snapshot');
        await assert.rejects(run('browser_action', { action: 'click', ref: input.ref }), /Stale/);
        await assert.rejects(run('browser_action', { action: 'waitFor', selector: '#absent', timeoutMs: 50 }), /Timeout/);
        await run('browser_action', { action: 'reload' });
        await manager.prune(Date.now() + 16 * 60_000);
        assert.deepEqual((await manager.run(owner, 'browser_session', { action: 'list' })).sessions, []);
    } finally {
        await manager.closeAll();
        await new Promise(resolve => server.close(resolve));
    }
});
