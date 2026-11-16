const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

// HTTP/stdio compatibility regression only. All account state and provider
// behavior are test-owned fixtures; no browser authorization or real model runs.
const cli = path.join(__dirname, 'fixtures', 'cursor-auth.cjs');
const owner = 'c'.repeat(32);

async function fixture(t, initialState = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cursor-auth-'));
  let daemon;
  t.after(async () => {
    // node:test runs after hooks in registration order and skips later hooks
    // when one throws. Stop the owner before Windows tries to remove its cwd.
    try {
      await daemon?.stop();
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'login-state');
  const failure = path.join(directory, 'failure');
  const log = path.join(directory, 'native.log');
  fs.mkdirSync(workspace);
  fs.writeFileSync(state, initialState);
  const absent = path.join(directory, 'absent-cli');
  const env = { KEEPWORK_CURSOR_PATH: cli, KEEPWORK_NODE_PATH: process.execPath,
    KEEPWORK_CURSOR_AUTH_FIXTURE_STATE: state, KEEPWORK_CURSOR_AUTH_FIXTURE_FAILURE: failure,
    KEEPWORK_CURSOR_AUTH_FIXTURE_LOG: log, KEEPWORK_MCP_ROOT: workspace, KEEPWORK_MCP_REQUIRE_AUTH: '0' };
  for (const backend of ['CODEX', 'WORKBUDDY', 'COPILOT', 'CLAUDE', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'CODEBUDDY', 'OPENCODE', 'DEEPSEEK']) {
    env['KEEPWORK_' + backend + '_PATH'] = absent;
  }
  daemon = await h.startRust({ env });
  const headers = { origin: daemon.base, 'x-agent-owner': owner, 'content-type': 'application/json' };
  const request = async (route, body) => {
    const response = await fetch(daemon.base + '/agents' + route, {
      headers, method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const status = async (extra = {}) => (await request('/backends?' + new URLSearchParams({
    backend: 'cursor', cwd: workspace, ...extra,
  }))).cursor;
  const rows = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { workspace, state, failure, request, status, rows };
}

function assertNoAuthorization(rows) {
  assert.equal(rows.some(row => row.method === 'authenticate'), false,
    'read-only discovery must never open native browser authorization');
  assert.equal(rows.some(row => row.event === 'start' && row.args.some(arg => /^(?:login|logout)$/.test(arg))), false);
  assert.equal(rows.some(row => row.method === 'session/prompt'), false,
    'metadata discovery must not submit a model prompt');
}

async function waitSession(f, id, expected) {
  const deadline = Date.now() + 5000;
  let session;
  do {
    session = await f.request('/sessions/' + id);
    if (session.status === expected) return session;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`Expected ${expected}, received ${JSON.stringify(session)}`);
}

async function waitOwnedPrompt(f, session) {
  const deadline = Date.now() + 5000;
  do {
    const prompts = f.rows().filter(row => row.method === 'session/prompt'
      && row.params?.sessionId === session.threadId);
    if (prompts.length) {
      assert.equal(prompts.length, 1, 'the owned prompt must be dispatched exactly once');
      const prompt = prompts[0];
      assert.ok(prompt.params.prompt.some(part => part.type === 'text' && part.text?.includes('HOLD')));
      assert.ok(Number.isInteger(prompt.pid) && prompt.pid > 1 && prompt.pid !== process.pid,
        'the observed prompt must belong to a native fixture process');
      return prompt;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`Native fixture did not receive the owned prompt: ${JSON.stringify({ threadId: session.threadId, rows: f.rows() })}`);
}

test('Cursor auth rejection preserves installed availability without starting authorization', async t => {
  const f = await fixture(t);
  const info = await f.status();
  assert.equal(info.available, true);
  assert.equal(info.authenticated, false);
  assert.equal(info.authState, 'required');
  assert.equal(info.probe, 'protocol');
  assert.equal(info.cli.path, cli);
  assert.deepEqual(info.models, []);
  assert.match(info.modelsError, /Authentication required/);
  assertNoAuthorization(f.rows());
});

test('Cursor refresh re-reads native login after an authentication-only metadata failure', async t => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.equal(initial.authState, 'required');
  const oldPid = f.rows().find(row => row.event === 'start').pid;
  // Simulate user-completed native terminal login, never invoking a real CLI.
  fs.writeFileSync(f.state, 'signed-in');
  const recovered = await f.status({ refresh: '1' });
  assert.equal(recovered.available, true);
  assert.equal(recovered.modelsError, undefined, JSON.stringify(recovered));
  assert.ok(recovered.models.some(model => model.id === 'fixture-cursor'));
  assert.equal(recovered.authenticated, null, 'model discovery does not prove account identity');
  assert.equal(recovered.authState, 'unknown');
  assert.ok(f.rows().some(row => row.event === 'start' && row.pid !== oldPid && row.signedIn),
    'a stale signed-out native process must not trap later successful login');
  assertNoAuthorization(f.rows());
});

test('concurrent signed-out Cursor probes report authentication without stale-process disconnects', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    f.status({ conversationId: 'signed-out-probe-' + index, refresh: '1' })));
  for (const info of results) {
    assert.equal(info.available, true, JSON.stringify(info));
    assert.equal(info.authenticated, false, JSON.stringify(info));
    assert.equal(info.authState, 'required', JSON.stringify(info));
    assert.match(info.modelsError, /Authentication required/);
    assert.doesNotMatch(JSON.stringify(info), /disconnected|closed|timed out/i);
  }
  assertNoAuthorization(f.rows());
});

test('Cursor metadata network failures remain unknown authentication and do not launch login', async t => {
  const f = await fixture(t, 'signed-in');
  fs.writeFileSync(f.failure, 'network');
  const info = await f.status();
  assert.equal(info.available, true);
  assert.equal(info.authenticated, null);
  assert.equal(info.authState, 'unknown');
  assert.match(info.modelsError, /Connection temporarily unavailable/);
  assertNoAuthorization(f.rows());
});

test('Cursor authentication metadata refresh leaves an owned active session and its prompt alive', async t => {
  const f = await fixture(t, 'signed-in');
  const session = await f.request('/sessions', {
    backend: 'cursor', conversationId: 'cursor-owned-active', roots: [f.workspace],
  });
  const accepted = await f.request(`/sessions/${session.id}/turns`, { requestId: 'held-prompt', text: 'HOLD' });
  assert.equal(accepted.session.lastSubmission.requestId, 'held-prompt');
  await waitSession(f, session.id, 'running');
  // Local running means accepted by the daemon, before the native peer must
  // have received stdin. Observe that peer's journal before checking its PID.
  const activePid = (await waitOwnedPrompt(f, session)).pid;
  fs.writeFileSync(f.failure, 'auth');
  assert.equal((await f.status({ conversationId: 'metadata-while-active' })).authState, 'required');
  fs.rmSync(f.failure);
  await f.status({ refresh: '1', conversationId: 'metadata-while-active' });
  const active = await f.request(`/sessions/${session.id}`);
  assert.equal(active.status, 'running', JSON.stringify(active));
  assert.equal(f.rows().filter(row => row.method === 'session/prompt').length, 1,
    'refresh must not replay the owned prompt');
  await f.request(`/sessions/${session.id}/interrupt`, {});
  await waitSession(f, session.id, 'interrupted');
  assert.ok(f.rows().some(row => row.method === 'session/cancel' && row.pid === activePid),
    'the original active native process remains reachable');
  assert.equal(f.rows().some(row => row.method === 'authenticate'), false);
});
