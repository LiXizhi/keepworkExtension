const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { paracraftResult, paracraftRequest, registerCreationTools } = require('../src/mcp/paracraftTools.ts');
const hub = require('../src/core/paracraftClients.ts');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('MCP image content separates bytes from metadata and refuses cache/error', () => {
    const result = paracraftResult(200, { ok: true, result: { ok: true, base64: 'AQID', mimeType: 'image/jpeg', sessionId: 4, timestamp: 123 } }, true);
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].data, 'AQID');
    assert.equal(JSON.parse(result.content[0].text).sessionId, 4);
    assert.ok(!result.content[0].text.includes('AQID'));
    assert.equal(paracraftResult(200, { result: { cached: true, base64: 'AQID', mimeType: 'image/jpeg' } }, true).isError, true);
    assert.equal(paracraftResult(200, { ok: false, error: 'unsupported action' }).isError, true);
});

test('standard MCP client sends jobs and receives native images through engine poll', async () => {
    const server = new McpServer({ name: 'creation-test', version: '1' });
    registerCreationTools(server, { port: 8089 });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const clientId = 'creation-mcp-test';
    await hub.registerClient({ clientId });
    const identity = { clientId, worldPath: 'test/', sessionId: 3 };
    try {
        const list = await client.listTools();
        assert.deepEqual(list.tools.map(t => t.name), ['paracraft_cli']);
        for (const [action, args, reply] of [
            ['run_code', { expectedIdentity: identity, requestId: 'same-id', code: 'wait(1); return 42' }, { ok: true, jobId: 'creation-1' }],
            ['code_job', { expectedIdentity: identity, jobId: 'creation-1', operation: 'status' }, { ok: true, state: 'completed', sourceCompleted: true }],
            ['camera_capture', { expectedIdentity: identity, nearPet: true }, { ok: true, base64: 'AQID', mimeType: 'image/jpeg', sessionId: 3 }],
        ]) {
            const pending = client.callTool({ name: 'paracraft_cli', arguments: { action, clientId, params: args } });
            const [job] = await hub.pollJobs(clientId, 2000);
            assert.equal(job.request.action, action);
            assert.ok(job.request.params.authoringSession);
            assert.equal(job.request.params.petId, 'main');
            const {authoringSession, petId, ...forwarded} = job.request.params;
            assert.deepEqual(forwarded, args);
            hub.completeJob(clientId, job.jobId, { ok: true, result: reply });
            const result = await pending;
            assert.ok(!result.isError);
            if (action === 'camera_capture') assert.equal(result.content[1].type, 'image');
        }
    } finally { hub.unregisterClient(clientId); await client.close(); await server.close(); }
});

test('stdio transport uses singleton loopback hub and never repeats requests', async () => {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => { calls.push({ url, options }); return { status: 200, json: async () => ({ ok: true, result: { jobId: 'one' } }) }; };
    try {
        await paracraftRequest({ port: 8089, viaHub: true }, 'client', 'run_code', { requestId: 'recover', code: 'return 1' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/paracraft\/client\/run_code$/);
        assert.equal(JSON.parse(calls[0].options.body).requestId, 'recover');
    } finally { global.fetch = original; }
});
