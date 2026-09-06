const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ts = require('typescript');

test('HTTP browser discovery, authentication, execution and session teardown', { timeout: 45000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-http-'));
    const oldHome = os.homedir;
    let server;
    try {
        os.homedir = () => home;
        require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
        const { startHttpServer } = require('../src/mcp/http.ts');
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        server = await startHttpServer({ port, root: home, requireAuth: true });
        const url = `http://127.0.0.1:${port}/mcp`;
        const headers = { Origin: 'http://localhost:5500', Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        assert.equal(health.browserApi, 'browser-v1');
        assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Authorization: '' }, body: '{}' })).status, 401);
        assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
        let id = 0;
        async function rpc(method, params) {
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
            if (response.headers.get('mcp-session-id')) headers['Mcp-Session-Id'] = response.headers.get('mcp-session-id');
            const text = await response.text();
            const body = text.startsWith('event:') || text.startsWith('data:')
                ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text);
            assert.equal(body.error, undefined, JSON.stringify(body.error));
            return body.result;
        }
        await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' } });
        const listed = await rpc('tools/list', {});
        assert.ok(listed.tools.some(t => t.name === 'browser_screenshot'));
        const call = args => rpc('tools/call', { name: 'browser_session', arguments: args });
        assert.deepEqual(JSON.parse((await call({ treeId: 'one', action: 'list' })).content[0].text).sessions, []);
        const created = await call({ treeId: 'one', action: 'create' });
        assert.equal(created.isError, undefined);
        const sessionId = JSON.parse(created.content[0].text).sessionId;
        assert.equal((await call({ treeId: 'two', action: 'close', sessionId })).isError, true);
        const oldSid = headers['Mcp-Session-Id'];
        await fetch(url, { method: 'DELETE', headers });
        const { managedBrowsers } = require('../src/core/browser.ts');
        await assert.rejects(managedBrowsers.run(oldSid + '\none', 'browser_session', { action: 'list' }), /disconnected/);
    } finally {
        if (server) await server.close();
        os.homedir = oldHome;
        assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(home).startsWith('keepwork-browser-http-'));
        fs.rmSync(home, { recursive: true, force: true });
    }
});
