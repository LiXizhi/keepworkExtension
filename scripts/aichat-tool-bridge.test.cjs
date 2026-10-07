const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, f);
const { AichatToolBridge, validateToolArguments } = require('../src/core/aichatToolBridge.ts');
const { AichatWorkspaceFiles } = require('../src/core/aichatWorkspaceFiles.ts');
const definition = { name: 'draw', description: 'fixture canvas', inputSchema: { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'], additionalProperties: false } };
const binding = (pageId = 'page', generation = 'gen') => ({ pageId, generation, revision: 'v1', instructions: 'base + skill', tools: [definition] });
class Stream extends EventEmitter {
    destroyed = false;
    writes = [];
    writeHead() {}
    write(value) { this.writes.push(value); this.emit('data', value); return true; }
    end() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    requests() { return this.writes.filter(x => x.startsWith('event: tool')).map(x => JSON.parse(x.split('data: ')[1])); }
}
test('gateway pins account, chat and generation; schema validation, image results and no replay after disconnect', async t => {
    const bridge = new AichatToolBridge(50); t.after(() => bridge.close());
    for (const owner of ['alice', 'bob']) for (const chat of ['one', 'two']) bridge.register(owner, chat, binding(owner + chat));
    const stream = new Stream(); bridge.attach('alice', 'one', 'aliceone', 'gen', stream);
    assert.throws(() => bridge.register('alice', 'one', binding('other')), /another live page/);
    assert.equal((await bridge.invoke('alice', 'one', 'draw', { value: 0 })).isError, true);
    assert.equal(stream.requests().length, 0);
    const result = bridge.invoke('alice', 'one', 'draw', { value: 1 });
    const request = stream.requests()[0];
    const content = { content: [{ type: 'text', text: 'done' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { value: 1 } };
    assert.throws(() => bridge.result('bob', 'one', { ...request, result: content }), /Expired/);
    assert.throws(() => bridge.result('alice', 'two', { ...request, result: content }), /Expired/);
    assert.throws(() => bridge.result('alice', 'one', { ...request, generation: 'old', result: content }), /Expired/);
    bridge.result('alice', 'one', { ...request, result: content });
    assert.deepEqual(await result, content);
    assert.throws(() => bridge.result('alice', 'one', { ...request, result: content }), /Expired/);
    const pending = bridge.invoke('alice', 'one', 'draw', { value: 2 }); stream.end();
    assert.match((await pending).content[0].text, /result_unknown/);
    assert.match((await bridge.invoke('alice', 'one', 'draw', { value: 3 })).content[0].text, /web_offline/);
    bridge.register('alice', 'one', binding('new', 'next'));
    const next = new Stream(); bridge.attach('alice', 'one', 'new', 'next', next);
    assert.equal(next.requests().length, 0);
    assert.match((await bridge.invoke('alice', 'one', 'draw', { value: 4 })).content[0].text, /timed out/);
    const cancelled = bridge.invoke('alice', 'one', 'draw', { value: 5 }); bridge.cancel('alice', 'one');
    assert.match((await cancelled).content[0].text, /cancelled/);
    bridge.revoke('alice'); assert.equal(bridge.has('alice', 'one'), false); assert.equal(bridge.has('bob', 'one'), true);
});
test('standard JSON Schema unions, references, array bounds and extra arguments are enforced', () => {
    const schema = { type: 'object', properties: { values: { type: 'array', maxItems: 2, items: { $ref: '#/$defs/value' } } }, required: ['values'], additionalProperties: false, $defs: { value: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } };
    validateToolArguments(schema, { values: [1, null] });
    for (const values of [[1, 2, 3], ['one']]) assert.throws(() => validateToolArguments(schema, { values }), /Invalid tool arguments/);
    assert.throws(() => validateToolArguments(schema, { values: [], account: 'bob' }), /Invalid tool arguments/);
});
test('real stdio MCP subprocess returns schemas and images; capability is revocable and absent from tools', async t => {
    const bridge = new AichatToolBridge(); t.after(() => bridge.close()); bridge.register('alice', 'chat', binding());
    const stream = new Stream(); bridge.attach('alice', 'chat', 'page', 'gen', stream);
    stream.on('data', data => { if (data.startsWith('event: tool')) { const request = JSON.parse(data.split('data: ')[1]); bridge.result('alice', 'chat', { ...request, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] } }); } });
    const descriptor = await bridge.descriptor('alice', 'chat');
    const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...Object.fromEntries(descriptor.env.map(e => [e.name, e.value])) }, windowsHide: true });
    t.after(() => child.kill());
    const lines = readline.createInterface({ input: child.stdout }); let seq = 0;
    const rpc = async (method, params) => { const response = once(lines, 'line'); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) + '\n'); return JSON.parse((await response)[0]); };
    assert.equal((await rpc('initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'keepwork-aichat');
    assert.deepEqual((await rpc('tools/list', {})).result.tools.map(t => t.name), ['aichat_list_tools', 'aichat_call_tool']);
    const list = await rpc('tools/call', { name: 'aichat_list_tools', arguments: {} });
    assert.ok(!JSON.stringify(list).includes(descriptor.env[0].value));
    const called = await rpc('tools/call', { name: 'aichat_call_tool', arguments: { name: 'draw', arguments: { value: 1 } } });
    assert.equal(called.result.content[0].type, 'image');
    bridge.revoke('alice'); assert.ok((await rpc('tools/list', {})).error);
    child.stdin.end();
});
test('background files survive page close, enforce aliases/read-only/conflicts and persist only uncommitted Git versions', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-files-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const writes = [], remote = new Map(); let oldRemote = 'remote';
    const mockFetch = async (url, options = {}) => {
        writes.push({ url, method: options.method });
        if (options.method === 'PUT') { remote.set(url, JSON.parse(options.body).content); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }
        if (url.includes('/repos/u/repo/contents/old.txt')) return new Response(oldRemote);
        if (remote.has(url)) return new Response(remote.get(url));
        return new Response('', { status: 404 });
    };
    const service = new AichatWorkspaceFiles(dir, mockFetch);
    const spaces = [{ id: 'brain', type: 'project', workspace: 'brain', aliases: ['.brain', 'brain'] }, { id: 'git', type: 'git', provider: 'github', host: 'github.com', owner: 'u', repo: 'repo', branch: 'main', aliases: ['repo', 'git'] }, { id: 'ro', type: 'url', sitePath: 'official/apps', aliases: ['site'] }];
    const grant = { username: 'alice', token: 'secret-cloud-token', primaryId: 'brain', spaces };
    service.register('owner', 'chat', grant);
    const run = args => service.execute('owner', 'chat', args);
    await run({ operation: 'write', path: '//.brain/note.md', content: 'cloud note' });
    assert.equal(JSON.parse((await run({ operation: 'read', path: 'note.md' })).content[0].text).content, 'cloud note');
    await assert.rejects(run({ operation: 'write', path: '//site/note.md', content: 'no' }), /read-only/);
    await assert.rejects(run({ operation: 'write', path: '//.brain/../other', content: '' }), /Invalid/);
    await assert.rejects(run({ operation: 'write', path: 'whiteboard/qa-artifacts.json', content: '{}' }), /saveWhiteboardDeck/);
    await run({ operation: 'write', path: '//repo/new.txt', content: 'draft' });
    const before = await service.overlayOperation('owner', 'chat', { operation: 'get', spaceId: 'git' });
    await run({ operation: 'write', path: '//repo/new.txt', content: 'newer', expectedContent: 'draft' });
    await service.overlayOperation('owner', 'chat', { operation: 'ack', spaceId: 'git', files: before.files });
    assert.equal((await service.overlayOperation('owner', 'chat', { operation: 'get', spaceId: 'git' })).files['new.txt'].content, 'newer');
    await assert.rejects(run({ operation: 'write', path: '//repo/new.txt', content: 'lost', expectedContent: 'draft' }), /changed/);
    await run({ operation: 'rename', path: '//repo/old.txt', newPath: 'moved.txt', expectedContent: 'remote' });
    await assert.rejects(run({ operation: 'read', path: '//repo/old.txt' }), /not found/);
    const after = await service.overlayOperation('owner', 'chat', { operation: 'get', spaceId: 'git' });
    assert.equal(after.files['old.txt'].deleted, true); assert.equal(after.files['moved.txt'].content, 'remote');
    await service.overlayOperation('owner', 'chat', { operation: 'check', spaceId: 'git', files: after.files });
    oldRemote = 'changed by another author';
    await assert.rejects(service.overlayOperation('owner', 'chat', { operation: 'check', spaceId: 'git', files: after.files }), /Remote Git file changed/);
    oldRemote = 'remote';
    await assert.rejects(run({ operation: 'write', path: '//repo/whiteboard/qa-artifacts.json', content: '{}' }), /saveWhiteboardDeck/);
    await service.overlayOperation('owner', 'chat', { operation: 'stageValidatedDeck', spaceId: 'git', path: 'whiteboard/qa-artifacts.json', content: '{"pages":[]}', revision: after.revision });
    await assert.rejects(service.overlayOperation('owner', 'chat', { operation: 'stageValidatedDeck', spaceId: 'git', path: 'whiteboard/qa-artifacts.json', content: '{}', revision: after.revision }), /changed/);
    const persisted = await service.overlayOperation('owner', 'chat', { operation: 'get', spaceId: 'git' });

    assert.ok(!writes.some(r => r.url.includes('github') && r.method !== 'GET'));
    assert.ok(!fs.readdirSync(dir).some(name => fs.readFileSync(path.join(dir, name), 'utf8').includes('secret-cloud-token')));
    const restarted = new AichatWorkspaceFiles(dir, mockFetch);
    await assert.rejects(restarted.execute('owner', 'chat', { operation: 'read', path: 'note.md' }), /authorization expired/);
    restarted.register('owner', 'chat', grant);
    assert.deepEqual(await restarted.overlayOperation('owner', 'chat', { operation: 'get', spaceId: 'git' }), persisted);
    service.revoke('owner'); await assert.rejects(run({ operation: 'read', path: 'note.md' }), /authorization expired/);
});

test('per-request cancellation leaves other same-chat calls pending and rejects late results', async t => {
    const bridge = new AichatToolBridge(); t.after(() => bridge.close()); bridge.register('alice', 'chat', binding());
    const stream = new Stream(); bridge.attach('alice', 'chat', 'page', 'gen', stream);
    const controller = new AbortController();
    const cancelled = bridge.invoke('alice', 'chat', 'draw', { value: 1 }, controller.signal);
    const other = bridge.invoke('alice', 'chat', 'draw', { value: 2 });
    controller.abort(); assert.match((await cancelled).content[0].text, /result_unknown/);
    const requests = stream.requests();
    assert.throws(() => bridge.result('alice', 'chat', { ...requests[0], result: { content: [] } }), /Expired/);
    bridge.result('alice', 'chat', { ...requests[1], result: { content: [{ type: 'text', text: 'other completed' }] } });
    assert.equal((await other).content[0].text, 'other completed');
});

test('GitLab and Bitbucket directory listings follow pagination without forwarding arbitrary next URLs', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-pages-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const provider of ['gitlab', 'bitbucket']) {
        const pages = [];
        const service = new AichatWorkspaceFiles(dir, async url => {
            const page = Number(new URL(url).searchParams.get('page')); pages.push(page);
            const values = Array.from({length: page === 1 ? 100 : 1}, (_, n) => ({ name: page + '-' + n, path: page + '-' + n, type: 'file' }));
            return new Response(JSON.stringify(provider === 'gitlab' ? values : { values, ...(page === 1 ? {next:'https://untrusted.example/never-follow'} : {}) }), { headers: { 'Content-Type': 'application/json' } });
        });
        service.register('owner', 'chat', { username: 'alice', primaryId: 'git', spaces: [{ id:'git', type:'git', aliases:['git'], provider, host:provider+'.com', owner:'u', repo:'r', branch:'main' }] });
        const result = await service.execute('owner', 'chat', { operation:'list', path:'' });
        assert.deepEqual(pages, [1,2]); assert.ok(JSON.stringify(result).includes('2-0'));
    }
});
