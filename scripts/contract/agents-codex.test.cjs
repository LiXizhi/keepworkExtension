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
async function request(route, body) {
  const response = await fetch(daemon.base + '/agents' + route, { headers: headers(), method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
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

async function legacyDaemon(t) {
  const isolated = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-codex-legacy-contract-')));
  const profile = path.join(isolated, 'profile'), workspace = path.join(isolated, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  const port = await h.freePort(), base = `http://127.0.0.1:${port}`;
  const ownerKey = 'legacy-codex-owner-'.padEnd(40, 'a');
  const ownerHash = createHash('sha256').update(base + '\0' + ownerKey).digest('hex');
  const registry = path.join(profile, '.keepwork-mcp', 'agent-sessions-v1.json');
  fs.mkdirSync(path.dirname(registry));
  const rows = ['good', 'failure', 'unsupported', 'invalid'].map((kind) => ({
    id: 'legacy-' + kind, owner: ownerHash, backend: 'codex', conversationId: 'legacy-conversation-' + kind,
    threadId: 'legacy-history-' + kind, title: 'Legacy ' + kind, roots: [workspace], rootNames: ['workspace'],
    mode: 'craft', model: 'fixture-codex', status: 'completed', archived: false, removed: false,
    cursor: 1, updatedAt: 1, submissions: {}, aichatContext: false,
    // Node keeps native Codex history outside this registry, so items is omitted.
  }));
  fs.writeFileSync(registry, JSON.stringify(rows), { mode: 0o600 });
  const rpcLog = path.join(isolated, 'rpc.log');
  const env = { ...process.env, HOME: profile, USERPROFILE: profile,
    KEEPWORK_MCP_ROOT: workspace, KEEPWORK_MCP_PORT: String(port), KEEPWORK_MCP_REQUIRE_AUTH: '0',
    KEEPWORK_MCP_HOST_KIND: 'standalone', KEEPWORK_CODEX_PATH: fixture, KEEPWORK_AGENT_FIXTURE_LOG: rpcLog,
  };
  const child = spawn(h.rustBinary(), ['--port', String(port), '--root', workspace], {
    cwd: h.repoRoot, env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
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
    saved: () => JSON.parse(fs.readFileSync(registry, 'utf8')),
    calls: () => fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    async read(kind, selectedOwner = ownerKey) {
      const response = await fetch(base + '/agents/sessions/legacy-' + kind, {
        headers: { origin: base, 'x-agent-owner': selectedOwner }, signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

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
