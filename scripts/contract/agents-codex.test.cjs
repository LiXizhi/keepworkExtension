const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const h = require('./harness.cjs');

let daemon, directory, root, log;
const owner = 'codex-contract-owner-'.padEnd(40, 'a');
const fixture = path.join(__dirname, 'fixtures', 'codex-agent-cli.cjs');
function headers() { return { origin: daemon.base, 'x-agent-owner': owner, 'content-type': 'application/json' }; }
async function request(route, body, options = {}) {
  const response = await fetch(daemon.base + '/agents' + route, { headers: { ...headers(), ...options.headers }, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
function calls() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
async function create(conversationId, mode = 'craft') {
  const result = await request('/sessions', { backend: 'codex', conversationId, roots: [root], mode });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function wait(session, predicate) {
  const until = Date.now() + 5000;
  let view;
  do {
    const result = await request('/sessions/' + session.id); assert.equal(result.status, 200, JSON.stringify(result.body));
    view = result.body; if (predicate(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < until);
  assert.fail('Codex session state: ' + JSON.stringify(view));
}
before(async () => {
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-codex-contract-')));
  root = path.join(directory, 'root'); fs.mkdirSync(root); log = path.join(directory, 'rpc.log');
  const env = { KEEPWORK_CODEX_PATH: fixture, KEEPWORK_MCP_ROOT: root, KEEPWORK_AGENT_FIXTURE_LOG: log };
  for (const name of ['WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CLAUDE', 'CURSOR', 'TRAE', 'QWEN', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) env['KEEPWORK_' + name + '_PATH'] = path.join(directory, 'missing');
  daemon = await h.startRust({ env });
});
after(async () => { await daemon?.stop(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test('Rust Codex discovers native account and model capabilities through App Server', async () => {
  const result = await request('/backends?backend=codex');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.codex.available, true, JSON.stringify(result.body));
  assert.equal(result.body.codex.protocol, 'codex');
  assert.equal(result.body.codex.authenticated, true);
  assert.equal(result.body.codex.models[0].id, 'fixture-codex');
  assert.equal(result.body.codex.models[0].supportedReasoningEfforts[0].reasoningEffort, 'high');
});

test('Rust Codex completes native turns and preserves request identity without replay', async () => {
  const session = await create('codex-complete');
  const body = { requestId: 'codex-turn-1', text: 'fixture native reply', model: 'fixture-codex', effort: 'high' };
  const first = await request(`/sessions/${session.id}/turns`, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const completed = await wait(session, (view) => view.status === 'completed');
  assert.match(completed.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join(''), /中文 codex fixture answer/);
  assert.equal(completed.lastSubmission.requestId, body.requestId);
  assert.equal((await request(`/sessions/${session.id}/turns`, body)).status, 200);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((row) => row.method === 'turn/start' && row.params.threadId === session.threadId).length, 1);
});

test('Rust Codex Ask keeps approvals interactive and interruption affects its own turn', async () => {
  const session = await create('codex-approval', 'ask');
  assert.equal((await request(`/sessions/${session.id}/turns`, { requestId: 'codex-permission-1', text: 'FIXTURE_PERMISSION', mode: 'ask' })).status, 200);
  const waiting = await wait(session, (view) => view.pending.length > 0);
  assert.equal(waiting.status, 'waiting');
  assert.equal((await request(`/sessions/${session.id}/respond`, { id: waiting.pending[0].id, decision: 'decline' })).status, 200);
  const completed = await wait(session, (view) => view.status === 'completed');
  assert.match(completed.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join(''), /codex:denied/);
  assert.equal((await request(`/sessions/${session.id}/turns`, { requestId: 'codex-slow-1', text: 'FIXTURE_SLOW', mode: 'ask' })).status, 200);
  await wait(session, (view) => view.status === 'running');
  assert.equal((await request(`/sessions/${session.id}/interrupt`, {})).status, 200);
  assert.equal((await wait(session, (view) => view.status === 'interrupted')).pending.length, 0);
});

test('Craft rejects an unavailable native approval choice without hanging or widening permission', async () => {
  const session = await create('codex-unoffered-approval');
  assert.equal((await request(`/sessions/${session.id}/turns`, { requestId: 'codex-unoffered-1', text: 'FIXTURE_UNOFFERED_PERMISSION' })).status, 200);
  const completed = await wait(session, (view) => view.status === 'completed');
  assert.match(completed.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join(''), /codex:denied/);
  assert.deepEqual(completed.pending, []);
});

test('Codex native catalogs support both client routes and opaque cursor pagination without execution', async () => {
  const before = calls().length;
  const first = await request('/native-codex');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.nextCursor, 'fixture-page:2/+?');
  assert.deepEqual(first.body.sessions.map((row) => row.threadId), ['native-fixture-one', 'native-fixture-optional', 'native-fixture-active']);
  const row = first.body.sessions[0];
  assert.equal(row.backend, 'codex');
  assert.equal(row.title, 'Terminal fixture task');
  assert.equal(row.workspace, path.basename(root));
  assert.equal(row.updatedAt, 123000);
  assert.equal(row.busy, false);
  assert.equal(first.body.sessions.find((item) => item.threadId === 'native-fixture-active').busy, true);
  assert.equal(typeof first.body.sessions.find((item) => item.threadId === 'native-fixture-optional').title, 'string');
  const alias = await request('/native-sessions/codex');
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  assert.deepEqual(alias.body, first.body);
  const second = await request('/native-sessions/codex?cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body.sessions.map((item) => item.threadId), ['native-fixture-two']);
  assert.equal(second.body.nextCursor, null);
  const readCalls = calls().slice(before);
  const lists = readCalls.filter((call) => call.method === 'thread/list');
  assert.equal(lists.length, 3);
  assert.equal(lists[0].params.limit, 100);
  assert.equal(lists[0].params.sortKey, 'updated_at');
  assert.equal(lists[0].params.archived, false);
  assert.deepEqual(lists[0].params.modelProviders, []);
  assert.deepEqual(lists[0].params.sourceKinds, ['cli', 'vscode', 'exec', 'appServer']);
  assert.equal(lists[2].params.cursor, first.body.nextCursor);
  assert.equal(readCalls.some((call) => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false);
});

test('Codex native attachment is read-only, shared across aliases and isolated by owner', async () => {
  const before = calls().length;
  const [first, alias] = await Promise.all([
    request('/native-codex/native-fixture-one'),
    request('/native-sessions/codex/native-fixture-one'),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(alias.status, 200, JSON.stringify(alias.body));
  assert.equal(alias.body.id, first.body.id, 'concurrent opens attach exactly one owned session');
  assert.equal(first.body.threadId, 'native-fixture-one');
  assert.equal(first.body.native, true);
  assert.equal(first.body.mode, 'ask');
  assert.deepEqual(first.body.roots, [root]);
  assert.equal(first.body.items.find((item) => item.type === 'userMessage')?.content[0].text, 'Original native CLI question');
  assert.equal(first.body.items.find((item) => item.type === 'agentMessage')?.text, 'Original native CLI answer');
  assert.deepEqual(first.body.pending, []);
  const own = await request('/sessions/' + first.body.id);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.id, first.body.id);
  const readCalls = calls().slice(before);
  assert.equal(readCalls.some((call) => call.method === 'thread/read' && call.params.threadId === 'native-fixture-one' && call.params.includeTurns === true), true);
  assert.equal(readCalls.some((call) => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false, 'viewing history cannot resume or execute it');
  const differentOwner = { headers: { 'x-agent-owner': 'another-native-owner-'.padEnd(40, 'b') } };
  const beforeForeign = calls().length;
  const stolen = await request('/native-sessions/codex/native-fixture-one', undefined, differentOwner);
  assert.notEqual(stolen.status, 200, JSON.stringify(stolen.body));
  assert.equal(calls().length, beforeForeign, 'owner conflict must be rejected before native history I/O');
  const foreignList = await request('/native-codex', undefined, differentOwner);
  assert.equal(foreignList.status, 200, JSON.stringify(foreignList.body));
  assert.equal(foreignList.body.sessions.some((item) => item.threadId === 'native-fixture-one'), false);
  assert.notEqual((await request('/sessions/' + first.body.id, undefined, differentOwner)).status, 200);
});

test('Codex native continuation resumes the original thread only after an explicit idempotent turn', async () => {
  const attached = await request('/native-codex/native-fixture-one');
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const before = calls().length;
  const body = { requestId: 'native-codex-continue-1', text: 'Continue the original native conversation' };
  const first = await request(`/sessions/${attached.body.id}/turns`, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const completed = await wait(attached.body, (view) => view.status === 'completed');
  assert.equal(completed.threadId, 'native-fixture-one');
  assert.match(completed.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join(''), /中文 codex fixture answer/);
  assert.equal((await request(`/sessions/${attached.body.id}/turns`, body)).status, 200);
  const continuedCalls = calls().slice(before);
  assert.equal(continuedCalls.filter((call) => call.method === 'thread/resume').length, 1);
  assert.equal(continuedCalls.find((call) => call.method === 'thread/resume').params.threadId, 'native-fixture-one');
  assert.equal(continuedCalls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(continuedCalls.find((call) => call.method === 'turn/start').params.threadId, 'native-fixture-one');
  assert.equal(continuedCalls.some((call) => call.method === 'thread/start'), false, 'continuation must never replace the imported native thread');
});

test('Codex native busy state blocks execution and absent optional metadata remains readable', async () => {
  const active = await request('/native-codex/native-fixture-active');
  assert.equal(active.status, 200, JSON.stringify(active.body));
  assert.equal(active.body.externalBusy, true);
  const before = calls().length;
  const rejected = await request(`/sessions/${active.body.id}/turns`, { requestId: 'native-busy-turn', text: 'Do not race the external client' });
  assert.notEqual(rejected.status, 200, JSON.stringify(rejected.body));
  assert.match(JSON.stringify(rejected.body), /running|busy|active/i);
  assert.equal(calls().slice(before).some((call) => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false);
  const stateFile = log + '.native-state.json';
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, busy: false }));
  const refreshed = await request('/native-sessions/codex/native-fixture-active');
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.externalBusy, false, 'reopening history refreshes the external busy state');
  assert.equal(refreshed.body.id, active.body.id);
  assert.equal((await request(`/sessions/${active.body.id}/turns`, { requestId: 'native-unblocked-turn', text: 'Continue after the external client finishes' })).status, 200);
  await wait(active.body, (view) => view.status === 'completed');
  const optional = await request('/native-sessions/codex/native-fixture-optional');
  assert.equal(optional.status, 200, JSON.stringify(optional.body));
  assert.equal(optional.body.native, true);
  assert.deepEqual(optional.body.items, []);
  assert.equal(optional.body.externalBusy, false);
  assert.equal(typeof optional.body.title, 'string');
});

test('Codex native malformed history, missing roots and invalid owner or Origin fail without attaching', async () => {
  const originalSessions = await request('/sessions');
  assert.equal(originalSessions.status, 200, JSON.stringify(originalSessions.body));
  for (const kind of ['failure', 'invalid', 'mismatch', 'missing-root']) {
    const result = await request('/native-codex/native-fixture-' + kind);
    assert.notEqual(result.status, 200, `${kind}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.items, undefined);
  }
  const afterFailures = await request('/sessions');
  assert.equal(afterFailures.status, 200, JSON.stringify(afterFailures.body));
  assert.deepEqual(afterFailures.body.sessions.map((session) => session.id).sort(), originalSessions.body.sessions.map((session) => session.id).sort(), 'failed native reads cannot persist a false empty session');
  const beforeValidation = calls().length;
  for (const route of ['/native-codex/invalid.thread', '/native-sessions/codex/invalid.thread']) {
    assert.notEqual((await request(route)).status, 200);
  }
  assert.notEqual((await request('/native-codex', undefined, { headers: { 'x-agent-owner': '' } })).status, 200);
  assert.notEqual((await request('/native-codex', undefined, { headers: { origin: 'https://untrusted.invalid' } })).status, 200);
  assert.equal(calls().length, beforeValidation, 'invalid identifiers and authorization must fail before provider I/O');
  const unsupported = await request('/native-sessions/not-a-backend');
  assert.notEqual(unsupported.status, 200);
  const unsupportedProvider = await request('/native-sessions/claude');
  assert.equal(unsupportedProvider.status, 422, JSON.stringify(unsupportedProvider.body));
  assert.equal(unsupportedProvider.body.code, 'UNSUPPORTED_FEATURE');
  const unaffectedCatalog = await request('/native-codex');
  assert.equal(unaffectedCatalog.status, 200, JSON.stringify(unaffectedCatalog.body));
  assert.equal(unaffectedCatalog.body.sessions.some((session) => session.threadId === 'native-fixture-one'), true);
  const ordinary = await create('codex-after-native-errors');
  assert.equal((await request(`/sessions/${ordinary.id}/turns`, { requestId: 'ordinary-after-native-errors', text: 'Ordinary chat stays available' })).status, 200);
  await wait(ordinary, (view) => view.status === 'completed');
});

async function legacyDaemon(t) {
  const isolated = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-codex-legacy-contract-')));
  const profile = path.join(isolated, 'profile'), workspace = path.join(isolated, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  const port = await h.freePort(), base = `http://127.0.0.1:${port}`;
  const ownerKey = 'legacy-codex-owner-'.padEnd(40, 'a');
  const ownerHash = createHash('sha256').update(base + '\0' + ownerKey).digest('hex');
  const registry = path.join(profile, '.keepwork-mcp', 'agent-sessions-v1.json');
  fs.mkdirSync(path.dirname(registry));
  const rows = ['good', 'failure', 'unsupported', 'invalid', 'native-busy'].map((kind) => ({
    id: 'legacy-' + kind, owner: ownerHash, backend: 'codex', conversationId: 'legacy-conversation-' + kind,
    threadId: 'legacy-history-' + kind, title: 'Legacy ' + kind, roots: [workspace], rootNames: ['workspace'],
    mode: 'craft', model: 'fixture-codex', status: 'completed', archived: false, removed: false,
    cursor: 1, updatedAt: 1, submissions: {}, aichatContext: false,
    ...(kind === 'native-busy' ? { native: true, externalBusy: false } : {}),
    // Node keeps native Codex history outside this registry, so items is omitted.
  }));
  fs.writeFileSync(registry, JSON.stringify(rows), { mode: 0o600 });
  const rpcLog = path.join(isolated, 'rpc.log');
  const env = { ...process.env, HOME: profile, USERPROFILE: profile,
    KEEPWORK_MCP_ROOT: workspace, KEEPWORK_MCP_PORT: String(port), KEEPWORK_MCP_REQUIRE_AUTH: '0',
    KEEPWORK_MCP_HOST_KIND: 'standalone', KEEPWORK_CODEX_PATH: fixture, KEEPWORK_AGENT_FIXTURE_LOG: rpcLog,
  };
  const launch = () => spawn(h.rustBinary(), ['--port', String(port), '--root', workspace], {
    cwd: h.repoRoot, env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let child = launch();
  let exited = new Promise((resolve) => child.once('exit', resolve));
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); let timer;
    const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer); if (!stopped) { child.kill('SIGKILL'); await exited; }
  }
  t.after(async () => { await stop(); fs.rmSync(isolated, { recursive: true, force: true }); });
  await h.waitForHealth(port);
  return {
    stop,
    async restart() {
      await stop();
      child = launch();
      exited = new Promise((resolve) => child.once('exit', resolve));
      await h.waitForHealth(port);
    },
    saved: () => JSON.parse(fs.readFileSync(registry, 'utf8')),
    calls: () => fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    async readRoute(route) {
      const response = await fetch(base + '/agents/' + route, {
        headers: { origin: base, 'x-agent-owner': ownerKey }, signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    },
    async read(kind, selectedOwner = ownerKey) {
      const response = await fetch(base + '/agents/sessions/legacy-' + kind, {
        headers: { origin: base, 'x-agent-owner': selectedOwner }, signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('Codex native imports retain their identity after reconnect and restart without resuming execution', async (t) => {
  const isolated = await legacyDaemon(t);
  const attached = await isolated.readRoute('native-codex/native-fixture-two');
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const saved = isolated.saved().find((session) => session.id === attached.body.id);
  assert.equal(saved?.native, true);
  assert.equal(saved.threadId, 'native-fixture-two');
  await isolated.restart();
  const before = isolated.calls().length;
  const restored = await isolated.readRoute('native-sessions/codex/native-fixture-two');
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.id, attached.body.id);
  assert.equal(restored.body.threadId, attached.body.threadId);
  assert.equal(restored.body.items.find((item) => item.type === 'agentMessage')?.text, 'Original native CLI answer');
  assert.equal(isolated.saved().filter((session) => session.threadId === 'native-fixture-two').length, 1);
  assert.equal(isolated.calls().slice(before).some((call) => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false);
});

test('legacy Node Codex history hydrates once through owned read-only thread/read', async (t) => {
  const old = await legacyDaemon(t);
  assert.equal(old.calls().length, 0, 'loading the legacy registry does not launch a CLI');
  const stolen = await old.read('good', 'another-codex-owner-'.padEnd(40, 'b'));
  assert.notEqual(stolen.status, 200);
  assert.equal(old.calls().length, 0, 'ownership must be verified before native history I/O');
  const restored = await old.read('good');
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.items.find((item) => item.id === 'legacy-answer')?.text, 'Legacy Codex restored answer');
  assert.equal(restored.body.items.find((item) => item.id === 'legacy-user')?.content[0].text, 'Legacy question');
  const calls = old.calls();
  assert.equal(calls.filter((row) => row.method === 'thread/read').length, 1);
  assert.equal(calls.find((row) => row.method === 'thread/read').params.includeTurns, true);
  assert.equal(calls.some((row) => ['thread/start', 'thread/resume', 'turn/start', 'session/prompt'].includes(row.method)), false, 'history recovery cannot execute or resume a turn');
  const cached = await old.read('good');
  assert.deepEqual(cached.body.items, restored.body.items);
  assert.equal(old.calls().filter((row) => row.method === 'thread/read').length, 1, 'subsequent reads use restored data');
  assert.equal(old.saved().find((row) => row.id === 'legacy-good').items.some((item) => item.id === 'legacy-answer'), true);
  assert.equal(Object.hasOwn(old.saved().find((row) => row.id === 'legacy-failure'), 'items'), false, 'saving another session cannot replace unread native history with an empty transcript');
});

test('legacy native Codex history refreshes external busy state on its first read', async (t) => {
  const isolated = await legacyDaemon(t);
  const restored = await isolated.read('native-busy');
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.native, true);
  assert.equal(restored.body.externalBusy, true, 'the first recovered transcript must expose the current external execution state');
  assert.equal(restored.body.items.find((item) => item.id === 'legacy-answer')?.text, 'Legacy Codex restored answer');
  assert.equal(isolated.calls().filter((call) => call.method === 'thread/read').length, 1);
  assert.equal(isolated.calls().some((call) => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false);
});

test('unavailable or invalid legacy Codex history reports failure without persisting a false empty transcript', async (t) => {
  const old = await legacyDaemon(t);
  for (const kind of ['failure', 'unsupported', 'invalid']) {
    const failed = await old.read(kind);
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    assert.match(JSON.stringify(failed.body), /history.*(?:unavailable|could not|incompatible|invalid)|original registry was preserved/i);
    assert.equal(failed.body.items, undefined);
    assert.equal(Object.hasOwn(old.saved().find((row) => row.id === 'legacy-' + kind), 'items'), false);
  }
  assert.equal(old.calls().filter((row) => row.method === 'thread/read').length, 3);
  assert.equal(old.calls().some((row) => ['thread/start', 'thread/resume', 'turn/start', 'session/prompt'].includes(row.method)), false);
  await old.stop();
  for (const kind of ['failure', 'unsupported', 'invalid']) {
    assert.equal(Object.hasOwn(old.saved().find((row) => row.id === 'legacy-' + kind), 'items'), false, 'daemon shutdown preserves the unresolved native history marker');
  }
});
