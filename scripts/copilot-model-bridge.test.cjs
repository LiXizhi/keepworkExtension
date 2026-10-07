const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file);
const { CopilotHarness, editorModelId } = require('../src/core/copilotHarness.ts');
const { AcpHarness } = require('../src/core/acpHarness.ts');
const { AgentSessions } = require('../src/core/agentSessions.ts');
const model = { id: 's2api/gpt-6.1-sol', name: 'GPT custom', vendor: 'sub2api', maxInputTokens: 200000 };
function fixture(t, supported = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-bridge-'));
    const state = { models: [model], bridge: { port: 32100, pid: 1, token: 'a'.repeat(48) }, adapters: [], checks: 0 };
    class Fake extends EventEmitter {
        constructor(directory, env) { super(); this.directory = directory; this.prepare = env; this.calls = []; this.closed = 0; }
        async call(method, p) {
            this.calls.push({ method, p });
            if (method === 'thread/read') return { thread: { id: p.threadId, turns: [] } };
            if (this.prepare && !this.env) this.env = await this.prepare();
            if (method === 'account/read') return { account: null, authUnknown: true };
            if (method === 'model/list') { if (this.failure) throw Error('Authentication required'); return { data: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', isDefault: true }] }; }
            if (method === 'thread/start') return { thread: { id: 'thread-' + state.adapters.indexOf(this), turns: [] } };
            if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] } };
            if (method === 'turn/start') { this.emit('notification', { method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'turn-1' } } }); return { turn: { id: 'turn-1' } }; }
            return {};
        }
        respond(id, result) { this.answer = { id, result }; }
        close() { this.closed++; this.env = undefined; this.emit('exit', 'closed'); }
        refreshCapabilities() {}
    }
    const create = () => new CopilotHarness(dir, async () => ({ models: state.models, bridge: state.bridge }), async () => { state.checks++; return supported; }, (dir, env) => {
        const adapter = new Fake(dir, env); state.adapters.push(adapter); return adapter;
    });
    const harness = create(); t.after(() => harness.close());
    return { dir, state, harness, create, key: editorModelId(model.id) };
}
test('optional discovery adds labelled custom models without starting inference, and survives editor loss', async t => {
    const { harness, state, key } = fixture(t);
    let list = await harness.call('model/list', { catalogKey: 'owner:chat' });
    assert.deepEqual(list.data.map(m => m.id), ['gpt-5-mini', key]);
    assert.match(list.data[1].displayName, /VS Code · sub2api/);
    assert.equal(state.adapters.length, 1);
    state.models = [];
    list = await harness.call('model/list'); assert.equal(list.data.length, 1);
    assert.equal(state.checks, 1);
});
test('old CLI keeps subscription models and rejects custom prompts before launching or falling back', async t => {
    const { harness, state, key } = fixture(t, false);
    const result = await harness.call('model/list');
    assert.equal(result.data.length, 1); assert.match(result.modelsError, /Update Copilot CLI/);
    await assert.rejects(harness.call('thread/start', { model: key }), /Update Copilot CLI/);
    assert.ok(state.adapters.every(a => !a.env && !a.calls.some(c => c.method === 'thread/start')));
});
test('custom sessions send only their selected model to a separate process and persist no credentials', async t => {
    const { harness, state, key, dir } = fixture(t);
    const thread = (await harness.call('thread/start', { model: key, cwd: dir })).thread.id;
    await harness.call('turn/start', { threadId: thread, model: key, input: [{ type: 'text', text: 'hello' }] });
    assert.equal(state.adapters[1].env.COPILOT_MODEL, model.id);
    assert.equal(state.adapters[1].env.COPILOT_PROVIDER_BASE_URL, 'http://127.0.0.1:32100/v1');
    assert.equal(state.adapters[1].env.COPILOT_PROVIDER_WIRE_API, 'completions');
    assert.equal(state.adapters[1].env.COPILOT_OFFLINE, 'true');
    assert.ok(!state.adapters[0].calls.some(c => c.method === 'turn/start'));
    const routes = fs.readFileSync(path.join(dir, 'editor-routes.json'), 'utf8');
    assert.ok(!routes.includes(state.bridge.token)); assert.ok(!routes.includes('32100'));
    assert.equal(JSON.parse(routes)[thread], key);
    await assert.rejects(harness.call('turn/start', { threadId: thread, model: 'gpt-5-mini' }), /new Copilot chat/);
    await assert.rejects(harness.call('turn/start', { threadId: 'native-thread', model: key }), /new Copilot chat/);
});
test('custom history survives restart and editor loss; continuation fails explicitly without replay', async t => {
    const { harness, state, create, key } = fixture(t);
    const thread = (await harness.call('thread/start', { model: key })).thread.id;
    harness.close(); state.models = [];
    const restarted = create(); t.after(() => restarted.close());
    assert.equal((await restarted.call('thread/read', { threadId: thread })).thread.id, thread);
    await assert.rejects(restarted.call('turn/start', { threadId: thread }), /VS Code custom model unavailable/);
    assert.ok(state.adapters.every(a => !a.calls.some(c => c.method === 'turn/start')));
});
test('permission IDs and resolutions are namespaced, including the unchanged native route', async t => {
    const { harness, state, key } = fixture(t);
    await harness.call('thread/start', { model: key });
    const requests = [], resolutions = [];
    harness.on('request', m => requests.push(m)); harness.on('notification', m => resolutions.push(m));
    for (const a of state.adapters) a.emit('request', { id: 1, params: { threadId: 'thread' } });
    assert.notEqual(requests[0].id, requests[1].id);
    harness.respond(requests[0].id, { decision: 'accept' }); harness.respond(requests[1].id, { decision: 'decline' });
    assert.equal(state.adapters[0].answer.result.decision, 'accept'); assert.equal(state.adapters[1].answer.result.decision, 'decline');
    state.adapters[1].emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 1 } });
    assert.equal(resolutions[0].params.requestId, requests[1].id);
});
test('an editor restart rotates only idle custom processes; active turns are not killed', async t => {
    const { harness, state, key } = fixture(t);
    const thread = (await harness.call('thread/start', { model: key })).thread.id;
    state.bridge = { ...state.bridge, port: 32101, token: 'b'.repeat(48) };
    await harness.call('turn/start', { threadId: thread, model: key });
    assert.equal(state.adapters[1].closed, 1); assert.equal(state.adapters[1].env.COPILOT_PROVIDER_API_KEY, state.bridge.token);
    state.bridge = { ...state.bridge, port: 32102 };
    await assert.rejects(harness.call('thread/resume', { threadId: thread }), /unavailable/);
    assert.equal(state.adapters[1].closed, 1); assert.equal(state.adapters[0].closed, 0);
});
test('shared service preserves model warnings and isolates native sessions from a custom process exit', async t => {
    const { harness, state, dir, key } = fixture(t);
    const manager = new AgentSessions(path.join(dir, 'sessions.json'), undefined, { copilot: harness }); t.after(() => manager.close());
    const normal = await manager.create('owner', { backend: 'copilot', conversationId: 'normal', roots: [dir], model: 'gpt-5-mini' });
    const custom = await manager.create('owner', { backend: 'copilot', conversationId: 'custom', roots: [dir], model: key });
    // Use public turns to enter the running state.
    await manager.turn(normal.id, 'owner', { requestId: 'native-request', text: 'native' });
    await manager.turn(custom.id, 'owner', { requestId: 'custom-request', text: 'custom' });
    state.adapters[1].emit('exit', 'editor gone');
    assert.equal((await manager.read(normal.id, 'owner')).status, 'running');
    assert.equal((await manager.read(custom.id, 'owner')).status, 'interrupted');
});
test('ACP launch can use a private environment without changing the daemon environment', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-env-'));
    const script = path.join(dir, 'env.cjs');
    fs.writeFileSync(script, `require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s); const result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:{sessionId:'env-thread',models:{currentModelId:process.env.BRIDGE_TEST,availableModels:[{modelId:process.env.BRIDGE_TEST,name:'Environment model'}]}}; console.log(JSON.stringify({id:m.id,result}));});`);
    const adapter = new AcpHarness('copilot', dir, process.execPath, [script], async () => ({ ...process.env, BRIDGE_TEST: 'private' })); t.after(() => adapter.close());
    const models = await adapter.call('model/list', { catalogKey: 'env-test', cwd: dir }); assert.equal(models.data[0].id, 'private');
    assert.equal(process.env.BRIDGE_TEST, undefined);
});
