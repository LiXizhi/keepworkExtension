const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Readable } = require('node:stream');
const ts = require('typescript');

function load(relative, mocks = {}, cache = new Map()) {
    const file = path.resolve(__dirname, '../src', relative + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const instance = new Module(file, module); instance.filename = file; instance.paths = module.paths; cache.set(file, instance);
    instance.require = id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(file), id);
            if (fs.existsSync(target + '.ts')) return load(path.relative(path.resolve(__dirname, '../src'), target), mocks, cache);
            if (id.endsWith('.cjs')) return require(target);
        }
        return require(id);
    };
    instance._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
    return instance.exports;
}

const { defaultMessageConfig, DEFAULT_PROMPT } = load('core/messagingPolicy');
const { DwsError } = load('core/messagingDingtalk');
const PROFILE = 'fixture-corp:fixture-user';
const GROUP = 'cid+group/fixture==';
const PEER = 'fixture-open-peer';
const DIRECT = 'cid+direct/fixture==';
const row = (id, conversation = GROUP, kind = 'group', time = Date.now() - 1000) => ({ id, conversation, kind, sender: PEER, time, text: id, direction: 'in' });

function fixture(t, channel = 'dingtalk') {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-inbox-read-')));
    const root = path.join(directory, 'brain'), home = path.join(directory, 'state'); fs.mkdirSync(root);
    const calls = [];
    let hook = args => args[0] === 'event' ? { identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } }
        : args[1] === '+conversation-info' ? { result: { conversationInfo: { singleChat: true, openConversationId: DIRECT } } }
            : { success: true, result: { success: true } };
    const actual = load('core/messagingDingtalk');
    const { MessagingService } = load('core/messaging', {
        './messagingDingtalk': { ...actual, dws: async (args, cwd) => { calls.push({ args, cwd }); return hook(args, cwd); } },
        './messagingExecutor': { messagingExecutorChoice: () => ({ backend: 'copilot', model: '' }), MessagingWorkers: class { close() {} } },
        './aichatPresence': { latestAichatClient: () => null, latestAichatBrainRoot: () => root },
    });
    const service = new MessagingService(home, 8089);
    const binding = service.configure({ channel, root, profile: PROFILE, config: defaultMessageConfig(), prompt: DEFAULT_PROMPT });
    const runtime = service.get(binding.id); runtime.binding.agentOwner = 'owner'; runtime.binding.agentId = 'default-persona';
    const box = service.box(binding.id);
    box.messages.push(row('group-in'), row('direct-in', DIRECT, 'direct'), row('other-in', 'other-group'));
    box.paused.push(GROUP); box.sends = { 'kept-send': 'unknown' };
    t.after(() => { service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const read = (conversation = GROUP, syncRemote = true, action = 'read', owner = 'owner', agent = 'default-persona') => service.inboxActionRequest(owner, agent, binding.id, conversation, action, syncRemote);
    const unread = (conversation = GROUP) => service.inboxView('owner', 'default-persona', binding.id).conversations.find(item => item.id === conversation).unread;
    return { service, runtime, box, binding, root, home, calls, read, unread, set hook(value) { hook = value; } };
}

test('legacy read requests and cached GETs remain local; only DingTalk advertises remote read', async t => {
    const f = fixture(t), feishu = fixture(t, 'feishu');
    assert.equal(f.service.agentBindings('owner', 'default-persona')[0].inboxReadVersion, 1);
    assert.equal('inboxReadVersion' in feishu.service.agentBindings('owner', 'default-persona')[0], false);
    f.service.inboxView('owner', 'default-persona', f.binding.id);
    f.service.inboxView('owner', 'default-persona', f.binding.id, GROUP);
    assert.equal(f.unread(), 1); assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.service.inboxActionRequest('owner', 'default-persona', f.binding.id, GROUP, 'read'), { ok: true });
    assert.equal(f.unread(), 0); assert.deepEqual(f.calls, []);
    assert.deepEqual(await feishu.read(GROUP, false), { ok: true }); assert.deepEqual(feishu.calls, []);
});

test('remote group read verifies the binding identity then acknowledges exactly one conversation', async t => {
    const f = fixture(t), before = structuredClone({ paused: f.box.paused, sends: f.box.sends, messages: f.box.messages });
    assert.deepEqual(await f.read(), { ok: true, remoteSynced: true }); assert.equal(f.unread(), 0); assert.equal(f.unread('other-group'), 1);
    assert.deepEqual(f.calls.map(call => call.args), [
        ['event', 'status', '--profile', PROFILE, '-f', 'json'],
        ['chat', 'clear-red-point', '--conversation-id', GROUP, '--profile', PROFILE, '-f', 'json'],
    ]);
    assert.ok(f.calls.every(call => call.cwd === f.root));
    assert.deepEqual({ paused: f.box.paused, sends: f.box.sends, messages: f.box.messages }, before);
    const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'inbox.json')))[f.binding.id]; assert.ok(Object.keys(saved.read).length > 0);
});

for (const usePeerAlias of [false, true]) test('direct read resolves and validates the remote conversation' + (usePeerAlias ? ' from the legacy peer alias' : ''), async t => {
    const f = fixture(t), conversation = usePeerAlias ? PEER : DIRECT;
    if (usePeerAlias) f.box.messages.find(item => item.id === 'direct-in').conversation = PEER;
    await f.read(conversation);
    assert.deepEqual(f.calls[1].args, ['chat', '+conversation-info', '--open-dingtalk-id', PEER, '--profile', PROFILE, '-f', 'json']);
    assert.deepEqual(f.calls[2].args.slice(0, 4), ['chat', 'clear-red-point', '--conversation-id', DIRECT]); assert.equal(f.unread(conversation), 0);
});

test('identity and direct-conversation mismatches stop before a remote acknowledgement', async t => {
    const f = fixture(t);
    f.hook = () => ({ identity: { corp_id: 'fixture-corp', user_id: 'another-user' } });
    await assert.rejects(f.read(), /identity/); assert.equal(f.calls.length, 1); assert.equal(f.unread(), 1); assert.deepEqual(f.box.read, {});
    f.calls.length = 0;
    f.hook = args => args[0] === 'event' ? { identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } }
        : { result: { conversationInfo: { singleChat: true, openConversationId: 'unrelated-direct' } } };
    await assert.rejects(f.read(DIRECT), /单聊会话/); assert.equal(f.calls.length, 2); assert.equal(f.unread(DIRECT), 1); assert.deepEqual(f.box.read, {});
});

test('rejected, unknown, partial and malformed acknowledgements never advance the local read cursor', async t => {
    const f = fixture(t);
    const failures = [new DwsError(false), new DwsError(true), {}, { success: false }, { result: false }, { success: true, partial: true }, { success: true, result: { failures: ['fixture'] } }, { result: { success: true, failedCount: 1 } }];
    for (const outcome of failures) {
        f.hook = args => { if (args[0] === 'event') return { identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } }; if (outcome instanceof Error) throw outcome; return outcome; };
        await assert.rejects(f.read()); assert.equal(f.unread(), 1); assert.deepEqual(f.box.read, {}); assert.equal(f.box.readFutureIds, undefined);
    }
    assert.equal(f.calls.length, failures.length * 2);
});

test('invalid explicit semantics, foreign owners and unassigned groups cannot invoke the CLI', async t => {
    const f = fixture(t), feishu = fixture(t, 'feishu');
    for (const sync of [null, 1, 'true', {}]) await assert.rejects(f.read(GROUP, sync), /syncRemote/);
    await assert.rejects(f.read(GROUP, true, 'pause'), /read/);
    await assert.rejects(f.read(GROUP, true, 'read', 'stranger'));
    await assert.rejects(f.read('missing'));
    await assert.rejects(feishu.read(), { code: 'UNSUPPORTED_FEATURE' });
    f.runtime.binding.peers = [{ owner: 'owner', agentId: 'lily' }];
    const agent = { owner: 'owner', id: 'lily', name: 'Lily', root: f.root, prompt: 'test', messaging: { version: 1, enabled: false, groups: [{ channel: 'dingtalk', account: PROFILE, id: GROUP }] } };
    f.service.setMessageAgents(() => [agent]);
    await assert.rejects(f.read('other-group', true, 'read', 'owner', 'lily'), /未分配/);
    assert.deepEqual(f.calls, []); assert.deepEqual(feishu.calls, []); assert.deepEqual(f.box.read, {});
});

for (const change of ['profile', 'owner', 'scope', 'close']) test('inflight ' + change + ' change withholds remote acknowledgement and local commit', async t => {
    const f = fixture(t);
    if (change === 'scope') {
        f.runtime.binding.peers = [{ owner: 'owner', agentId: 'lily' }];
        const agent = { owner: 'owner', id: 'lily', name: 'Lily', root: f.root, prompt: 'test', messaging: { version: 1, enabled: false, groups: [{ channel: 'dingtalk', account: PROFILE, id: GROUP }] } };
        f.service.setMessageAgents(() => [agent]); f.agent = agent;
    }
    let release; f.hook = () => new Promise(resolve => { release = resolve; });
    const pending = f.read(GROUP, true, 'read', 'owner', change === 'scope' ? 'lily' : 'default-persona');
    if (change === 'profile') f.runtime.binding.profile = 'fixture-corp:changed-user';
    if (change === 'owner') f.runtime.binding.agentOwner = 'stranger';
    if (change === 'scope') f.agent.messaging.groups = [];
    if (change === 'close') f.service.close();
    release({ identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } });
    await assert.rejects(pending); assert.equal(f.calls.length, 1); assert.deepEqual(f.box.read, {});
});

test('a remote acknowledgement arriving after the account changes cannot commit into the new account', async t => {
    const f = fixture(t); let release;
    f.hook = args => args[0] === 'event' ? { identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } }
        : new Promise(resolve => { release = resolve; });
    const pending = f.read();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.runtime.binding.profile = 'fixture-corp:changed-user';
    release({ result: { success: true } });
    await assert.rejects(pending, /切换/); assert.equal(f.calls.length, 2); assert.deepEqual(f.box.read, {});
});

test('messages arriving during a remote acknowledgement remain unread, including future clock IDs', async t => {
    const f = fixture(t), future = Date.now() + 86_400_000;
    f.box.messages.push(row('stored-future', GROUP, 'group', future));
    let release; f.hook = args => args[0] === 'event' ? { identity: { corp_id: 'fixture-corp', user_id: 'fixture-user' } }
        : new Promise(resolve => { release = resolve; });
    const pending = f.read();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.unread(), 2, 'local read does not commit before confirmed remote success');
    f.box.messages.push(row('late-normal', GROUP, 'group', Date.now() + 1000), row('late-future', GROUP, 'group', future + 1));
    release({ result: { success: true } }); await pending;
    assert.equal(f.unread(), 2); const futureIds = Object.values(f.box.readFutureIds).flat();
    assert.ok(futureIds.includes('stored-future')); assert.ok(!futureIds.includes('late-future'));
});

test('legacy inbox HTTP route awaits the explicit read result and forwards optional syncRemote unchanged', async () => {
    const { handlePersonaHttp } = load('mcp/personaHttp'), owner = 'a'.repeat(32), calls = [];
    const expectedOwner = load('core/agentSessions').ownerKey('https://keepwork.com', owner);
    let finish;
    const messaging = { inboxActionRequest: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } };
    const req = Readable.from([JSON.stringify({ binding: 'binding', conversation: GROUP, action: 'read', syncRemote: true })]);
    req.method = 'POST'; req.headers = { 'x-agent-owner': owner, 'content-type': 'application/json', origin: 'https://keepwork.com' };
    let response, status; const res = { setHeader() {}, writeHead(value) { status = value; }, end(value) { response = { status, body: JSON.parse(value) }; } };
    const request = handlePersonaHttp(req, res, new URL('http://127.0.0.1/agents/personas/default-persona/inbox'), { read: () => ({}) }, messaging);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    assert.equal(response, undefined); assert.deepEqual(calls, [[expectedOwner, 'default-persona', 'binding', GROUP, 'read', true]]);
    finish({ ok: true, remoteSynced: true }); await request; assert.deepEqual(response, { status: 200, body: { ok: true, remoteSynced: true } });
});
