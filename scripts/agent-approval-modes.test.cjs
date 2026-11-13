const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { AgentSessions, ownerKey } = require('../src/core/agentSessions.ts');
const { CODEX_APPROVAL_MODES, agentApprovalMode, agentAccess } = require('../src/core/agentModes.ts');
const { handleAgentHttp } = require('../src/mcp/agentHttp.ts');

class Fake extends EventEmitter {
    calls = []; responses = []; serial = 0;
    async call(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: `thread-${++this.serial}` } };
        if (method === 'thread/resume') return { thread: { turns: [] } };
        if (method === 'turn/start') return { turn: { id: `turn-${this.calls.length}` } };
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'model/list') return { data: [{ id: 'fixture' }] };
        return {};
    }
    respond(id, result) { this.responses.push({ id, result }); }
    close() { this.emit('exit'); }
}
function setup(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-approval-modes-')));
    const file = path.join(root, 'state', 'sessions.json');
    const fake = new Fake(), other = new Fake();
    const manager = new AgentSessions(file, fake, { codex: fake, claude: other });
    t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const owner = ownerKey('http://localhost', 'a'.repeat(32));
    const finish = session => fake.emit('notification', { method: 'turn/completed', params: {
        threadId: session.threadId, turn: { status: 'completed' },
    } });
    return { root, file, fake, other, manager, owner, finish };
}
function emit(fake, session, id, method = 'item/commandExecution/requestApproval', extra = {}) {
    fake.emit('request', { id, method, params: { threadId: session.threadId, command: 'fixture', ...extra } });
}

test('Codex approval values are explicit and invalid policies cannot fall back to full access', () => {
    assert.deepEqual(CODEX_APPROVAL_MODES, ['default', 'on-request', 'untrusted', 'never', 'read-only']);
    assert.equal(agentApprovalMode(undefined), undefined);
    assert.equal(agentApprovalMode('default'), undefined);
    for (const mode of CODEX_APPROVAL_MODES.slice(1)) assert.equal(agentApprovalMode(mode), mode);
    for (const value of ['', 'auto', 'always', null, false, {}, [], 1]) assert.throws(() => agentApprovalMode(value));
    assert.throws(() => agentApprovalMode('on-request', 'claude'), /unsupported|Codex/i);
});

test('explicit approval preserves read-only Ask and Plan limits while Craft uses native Codex sandboxes', () => {
    for (const mode of ['ask', 'plan']) for (const approval of CODEX_APPROVAL_MODES.slice(1)) {
        const access = agentAccess(mode, approval, ['/fixture']);
        assert.equal(access.sandbox, 'read-only', `${mode}/${approval}`);
        assert.equal(access.approvalPolicy, 'never', `${mode}/${approval}`);
        assert.equal(access.sandboxPolicy.type, 'readOnly');
    }
    for (const approval of ['on-request', 'untrusted']) {
        const access = agentAccess('craft', approval, ['/fixture', '/second']);
        assert.equal(access.sandbox, 'workspace-write');
        assert.equal(access.approvalPolicy, approval);
        assert.equal(access.sandboxPolicy.type, 'workspaceWrite');
        assert.deepEqual(access.sandboxPolicy.writableRoots, ['/fixture', '/second']);
        assert.equal(access.sandboxPolicy.networkAccess, false);
    }
    assert.equal(agentAccess('craft', 'never').sandbox, 'danger-full-access');
    assert.equal(agentAccess('craft', 'read-only').sandbox, 'read-only');
    assert.equal(agentAccess('craft').approvalPolicy, 'never', 'old client defaults remain full access');
    assert.equal(agentAccess('ask').approvalPolicy, 'on-request', 'old Ask contract remains unchanged');
});

test('only Codex advertises independent native approval choices', async t => {
    const { manager } = setup(t);
    assert.deepEqual((await manager.status('codex')).approvalModes, CODEX_APPROVAL_MODES);
    assert.equal((await manager.status('claude')).approvalModes, undefined);
});

for (const approvalMode of ['on-request', 'untrusted', 'never', 'read-only']) {
    test(`Codex ${approvalMode} reaches creation, turns and persisted resume without an omitted-policy downgrade`, async t => {
        const { root, file, fake, manager, owner } = setup(t);
        const session = await manager.create(owner, { conversationId: 'policy', roots: [root], mode: 'craft', approvalMode });
        const access = agentAccess('craft', approvalMode, [root]);
        const start = fake.calls.find(call => call.method === 'thread/start').params;
        assert.equal(start.sandbox, access.sandbox); assert.equal(start.approvalPolicy, access.approvalPolicy);
        if (access.sandbox === 'workspace-write') assert.deepEqual(start.config.sandbox_workspace_write, { writable_roots: [root], network_access: false });
        assert.equal(session.approvalMode, approvalMode);
        await manager.turn(session.id, owner, { requestId: 'first', text: 'Inspect fixture' });
        const turn = fake.calls.find(call => call.method === 'turn/start').params;
        assert.deepEqual(turn.sandboxPolicy, access.sandboxPolicy); assert.equal(turn.approvalPolicy, access.approvalPolicy);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].approvalMode, approvalMode);
        const resumed = new Fake(), restarted = new AgentSessions(file, resumed, { codex: resumed });
        t.after(() => { restarted.close(); fs.rmSync(root, { recursive: true, force: true }); });
        assert.equal((await restarted.read(session.id, owner)).approvalMode, approvalMode);
        const resume = resumed.calls.find(call => call.method === 'thread/resume').params;
        assert.equal(resume.sandbox, access.sandbox); assert.equal(resume.approvalPolicy, access.approvalPolicy);
        if (access.sandbox === 'workspace-write') assert.deepEqual(resume.config.sandbox_workspace_write, { writable_roots: [root], network_access: false });
        await restarted.turn(session.id, owner, { requestId: 'second', text: 'Continue fixture' });
        assert.deepEqual(resumed.calls.find(call => call.method === 'turn/start').params.sandboxPolicy, access.sandboxPolicy);
    });
}

test('explicit default resets a stored policy while legacy creation and omitted turns keep historical behavior', async t => {
    const { root, fake, manager, owner, finish } = setup(t);
    const session = await manager.create(owner, { conversationId: 'legacy', roots: [root] });
    assert.equal(session.approvalMode, undefined);
    assert.equal(fake.calls.find(call => call.method === 'thread/start').params.approvalPolicy, 'never');
    await manager.turn(session.id, owner, { requestId: 'tighten', text: 'Inspect', approvalMode: 'on-request' }); finish(session);
    await manager.turn(session.id, owner, { requestId: 'retain', text: 'Continue' }); finish(session);
    assert.equal((await manager.read(session.id, owner)).approvalMode, 'on-request');
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.approvalPolicy, 'on-request');
    await manager.turn(session.id, owner, { requestId: 'reset', text: 'Continue', approvalMode: 'default' });
    assert.equal((await manager.read(session.id, owner)).approvalMode, undefined);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.approvalPolicy, 'never');
});

test('invalid or unsupported explicit policy rejects before provider execution and remains scoped to its owner', async t => {
    const { root, fake, other, manager, owner } = setup(t);
    await assert.rejects(manager.create(owner, { conversationId: 'bad', roots: [root], approvalMode: 'always' }));
    await assert.rejects(manager.create(owner, { backend: 'claude', conversationId: 'unsupported', roots: [root], approvalMode: 'on-request' }));
    assert.equal(fake.calls.length, 0); assert.equal(other.calls.length, 0);
    const session = await manager.create(owner, { conversationId: 'valid', roots: [root], approvalMode: 'on-request' });
    await assert.rejects(manager.turn(session.id, 'another-owner', { requestId: 'wrong', text: 'Run', approvalMode: 'never' }), /not found/);
    await assert.rejects(manager.turn(session.id, owner, { requestId: 'bad-turn', text: 'Run', approvalMode: 'invalid' }));
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 0);
    assert.equal((await manager.read(session.id, owner)).approvalMode, 'on-request');
});

for (const approvalMode of ['on-request', 'untrusted']) test(`explicit ${approvalMode} queues native requests despite Craft and legacy automatic approval`, async t => {
    const { root, fake, manager, owner } = setup(t);
    const session = await manager.create(owner, { conversationId: approvalMode, roots: [root], mode: 'craft', approvalMode });
    await manager.turn(session.id, owner, { requestId: 'run', text: 'Inspect' });
    emit(fake, session, 1); emit(fake, session, 2, 'item/fileChange/requestApproval');
    emit(fake, session, 3, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
    assert.equal(fake.responses.length, 0);
    assert.equal((await manager.read(session.id, owner)).pending.length, 3);
    try { manager.configureAutoApproval(session.id, owner, true); }
    catch (error) { assert.match(error.message, /approval|policy|explicit|审批|策略/i); }
    assert.equal(fake.responses.length, 0, 'legacy auto toggle cannot grant explicit pending approval');
    emit(fake, session, 4);
    assert.equal(fake.responses.length, 0, 'future requests retain the explicit policy');
    await assert.rejects(manager.turn(session.id, owner, { requestId: 'change-busy', text: 'Continue', approvalMode: 'never' }), /running/);
    assert.equal((await manager.read(session.id, owner)).approvalMode, approvalMode);
    manager.respond(session.id, owner, { id: 1, decision: 'decline' });
    assert.deepEqual(fake.responses, [{ id: 1, result: { decision: 'decline' } }]);
});

for (const mode of ['craft', 'ask', 'plan']) test(`read-only upper bound rejects mutations and permission elevation in ${mode}`, async t => {
    const { root, fake, manager, owner } = setup(t);
    const session = await manager.create(owner, { conversationId: mode, roots: [root], mode, approvalMode: mode === 'craft' ? 'read-only' : 'never' });
    await manager.turn(session.id, owner, { requestId: 'run', text: 'Inspect' });
    emit(fake, session, 1, 'item/commandExecution/requestApproval');
    emit(fake, session, 2, 'item/fileChange/requestApproval');
    emit(fake, session, 3, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
    emit(fake, session, 4, 'item/commandExecution/requestApproval', { readOnly: true });
    emit(fake, session, 5, 'item/commandExecution/requestApproval', { readOnly: true, requiresUserDecision: true });
    emit(fake, session, 7, 'item/fileChange/requestApproval', { readOnly: true });
    assert.deepEqual(fake.responses, [
        { id: 1, result: { decision: 'decline' } }, { id: 2, result: { decision: 'decline' } },
        { id: 3, result: { permissions: {}, scope: 'turn' } },
        { id: 4, result: { decision: 'accept' } }, { id: 5, result: { decision: 'decline' } },
        { id: 7, result: { decision: 'decline' } },
    ]);
    emit(fake, session, 6, 'item/tool/requestUserInput', { questions: [{ id: 'question', question: 'Choose' }] });
    assert.equal((await manager.read(session.id, owner)).pending[0].id, 6, 'questions stay interactive');
});

test('explicit never approves eligible native tools while questions and mandatory decisions remain interactive', async t => {
    const { root, fake, manager, owner } = setup(t);
    const session = await manager.create(owner, { conversationId: 'never', roots: [root], mode: 'craft', approvalMode: 'never' });
    await manager.turn(session.id, owner, { requestId: 'run', text: 'Inspect' });
    emit(fake, session, 1); emit(fake, session, 2, 'item/fileChange/requestApproval');
    emit(fake, session, 3, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
    emit(fake, session, 4, 'item/commandExecution/requestApproval', { requiresUserDecision: true });
    emit(fake, session, 5, 'item/commandExecution/requestApproval', { availableDecisions: ['cancel'] });
    emit(fake, session, 6, 'item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Choose' }] });
    emit(fake, session, 7, 'unknown/requestApproval');
    assert.deepEqual(fake.responses.map(response => response.id), [1, 2, 3, 7]);
    assert.deepEqual(fake.responses.at(-1), { id: 7, result: { decision: 'decline' } });
    assert.deepEqual((await manager.read(session.id, owner)).pending.map(request => request.id), [4, 5, 6]);
});

test('dedicated approval routes require a policy before dispatch and keep the legacy routes compatible', async t => {
    const { root, fake, manager, finish } = setup(t);
    const post = async (route, body) => {
        const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {
            origin: 'http://localhost', 'x-agent-owner': 'a'.repeat(32), 'content-type': 'application/json',
        } });
        const res = { status: 0, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
        await handleAgentHttp(req, res, new URL(route, 'http://localhost'), manager);
        return res;
    };
    assert.equal((await post('/agents/approval-sessions', { conversationId: 'missing', roots: [root] })).status, 400);
    assert.equal(fake.calls.length, 0);
    const created = await post('/agents/approval-sessions', { conversationId: 'explicit', roots: [root], approvalMode: 'untrusted' });
    assert.equal(created.status, 200);
    assert.equal(created.body.approvalMode, 'untrusted');
    const route = `/agents/sessions/${created.body.id}/approval-turns`;
    assert.equal((await post(route, { requestId: 'missing', text: 'Inspect' })).status, 400);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 0);
    assert.equal((await post(route, { requestId: 'valid', text: 'Inspect', approvalMode: 'untrusted' })).status, 200);
    assert.equal(fake.calls.find(call => call.method === 'turn/start').params.approvalPolicy, 'untrusted');
    finish(created.body);
    assert.equal((await post(`/agents/sessions/${created.body.id}/turns`, { requestId: 'omitted', text: 'Continue' })).status, 200);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.approvalPolicy, 'untrusted');
    const legacy = await post('/agents/sessions', { conversationId: 'legacy-http', roots: [root] });
    assert.equal(legacy.status, 200);
    assert.equal(fake.calls.filter(call => call.method === 'thread/start').at(-1).params.approvalPolicy, 'never');
});
