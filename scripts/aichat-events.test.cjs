const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const ts = require('typescript');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const cache = new Map();
function load(relative) {
    const file = path.resolve(__dirname, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths;
    cache.set(file, mod);
    mod.require = id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id);
    mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
    return mod.exports;
}
const { attachAichatEvents } = load('../src/mcp/aichatEvents.ts');
const { registerMcpPresence } = load('../src/mcp/aichatPresence.ts');
const { requestContext } = load('../src/mcp/context.ts');
const { latestAichatClient } = load('../src/core/aichatPresence.ts');

test('two MCP sessions carry isolated persona changes on their existing GET; reconnect and shutdown clean watchers', async t => {
    const transports = new Map(), watchers = new Map();
    const personas = { watch(owner, change) { watchers.set(owner, change); return () => watchers.delete(owner); } };
    const server = http.createServer(async (req, res) => {
        const id = req.headers['mcp-session-id'];
        if (req.method === 'GET') {
            const transport = transports.get(id);
            attachAichatEvents(res, transport, personas, req.headers['x-agent-owner']);
            await transport.handleRequest(req, res); return;
        }
        let raw = ''; for await (const chunk of req) raw += chunk;
        if (id) {
            await requestContext.run({ sessionId: id, origin: String(req.headers.origin || ''), userAgent: '' }, () => transports.get(id).handleRequest(req, res, JSON.parse(raw)));
            return;
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => require('node:crypto').randomUUID(), enableJsonResponse: true,
            onsessioninitialized: sid => transports.set(sid, transport) });
        const mcp = new McpServer({ name: 'fixture', version: '1' });
        registerMcpPresence(mcp, id => transports.has(id));
        await mcp.connect(transport); await transport.handleRequest(req, res, JSON.parse(raw));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const controllers = [];
    t.after(async () => { controllers.forEach(c => c.abort()); for (const transport of transports.values()) await transport.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    async function open(owner, sid) {
        if (!sid) {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
            sid = response.headers.get('mcp-session-id');
            assert.equal((await response.json()).result.capabilities.experimental['keepwork/events'].presence, 'mcp-v1');
        }
        const controller = new AbortController(); controllers.push(controller);
        const response = await fetch(url, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid, 'X-Agent-Owner': owner }, signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /personas_changed/);
        return { controller, reader, sid };
    }
    const one = await open('owner-one'), two = await open('owner-two');
    async function presence(sid, params, origin = 'https://keepwork.com') {
        const response = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Mcp-Session-Id': sid, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'keepwork/presence', params }) });
        return response.json();
    }
    assert.deepEqual((await presence(one.sid, { url: 'https://keepwork.com/chat?token=hidden', token: 'first-login' })).result, { remembered: true });
    assert.equal(latestAichatClient().url, 'https://keepwork.com/chat');
    assert.equal(latestAichatClient().token, 'first-login');
    assert.deepEqual((await presence(two.sid, { url: 'https://keepwork.com/chat', token: 'second-login' })).result, { remembered: true });
    const rejected = await presence(one.sid, { url: 'https://keepwork.com/chat', token: 'do-not-echo', origin: 'https://keepwork.com' }, 'https://evil.example');
    assert.ok(rejected.error); assert.ok(!JSON.stringify(rejected).includes('do-not-echo'));
    assert.equal(latestAichatClient().token, 'second-login');
    assert.equal(watchers.size, 2);
    watchers.get('owner-one')();
    assert.match(new TextDecoder().decode((await one.reader.read()).value), /personas_changed/);
    one.controller.abort();
    for (let i = 0; i < 50 && watchers.size === 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(watchers.size, 1); assert.ok(watchers.has('owner-two'));
    await open('owner-one', one.sid);
    assert.equal(watchers.size, 2);
    assert.ok(!two.controller.signal.aborted);
});
