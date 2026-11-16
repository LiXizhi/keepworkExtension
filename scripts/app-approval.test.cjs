const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const { AgentSessions, AGENT_BACKENDS } = require('../src/core/agentSessions.ts');
const { agentApprovalMode } = require('../src/core/agentModes.ts');
const { AcpHarness } = require('../src/core/acpHarness.ts');
const { ClaudeHarness } = require('../src/core/claudeHarness.ts');
const { AntigravityHarness } = require('../src/core/antigravityHarness.ts');
const { TraeHarness } = require('../src/core/traeHarness.ts');
const backends = AGENT_BACKENDS.filter(backend => backend !== 'codex');
const turnScoped = ['trae', 'gemini'];
const nativeScoped = backends.filter(backend => !turnScoped.includes(backend));

class Fake extends EventEmitter {
    calls = []; responses = [];
    async call(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread' } };
        if (method === 'thread/resume') return { thread: { id: 'thread', turns: [] } };
        if (method === 'turn/start') return { turn: { id: 'native-turn' } };
        if (method === 'model/list') return { data: [] };
        if (method === 'account/read') return { authUnknown: true };
        return {};
    }
    respond(id, result) { this.responses.push({ id, result }); }
    close() {}
}
function setup(t, backend, real = false, flags = []) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-approval-')));
    const file = path.join(root, 'registry.json'), log = path.join(root, 'calls.jsonl'), owner = 'approval-owner';
    const make = () => {
        const directory = path.join(root, backend);
        const args = [path.join(__dirname, 'fixtures', backend === 'claude' ? 'fake-claude.cjs' : backend === 'trae' ? 'fake-trae.cjs' : backend === 'gemini' ? 'fake-antigravity.cjs' : 'fake-acp.cjs'), '--log=' + log, ...flags];
        if (!real) return new Fake();
        if (backend === 'claude') return new ClaudeHarness(directory, process.execPath, args);
        if (backend === 'trae') return new TraeHarness(directory, process.execPath, args);
        if (backend === 'gemini') return new AntigravityHarness(directory, process.execPath, args);
        return new AcpHarness(backend, directory, process.execPath, args);
    };
    const adapter = make(), dispatches = [], original = adapter.call.bind(adapter);
    adapter.call = (method, params) => { dispatches.push({ method, params }); return original(method, params); };
    const manager = new AgentSessions(file, undefined, { [backend]: adapter });
    t.after(async () => {
        manager.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    return { root, file, log, owner, adapter, manager, make, dispatches };
}
async function wait(manager, session, owner, predicate = value => !['starting', 'running', 'waiting', 'uncertain'].includes(value.status)) {
    const deadline = Date.now() + 5000;
    let snapshot;
    do {
        snapshot = await manager.read(session.id, owner);
        if (predicate(snapshot)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.fail('Expected approval state: ' + JSON.stringify(snapshot));
}
const starts = fixture => fixture.dispatches.filter(call => call.method === 'turn/start');
const emitApproval = (adapter, session, id = 'native-approval') => adapter.emit('request', {
    id, method: 'item/commandExecution/requestApproval', params: {
        threadId: session.threadId, command: 'write fixture.txt', availableDecisions: ['accept', 'decline', 'cancel'],
    },
});

for (const backend of backends) {
    test(`${backend}: App approval is explicit and advertises its actual scope`, async t => {
        const { manager } = setup(t, backend);
        const status = await manager.status(backend);
        assert.deepEqual(status.approvalModes, turnScoped.includes(backend) ? ['default', 'app', 'never'] : ['default', 'app', 'never', 'ask', 'edit', 'auto', 'readonly']);
        assert.equal(status.approvalScope, turnScoped.includes(backend) ? 'turn' : 'tool');
        assert.equal(agentApprovalMode(undefined, backend), undefined);
        assert.equal(agentApprovalMode('default', backend), undefined);
        assert.equal(agentApprovalMode('app', backend), 'app');
        assert.equal(agentApprovalMode('never', backend), 'never');
        for (const invalid of ['on-request', 'untrusted', 'read-only', 'always', null, {}, false]) {
            assert.throws(() => agentApprovalMode(invalid, backend));
        }
    });
}

for (const backend of nativeScoped) {
    test(`${backend}: explicit App approval pauses Craft native requests until its owner responds`, async t => {
        const f = setup(t, backend);
        const session = await f.manager.create(f.owner, { backend, conversationId: 'app', roots: [f.root], mode: 'craft', approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'one', text: 'inspect' });
        emitApproval(f.adapter, session);
        const waiting = await f.manager.read(session.id, f.owner);
        assert.equal(waiting.status, 'waiting');
        assert.equal(waiting.pending.length, 1);
        assert.equal(waiting.pending[0].decisionCapabilities.autoApproval, false);
        assert.deepEqual(f.adapter.responses, []);
        assert.throws(() => f.manager.configureAutoApproval(session.id, f.owner, true), /approval|审批/i);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, 'other-owner', { id: 'native-approval', decision: 'accept' })), /not found/i);
        await assert.rejects(f.manager.turn(session.id, f.owner, { requestId: 'busy', text: 'continue', approvalMode: 'never' }), /running/i);
        assert.equal((await f.manager.read(session.id, f.owner)).approvalMode, 'app');
        await f.manager.respond(session.id, f.owner, { id: 'native-approval', decision: 'decline' });
        assert.deepEqual(f.adapter.responses, [{ id: 'native-approval', result: { decision: 'decline' } }]);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: 'native-approval', decision: 'accept' })), /expired|answered/i);
    });
    for (const approvalMode of [undefined, 'never']) {
        test(`${backend}: ${approvalMode || 'legacy default'} keeps Craft native automatic approval`, async t => {
            const f = setup(t, backend);
            const session = await f.manager.create(f.owner, { backend, conversationId: 'legacy', roots: [f.root], mode: 'craft', ...(approvalMode ? { approvalMode } : {}) });
            await f.manager.turn(session.id, f.owner, { requestId: 'one', text: 'inspect' });
            emitApproval(f.adapter, session);
            assert.deepEqual(f.adapter.responses, [{ id: 'native-approval', result: { decision: 'accept' } }]);
            assert.deepEqual((await f.manager.read(session.id, f.owner)).pending, []);
        });
    }
}

for (const backend of nativeScoped) {
    test(`${backend}: real stdio fixture receives manual approval and denial in Craft`, async t => {
        const f = setup(t, backend, true, backend === 'claude' ? ['--log-rpc'] : ['--modes', '--unsafe-modes']);
        const session = await f.manager.create(f.owner, { backend, conversationId: 'native', roots: [f.root], mode: 'craft', approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'one', text: 'permission' });
        const waiting = await wait(f.manager, session, f.owner, s => s.status === 'waiting');
        assert.equal(waiting.pending.length, 1);
        await f.manager.respond(session.id, f.owner, { id: waiting.pending[0].id, decision: 'decline' });
        const finished = await wait(f.manager, session, f.owner);
        const reply = finished.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('');
        if (backend === 'claude') {
            assert.equal(finished.status, 'failed');
            assert.match(reply, /deny/);
        } else {
            assert.match(reply, /"optionId":"no"/);
            const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
            const mode = rows.find(row => row.method === 'session/set_mode');
            assert.ok(mode, 'the advertised yolo default must be left before prompting');
            assert.doesNotMatch(mode.params.modeId, /bypass|yolo|full.?access|acceptEdits/i);
            assert.equal(mode.params.modeId, 'code', 'Craft should retain coding tools instead of selecting a read-only Ask mode');
            const promptIndex = rows.findIndex(row => row.method === 'session/prompt');
            assert.ok(rows.indexOf(mode) < promptIndex, 'manual native mode is configured before executing the prompt');
        }
    });
}

for (const backend of turnScoped) {
    test(`${backend}: real turn approval waits for acceptance and executes exactly once`, async t => {
        const f = setup(t, backend, true);
        const session = await f.manager.create(f.owner, { backend, conversationId: 'turn', roots: [f.root], mode: 'craft', approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'one', text: backend === 'trae' ? 'FIXTURE_INSPECT' : 'inspect' });
        const waiting = await f.manager.read(session.id, f.owner), pending = waiting.pending[0];
        assert.equal(waiting.status, 'waiting');
        assert.equal(starts(f).length, 0, 'no native turn is dispatched before acceptance');
        assert.equal(pending.params.approvalScope, 'turn');
        assert.equal(pending.params.requiresUserDecision, true);
        assert.deepEqual(pending.params.availableDecisions, ['accept', 'decline', 'cancel']);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, 'other-owner', { id: pending.id, decision: 'accept' })), /not found/i);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'acceptForSession' })), /offered|decision|approval|审批/i);
        assert.equal(starts(f).length, 0);
        await f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' });
        assert.equal((await wait(f.manager, session, f.owner)).status, 'completed');
        assert.equal(starts(f).length, 1);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' })), /expired|answered/i);
        await f.manager.turn(session.id, f.owner, { requestId: 'one', text: 'do not replay', approvalMode: 'never' });
        assert.equal(starts(f).length, 1, 'a duplicate request cannot replay the turn or change its policy');
        assert.equal((await f.manager.read(session.id, f.owner)).approvalMode, 'app');
    });
    for (const decision of ['decline', 'cancel', 'interrupt']) {
        test(`${backend}: ${decision} of a queued real turn never starts its native work`, async t => {
            const f = setup(t, backend, true);
            const session = await f.manager.create(f.owner, { backend, conversationId: 'blocked', roots: [f.root], approvalMode: 'app' });
            await f.manager.turn(session.id, f.owner, { requestId: 'blocked', text: 'must not execute' });
            const waiting = await f.manager.read(session.id, f.owner), pending = waiting.pending[0];
            assert.ok(pending);
            if (decision === 'interrupt') await f.manager.interrupt(session.id, f.owner);
            else await f.manager.respond(session.id, f.owner, { id: pending.id, decision });
            const stopped = await wait(f.manager, session, f.owner);
            assert.equal(starts(f).length, 0);
            assert.deepEqual(stopped.pending, []);
            await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' })), /expired|answered/i);
            await f.manager.turn(session.id, f.owner, { requestId: 'blocked', text: 'do not replay', approvalMode: 'never' });
            assert.equal(starts(f).length, 0);
            assert.equal(fs.existsSync(f.log), false, 'a denied turn cannot run the native task');
        });
    }
    test(`${backend}: restart cancels an unapproved turn without replay and retains App selection`, async t => {
        const f = setup(t, backend, true);
        const session = await f.manager.create(f.owner, { backend, conversationId: 'restart', roots: [f.root], approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'queued', text: 'do not execute' });
        assert.equal(starts(f).length, 0);
        f.manager.close();
        const adapter = f.make(), calls = [], original = adapter.call.bind(adapter);
        adapter.call = (method, params) => { calls.push({ method, params }); return original(method, params); };
        const restarted = new AgentSessions(f.file, undefined, { [backend]: adapter });
        t.after(() => restarted.close());
        const resumed = await restarted.read(session.id, f.owner);
        assert.equal(resumed.approvalMode, 'app');
        assert.equal(resumed.status, 'interrupted');
        assert.deepEqual(resumed.pending, []);
        await restarted.turn(session.id, f.owner, { requestId: 'queued', text: 'do not replay' });
        assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
        await restarted.turn(session.id, f.owner, { requestId: 'new', text: 'a new request still needs approval' });
        assert.equal((await restarted.read(session.id, f.owner)).status, 'waiting');
        assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
    });
}

test('ACP rejects App approval when the provider advertises only bypass modes, before sending a prompt', async t => {
    const f = setup(t, 'workbuddy', true, ['--modes', '--only-unsafe-modes']);
    const session = await f.manager.create(f.owner, { backend: 'workbuddy', conversationId: 'unsafe', roots: [f.root], approvalMode: 'app' });
    await assert.rejects(f.manager.turn(session.id, f.owner, { requestId: 'unsafe', text: 'must not execute' }), /approval|manual|mode|审批|UNSUPPORTED/i);
    const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.method === 'session/prompt').length, 0);
});

test('ACP mode config options leave yolo for manual Craft before dispatching a prompt', async t => {
    const f = setup(t, 'copilot', true, ['--config-options', '--mode-config', '--unsafe-modes']);
    const session = await f.manager.create(f.owner, { backend: 'copilot', conversationId: 'config', roots: [f.root], approvalMode: 'app' });
    await f.manager.turn(session.id, f.owner, { requestId: 'config', text: 'permission' });
    const waiting = await wait(f.manager, session, f.owner, s => s.status === 'waiting');
    const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    const configured = rows.find(row => row.method === 'session/set_config_option' && row.params.configId === 'mode-config');
    assert.equal(configured?.params.value, 'code');
    assert.ok(rows.indexOf(configured) < rows.findIndex(row => row.method === 'session/prompt'));
    await f.manager.respond(session.id, f.owner, { id: waiting.pending[0].id, decision: 'cancel' });
    await wait(f.manager, session, f.owner);
});

for (const decision of ['acceptForSession', 'cancel']) {
    test(`ACP allow-always-only permissions never expand an allow-once response; explicit ${decision} uses its native meaning`, async t => {
        const f = setup(t, 'workbuddy', true, ['--modes', '--always-permission']);
        const session = await f.manager.create(f.owner, { backend: 'workbuddy', conversationId: 'persistent', roots: [f.root], approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'permission', text: 'permission' });
        const waiting = await wait(f.manager, session, f.owner, s => s.status === 'waiting');
        const pending = waiting.pending[0];
        assert.equal(pending.params.availableDecisions.includes('accept'), false);
        assert.equal(pending.params.availableDecisions.includes('acceptForSession'), true);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' })), /offered|permission|decision|approval/i);
        assert.equal((await f.manager.read(session.id, f.owner)).pending.length, 1);
        await f.manager.respond(session.id, f.owner, { id: pending.id, decision });
        const finished = await wait(f.manager, session, f.owner);
        const reply = finished.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('');
        if (decision === 'acceptForSession') assert.match(reply, /"optionId":"persistent"/);
        else { assert.match(reply, /"outcome":"cancelled"/); assert.doesNotMatch(reply, /persistent/); }
    });
}

for (const changedField of ['pageId', 'generation', 'revision']) {
    test(`a queued context-bound turn cannot execute after its ${changedField} changes`, async t => {
        const f = setup(t, 'gemini');
        f.manager.bridgeOptions = async () => ({});
        const context = { pageId: 'page', generation: 'generation', revision: 'revision', instructions: 'original context', tools: [] };
        f.manager.toolBridge.register(f.owner, 'context-bound', context);
        const session = await f.manager.create(f.owner, { backend: 'gemini', conversationId: 'context-bound', roots: [f.root], contextVersion: 1, approvalMode: 'app' });
        await f.manager.turn(session.id, f.owner, { requestId: 'queued-context', text: 'original task', contextVersion: 1 });
        const waiting = await f.manager.read(session.id, f.owner), pending = waiting.pending[0];
        assert.equal(starts(f).length, 0);
        f.manager.toolBridge.register(f.owner, 'context-bound', { ...context, [changedField]: 'replacement', instructions: 'changed context' });
        await f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' });
        const rejected = await wait(f.manager, session, f.owner);
        assert.equal(starts(f).length, 0, 'consent for an older context must not authorize dispatch under a replacement context');
        assert.equal(rejected.lastSubmission.state, 'rejected');
        assert.match(rejected.error, /context changed/i);
        await f.manager.turn(session.id, f.owner, { requestId: 'queued-context', text: 'do not replay', contextVersion: 1 });
        assert.equal(starts(f).length, 0);
        await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' })), /expired|answered/i);
    });
}

test('revoking a context cancels its queued turn gate and reconnecting never replays that request', async t => {
    const f = setup(t, 'gemini');
    f.manager.bridgeOptions = async () => ({});
    const context = { pageId: 'page', generation: 'generation', revision: 'revision', instructions: 'original context', tools: [] };
    f.manager.toolBridge.register(f.owner, 'revoke-bound', context);
    const session = await f.manager.create(f.owner, { backend: 'gemini', conversationId: 'revoke-bound', roots: [f.root], contextVersion: 1, approvalMode: 'app' });
    await f.manager.turn(session.id, f.owner, { requestId: 'revoke-context', text: 'original task', contextVersion: 1 });
    const pending = (await f.manager.read(session.id, f.owner)).pending[0];
    f.manager.revokeContext(f.owner);
    const cancelled = await f.manager.read(session.id, f.owner);
    assert.deepEqual(cancelled.pending, []);
    assert.equal(cancelled.lastSubmission.state, 'rejected');
    assert.equal(starts(f).length, 0);
    await assert.rejects(Promise.resolve().then(() => f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' })), /expired|answered/i);
    f.manager.toolBridge.register(f.owner, 'revoke-bound', { ...context, generation: 'reconnected' });
    await f.manager.turn(session.id, f.owner, { requestId: 'revoke-context', text: 'do not replay', contextVersion: 1 });
    assert.equal(starts(f).length, 0);
    await f.manager.turn(session.id, f.owner, { requestId: 'fresh-context', text: 'new approval required', contextVersion: 1 });
    assert.equal((await f.manager.read(session.id, f.owner)).status, 'waiting');
    assert.equal(starts(f).length, 0);
});

for (const change of ['replacement', 'revocation']) {
    test(`context ${change} during native mode configuration invalidates an already accepted turn gate before dispatch`, async t => {
        const f = setup(t, 'gemini');
        f.manager.bridgeOptions = async () => ({});
        const context = { pageId: 'page', generation: 'generation', revision: 'revision', instructions: 'original context', tools: [] };
        f.manager.toolBridge.register(f.owner, 'mode-window', context);
        const session = await f.manager.create(f.owner, { backend: 'gemini', conversationId: 'mode-window', roots: [f.root], contextVersion: 1, approvalMode: 'app' });
        let modeEntered, releaseMode;
        const entered = new Promise(resolve => { modeEntered = resolve; });
        const blocked = new Promise(resolve => { releaseMode = resolve; });
        const call = f.adapter.call.bind(f.adapter);
        f.adapter.call = async (method, params) => {
            if (method === 'thread/mode/set') { modeEntered(); await blocked; }
            return call(method, params);
        };
        await f.manager.turn(session.id, f.owner, { requestId: 'mode-window', text: 'original task', contextVersion: 1 });
        const pending = (await f.manager.read(session.id, f.owner)).pending[0];
        await f.manager.respond(session.id, f.owner, { id: pending.id, decision: 'accept' });
        await entered;
        if (change === 'revocation') f.manager.revokeContext(f.owner);
        else f.manager.toolBridge.register(f.owner, 'mode-window', { ...context, generation: 'replacement' });
        releaseMode();
        const settled = await wait(f.manager, session, f.owner, value => value.status !== 'starting');
        assert.equal(starts(f).length, 0, 'the final context check must happen after asynchronous native configuration');
        assert.equal(settled.lastSubmission.state, 'rejected');
        assert.match(settled.error, /context|Reconnect/i);
    });
}

for (const name of ['Full Access', 'fullAccess', 'full_access', 'accept_edits']) {
    test(`ACP cannot disguise ${name} as an approval-safe default mode`, async t => {
        const f = setup(t, 'workbuddy', true, ['--modes', '--unsafe-mode-name=' + name]);
        const session = await f.manager.create(f.owner, { backend: 'workbuddy', conversationId: 'named-unsafe', roots: [f.root], approvalMode: 'app' });
        await assert.rejects(f.manager.turn(session.id, f.owner, { requestId: 'unsafe', text: 'must not execute' }), /manual|approval|unsupported|mode/i);
        const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.filter(row => row.method === 'session/prompt').length, 0);
    });
}

for (const backend of ['workbuddy', 'claude']) {
    for (const mode of ['ask', 'edit', 'auto', 'readonly']) {
        test(`${backend} ${mode}: known tool kinds follow Keepwork policy and shell reads cannot bypass readonly`, async t => {
            const f = setup(t, backend);
            const session = await f.manager.create(f.owner, { backend, conversationId: 'four-policies', roots: [f.root], approvalMode: mode });
            await f.manager.turn(session.id, f.owner, { requestId: 'one', text: 'inspect' });
            for (const kind of ['read', 'edit', 'command', 'other']) {
                const id = mode + ':' + kind;
                const expected = kind === 'read' || mode === 'auto' || mode === 'edit' && kind === 'edit'
                    ? 'accept' : mode === 'readonly' ? 'decline' : undefined;
                f.adapter.emit('request', { id, method: 'item/commandExecution/requestApproval', params: {
                    threadId: session.threadId, approvalKind: kind, readOnly: kind === 'command', command: kind === 'command' ? 'cat fixture.txt' : kind,
                    availableDecisions: ['accept', 'decline', 'cancel'],
                } });
                const response = f.adapter.responses.find(row => row.id === id);
                const snapshot = await f.manager.read(session.id, f.owner);
                assert.equal(response?.result.decision, expected);
                assert.equal(snapshot.pending.some(row => row.id === id), expected === undefined);
                if (!expected) f.manager.respond(session.id, f.owner, { id, decision: 'decline' });
            }
            f.adapter.emit('request', { id: 'mandatory', method: 'item/tool/requestUserInput', params: { threadId: session.threadId, questions: [{ id: 'q', question: 'Proceed?' }] } });
            assert.ok((await f.manager.read(session.id, f.owner)).pending.some(row => row.id === 'mandatory'));
        });
    }
}
