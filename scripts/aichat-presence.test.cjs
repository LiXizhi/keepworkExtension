const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/core/aichatPresence.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { tryHandleAichatPresence, latestAichatClient, rememberAichatClient } = mod.exports;

test('legacy presence and SSE share validation, never echo login, clean up and retain latest client', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const streams = new Map();
    const server = http.createServer((req, res) => void tryHandleAichatPresence(req, res, id => id === 'live', streams));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/aichat/presence`;
    const headers = { Origin: 'https://keepwork.com', 'Mcp-Session-Id': 'live', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ url: 'https://keepwork.com/chat?token=secret&layout=thin', token: 'fixture-login' });
    const abort = new AbortController();
    try {
        const legacy = await fetch(url, { method: 'POST', headers, body });
        assert.equal(legacy.status, 200);
        assert.deepEqual(await legacy.json(), { remembered: true });
        assert.equal(latestAichatClient().url, 'https://keepwork.com/chat?layout=thin');
        assert.equal(latestAichatClient().token, 'fixture-login');
        for (const suffix of ['', '?stream=1']) {
            assert.equal((await fetch(url + suffix, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status, 403);
            assert.equal((await fetch(url + suffix, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': 'dead' }, body })).status, 401);
            assert.equal((await fetch(url + suffix, { method: 'POST', headers, body: '{}' })).status, 400);
        }
        const stream = await fetch(url + '?stream=1', { method: 'POST', headers, body, signal: abort.signal });
        assert.equal(stream.status, 200);
        assert.equal(stream.headers.get('content-type'), 'text/event-stream');
        const reader = stream.body.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'event: ready\ndata: {}\n\n');
        assert.equal(streams.size, 1);
        rememberAichatClient({ sessionId: 'newer-tab', url: 'https://keepwork.com/chat', token: 'newer-login' });
        t.mock.timers.tick(25000);
        assert.equal(new TextDecoder().decode((await reader.read()).value), ': presence\n\n');
        assert.equal(latestAichatClient().token, 'newer-login', 'old stream heartbeats must not overwrite newer login');
        const replacement = await fetch(url + '?stream=1', { method: 'POST', headers, body, signal: abort.signal });
        assert.equal(streams.size, 1);
        assert.equal((await reader.read()).done, true);
        assert.equal(replacement.status, 200);
        abort.abort();
        for (let i = 0; i < 50 && streams.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(streams.size, 0);
        assert.equal(latestAichatClient().token, 'fixture-login');
    } finally {
        abort.abort();
        for (const response of streams.values()) response.end();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
