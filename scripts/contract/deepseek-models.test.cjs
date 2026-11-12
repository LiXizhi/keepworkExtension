const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

// Real loopback HTTP and native stdio, isolated HOME and provider fixture.
// No real DeepSeek account, network inference or user conversation is accessed.
const owner = 'd'.repeat(32);
const fixture = path.join(__dirname, 'fixtures', 'deepseek-models.cjs');
const accountFlash = JSON.stringify(['deepseek-account', 'deepseek-flash']);
const accountPro = JSON.stringify(['deepseek-account', 'deepseek-pro']);
const apiFlash = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
const staleModel = JSON.stringify(['deepseek-account', 'retired-model']);
let daemon, root, logFile;

function rows() {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const modelChanges = () => rows().filter((row) => row.method === 'session/set_config_option' || row.method === 'session/set_model');
const prompts = () => rows().filter((row) => row.method === 'session/prompt');
async function request(route, body) {
  const response = await fetch(daemon.base + '/agents' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: daemon.base, 'x-agent-owner': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await response.json() };
}
async function status(extra = {}) {
  const query = new URLSearchParams({ backend: 'deepseek', cwd: root, refresh: '1', ...extra });
  return request('/backends?' + query);
}
async function create(conversationId, extra = {}) {
  return request('/sessions', { backend: 'deepseek', conversationId, roots: [root], ...extra });
}
function assertCatalog(result, current) {
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.deepEqual(Object.keys(result.json), ['deepseek']);
  const info = result.json.deepseek;
  assert.equal(info.available, true, JSON.stringify(info));
  assert.equal(info.protocol, 'acp');
  assert.equal(info.authenticated, null, 'metadata does not verify provider authentication');
  assert.equal(info.modelsError, undefined);
  assert.deepEqual(info.models.map((model) => model.id), [accountFlash, accountPro, apiFlash]);
  assert.deepEqual(info.models.filter((model) => model.isDefault).map((model) => model.id), [current]);
}
before(async () => {
  const logDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kp-deepseek-contract-'));
  root = fs.realpathSync(logDir); logFile = path.join(root, 'fixture.log');
  const absent = path.join(root, 'absent-cli');
  const env = { KEEPWORK_MCP_ROOT: root, KEEPWORK_AGENT_FIXTURE_LOG: logFile, KEEPWORK_DEEPSEEK_PATH: fixture };
  for (const backend of ['CODEX', 'WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CLAUDE', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE']) {
    env['KEEPWORK_' + backend + '_PATH'] = absent;
  }
  daemon = await h.startRust({ env });
});
after(async () => {
  if (daemon) await daemon.stop();
  if (root) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('DeepSeek metadata ignores a retired model hint and returns the complete grouped catalog', async () => {
  const count = modelChanges().length, promptCount = prompts().length;
  assertCatalog(await status({ conversationId: 'retired-model-catalog', model: staleModel }), apiFlash);
  assert.equal(modelChanges().length, count, 'an unavailable metadata hint must not configure the native peer');
  assert.equal(prompts().length, promptCount, 'model discovery must never submit a prompt');
  assertCatalog(await status({ conversationId: 'retired-model-catalog', model: staleModel }), apiFlash);
  assert.equal(modelChanges().length, count, 'refreshing an unavailable hint must remain harmless');
});

test('DeepSeek metadata applies an available JSON model ID and omitted hints preserve the native default', async () => {
  const count = modelChanges().length, promptCount = prompts().length;
  assertCatalog(await status({ conversationId: 'selected-model-catalog', model: accountPro }), accountPro);
  const changes = modelChanges().slice(count);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].method, 'session/set_config_option');
  assert.equal(changes[0].params.configId, 'model');
  assert.equal(changes[0].params.value, accountPro, 'opaque provider routing ID must round-trip unchanged');
  assertCatalog(await status({ conversationId: 'legacy-catalog' }), apiFlash);
  assert.equal(modelChanges().length, count + 1, 'a legacy omitted hint must not select an account model automatically');
  assert.equal(prompts().length, promptCount);
});

test('DeepSeek explicit invalid models still reject session creation and turns before any prompt', async () => {
  const promptCount = prompts().length, changeCount = modelChanges().length;
  const rejected = await create('invalid-create', { model: staleModel });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
  assert.match(rejected.json.error, /Unsupported native (configuration value|model)/);
  assert.equal(rejected.json.acceptanceUnknown, false);
  const created = await create('invalid-turn', { model: accountFlash });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const invalid = await request(`/sessions/${created.json.id}/turns`, {
    requestId: 'invalid-model-turn', text: 'Do not submit this prompt', model: staleModel,
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  assert.match(invalid.json.error, /Unsupported native (configuration value|model)/);
  assert.equal(invalid.json.acceptanceUnknown, false);
  assert.equal(prompts().length, promptCount);
  assert.deepEqual(modelChanges().slice(changeCount).map((row) => row.params.value), [accountFlash],
    'explicit invalid execution choices must not silently fall back to another model');
  const persisted = await request('/sessions/' + created.json.id);
  assert.equal(persisted.json.lastSubmission.state, 'rejected');
  assert.deepEqual(persisted.json.items, [], 'a rejected model must not append a user turn');
});

test('DeepSeek scoped model changes remain strict while omitted legacy execution fields work', async () => {
  const created = await create('legacy-session');
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const count = modelChanges().length, promptCount = prompts().length;
  const scoped = await status({ sessionId: created.json.id, model: staleModel });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
  assert.equal(scoped.json.deepseek.available, false, 'an explicit existing-session model change must not downgrade');
  assert.match(scoped.json.deepseek.error, /Unsupported native (configuration value|model)/);
  assert.equal(modelChanges().length, count);
  assert.equal(prompts().length, promptCount);
  const legacy = await request(`/sessions/${created.json.id}/turns`, { requestId: 'legacy-turn', text: 'Legacy request without model or effort' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
  const deadline = Date.now() + 5000;
  let completed;
  do {
    completed = await request('/sessions/' + created.json.id);
    if (completed.json.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(completed.json.status, 'completed', JSON.stringify(completed.json));
  assert.equal(prompts().length, promptCount + 1);
  assert.equal(modelChanges().length, count, 'omitting model keeps the provider default');
});

test('DeepSeek scoped metadata remains strict after its native fixture process restarts', async () => {
  const beforeCreate = rows().length;
  const created = await create('disconnected-scoped-session', { model: accountFlash });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const started = rows().slice(beforeCreate).findLast((row) => row.method === 'session/new');
  assert.ok(started, 'creating the owned session must log its native session/new');
  assert.equal(started.params.cwd, created.json.roots[0], 'the fixture must use the canonical session root');
  assert.equal(started.fixture, 'deepseek-models');
  assert.ok(Number.isInteger(started.pid) && started.pid > 1 && started.pid !== process.pid);
  const promptCount = prompts().length, changes = modelChanges().length;
  // This PID comes only from our fixture's log in the isolated temporary root.
  // Wait for the daemon's exit event so the next status uses a new generation.
  process.kill(started.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  let disconnected;
  do {
    disconnected = await request('/sessions/' + created.json.id);
    if (disconnected.json.cursor > created.json.cursor) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.ok(disconnected.json.cursor > created.json.cursor, 'the owned session must observe its native harness exit');
  const before = rows().length;
  const scoped = await status({ sessionId: created.json.id, model: staleModel });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
  const restarted = rows().slice(before);
  const initialized = restarted.find((row) => row.method === 'initialize');
  assert.ok(initialized && initialized.pid !== started.pid, 'scoped discovery must use the restarted harness generation');
  assert.equal(restarted.some((row) => row.method === 'session/new' && row.pid === initialized.pid), true,
    'the disconnected owned session has no loaded native metadata on the new harness');
  assert.equal(restarted.some((row) => ['session/load', 'session/resume'].includes(row.method)), false,
    'a status probe must not resume or replay the owned session');
  assert.equal(scoped.json.deepseek.available, false, 'restarting the harness must not turn an explicit scoped model into an optional hint');
  assert.match(scoped.json.deepseek.error, /Unsupported native (configuration value|model)/);
  assert.equal(modelChanges().length, changes);
  assert.equal(prompts().length, promptCount);
  const persisted = await request('/sessions/' + created.json.id);
  assert.equal(persisted.json.threadId, created.json.threadId, 'metadata discovery must preserve the original native identity');
  assert.equal(persisted.json.model, accountFlash);
  assert.deepEqual(persisted.json.items, []);
});
