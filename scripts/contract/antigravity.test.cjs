const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./harness.cjs');

// Real Rust HTTP and native child-process stdio with a deterministic agy peer.
// These contracts provide no evidence about real accounts or provider models.
const ownerA = 'a'.repeat(32), ownerB = 'b'.repeat(32);
const fixture = path.join(__dirname, 'fixtures', 'antigravity-cli.cjs');
let dir, home, root, extraRoot, logFile, port, base, child, exited;
function rows(event) {
  let values;
  try { values = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return event ? values.filter(row => row.event === event) : values;
}
function headers(owner = ownerA) { return { origin: base, 'x-agent-owner': owner }; }
async function request(route, { method = 'GET', body, owner = ownerA } = {}) {
  const response = await fetch(base + '/agents' + route, {
    method, headers: { ...headers(owner), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, json: await response.json() };
}
async function start() {
  child = spawn(h.rustBinary(), ['--port', String(port), '--root', root], {
    cwd: h.repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, KEEPWORK_MCP_HOST_KIND: 'standalone',
      KEEPWORK_ANTIGRAVITY_PATH: fixture, KEEPWORK_GEMINI_PATH: path.join(dir, 'obsolete-gemini'),
      KEEPWORK_ANTIGRAVITY_FIXTURE_LOG: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await h.waitForHealth(port); } catch (error) { throw new Error(error.message + '\n' + output); }
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
  clearTimeout(timer);
  if (!result) { child.kill('SIGKILL'); await exited; }
}
before(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-antigravity-contract-')));
  home = path.join(dir, 'home'); root = path.join(dir, 'workspace'); extraRoot = path.join(dir, 'additional');
  for (const folder of [home, root, extraRoot]) fs.mkdirSync(folder);
  logFile = path.join(dir, 'fixture.log'); port = await h.freePort(); base = `http://127.0.0.1:${port}`;
  await start();
});
after(async () => { await stop(); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
async function create(conversationId, overrides = {}) {
  const result = await request('/sessions', { method: 'POST', body: { backend: 'gemini', conversationId, roots: [root], ...overrides } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}
function turn(session, requestId, text, overrides = {}) {
  return request(`/sessions/${session.id}/turns`, { method: 'POST', body: { requestId, text, ...overrides } });
}
async function waitSession(session, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout; let value;
  do {
    const result = await request(`/sessions/${session.id}`);
    assert.equal(result.status, 200, JSON.stringify(result.json)); value = result.json;
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('Session did not reach expected state: ' + JSON.stringify(value));
}
const answers = session => session.items.filter(item => item.type === 'agentMessage');
const inspect = session => JSON.parse(answers(session).at(-1).text);
async function completed(session, id, text, overrides) {
  const result = await turn(session, id, text, overrides);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return waitSession(session, value => value.status === 'completed');
}

test('Antigravity inventory is prompt-free and connection probe discovers native models', async () => {
  const count = rows().length;
  const executable = await request('/backends?backend=gemini&probe=executable');
  assert.equal(executable.status, 200, JSON.stringify(executable.json));
  assert.equal(executable.json.gemini.protocol, 'antigravity');
  assert.equal(executable.json.gemini.protocolSupported, true);
  assert.equal(executable.json.gemini.available, true);
  assert.equal(executable.json.gemini.authenticated, null);
  assert.equal(rows().length, count, 'executable inventory must not start agy');
  const connected = await request('/backends?backend=gemini&refresh=1');
  assert.equal(connected.status, 200, JSON.stringify(connected.json));
  const backend = connected.json.gemini;
  assert.equal(backend.available, true, JSON.stringify(backend));
  assert.equal(backend.authenticated, true);
  assert.equal(backend.authState, 'verified');
  assert.deepEqual(backend.models.map(model => model.id), ['native-model', 'fast-model']);
  assert.deepEqual(backend.models[0].supportedReasoningEfforts, []);
  assert.equal(rows('prompt').length, 0);
});

test('legacy optional parameters work; Unicode and tools preserve two turns in one native process', async () => {
  const session = await create('ordinary-legacy');
  const first = await completed(session, 'ordinary-1', 'FIXTURE_INSPECT');
  const initial = inspect(first);
  assert.ok(initial.args.includes('--input-format'));
  assert.ok(!initial.args.includes('--acp'));
  assert.ok(!initial.args.includes('--dangerously-skip-permissions'));
  assert.equal((await request('/backends?backend=gemini&refresh=1')).status, 200);
  const second = await completed(session, 'ordinary-2', 'FIXTURE_INSPECT');
  assert.equal(inspect(second).pid, initial.pid);
  assert.equal(inspect(second).nativeId, initial.nativeId);
  assert.equal(second.items.some(item => item.type === 'mcpToolCall' && item.result === 'read result'), true);
  const unicode = await completed(session, 'ordinary-3', 'hello');
  assert.equal(answers(unicode).at(-1).text, '中文😀');
  const count = rows('prompt').length;
  const duplicate = await turn(session, 'ordinary-3', 'must not replay');
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(rows('prompt').length, count);
  const resultOnly = await completed(session, 'ordinary-4', 'FIXTURE_RESULT_ONLY');
  assert.equal(answers(resultOnly).at(-1).text, '中文😀');
});

test('restoring an owned session resumes the exact agy native conversation without replay', async () => {
  const session = await create('restored-session');
  const first = await completed(session, 'resume-1', 'FIXTURE_INSPECT');
  const original = inspect(first), count = rows('prompt').length;
  await stop(); await start();
  const read = await request(`/sessions/${session.id}`);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(answers(read.json).at(-1).text, answers(first).at(-1).text);
  assert.equal(rows('prompt').length, count, 'restart and reads cannot replay the previous prompt');
  const resumed = await completed(session, 'resume-2', 'FIXTURE_INSPECT');
  const next = inspect(resumed);
  assert.notEqual(next.pid, original.pid);
  assert.equal(next.nativeId, original.nativeId);
  assert.equal(next.args[next.args.indexOf('--conversation') + 1], original.nativeId);
  assert.equal(rows('prompt').length, count + 1);
});

test('a zero-turn Rust sidecar can be read and continued by the Node native adapter', async () => {
  const session = await create('zero-turn-engine-switch', { roots: [root, extraRoot], model: 'native-model', mode: 'plan' });
  const directory = path.join(home, '.keepwork-mcp', 'agent-sessions-v1.json.gemini');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, session.threadId + '.json'), 'utf8'));
  assert.equal(saved.driver, 'antigravity-v1');
  assert.ok(saved.nativeId);
  assert.deepEqual(saved.roots, [root, extraRoot]);
  assert.equal(saved.cwd, root);
  assert.equal(saved.model, 'native-model');
  assert.equal(saved.mode, 'plan');
  assert.deepEqual(saved.turns, []);
  const count = rows('prompt').length;
  const previous = require.extensions['.ts'];
  let adapter, completionTimeout;
  await stop();
  try {
    // Loading the Node adapter can fail too; always restore the shared Rust peer.
    const ts = require('typescript');
    require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, filename);
    const { AntigravityHarness } = require('../../src/core/antigravityHarness.ts');
    adapter = new AntigravityHarness(directory, process.execPath, [fixture]);
    assert.equal((await adapter.call('thread/read', { threadId: session.threadId })).thread.nativeId, saved.nativeId);
    await adapter.call('thread/resume', { threadId: session.threadId });
    const completion = new Promise((resolve, reject) => {
      completionTimeout = setTimeout(() => reject(new Error('Node continuation fixture timed out')), 5000);
      adapter.on('notification', message => {
        if (message.method === 'turn/completed') { clearTimeout(completionTimeout); resolve(message.params.turn); }
      });
    });
    await adapter.call('turn/start', { threadId: session.threadId, input: [{ type: 'text', text: 'FIXTURE_INSPECT' }] });
    assert.equal((await completion).status, 'completed');
    const continued = (await adapter.call('thread/read', { threadId: session.threadId })).thread;
    const data = JSON.parse(continued.turns.at(-1).items.find(item => item.type === 'agentMessage').text);
    assert.equal(data.nativeId, saved.nativeId);
    assert.equal(data.args[data.args.indexOf('--conversation') + 1], saved.nativeId);
    assert.ok(data.args.includes(extraRoot));
    assert.equal(data.args[data.args.indexOf('--mode') + 1], 'plan');
    assert.equal(rows('prompt').length, count, 'Node fixture does not write to the Rust process log');
  } finally {
    clearTimeout(completionTimeout);
    try {
      adapter?.close();
    } finally {
      if (previous) require.extensions['.ts'] = previous; else delete require.extensions['.ts'];
      await start();
    }
  }
});

test('owner checks and unsupported images reject before any native prompt is sent', async () => {
  const session = await create('owned-session');
  const before = rows('prompt').length;
  const read = await request(`/sessions/${session.id}`, { owner: ownerB });
  assert.notEqual(read.status, 200);
  assert.doesNotMatch(JSON.stringify(read.json), new RegExp(session.threadId));
  const scopedProbe = await request(`/backends?backend=gemini&sessionId=${session.id}`, { owner: ownerB });
  assert.notEqual(scopedProbe.status, 200);
  const stolen = await request(`/sessions/${session.id}/turns`, { method: 'POST', owner: ownerB, body: { requestId: 'stolen-1', text: 'must not dispatch' } });
  assert.notEqual(stolen.status, 200);
  const image = await turn(session, 'image-1', 'must not dispatch', { images: ['data:image/png;base64,YQ=='] });
  assert.notEqual(image.status, 200);
  assert.match(JSON.stringify(image.json), /text|image|unsupported|不支持/i);
  assert.equal(rows('prompt').length, before);
});

test('native denial, crashes, interruption and conversation mismatch fail observably without replay', async () => {
  const denied = await create('denied-session');
  assert.equal((await turn(denied, 'denied-1', 'FIXTURE_DENIED')).status, 200);
  const denial = await waitSession(denied, value => value.status === 'failed');
  assert.match(denial.error, /denied|permission/i);
  const crashed = await create('crashed-session');
  await turn(crashed, 'crash-1', 'FIXTURE_CRASH');
  await waitSession(crashed, value => ['failed', 'uncertain', 'error'].includes(value.status));
  const waiting = await create('waiting-session');
  assert.equal((await turn(waiting, 'wait-1', 'FIXTURE_WAIT')).status, 200);
  await waitSession(waiting, value => value.status === 'running');
  const stopped = await request(`/sessions/${waiting.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
  await waitSession(waiting, value => value.status === 'interrupted');
  const mismatch = await create('mismatched-session');
  await turn(mismatch, 'mismatch-1', 'FIXTURE_BAD_ID');
  await waitSession(mismatch, value => ['failed', 'uncertain', 'error'].includes(value.status));
  const malformed = await create('malformed-session');
  await turn(malformed, 'malformed-1', 'FIXTURE_BAD_JSON');
  await waitSession(malformed, value => ['failed', 'uncertain', 'error'].includes(value.status));
  const flood = await create('flooded-session');
  await turn(flood, 'flood-1', 'FIXTURE_FLOOD');
  await waitSession(flood, value => ['failed', 'uncertain', 'error'].includes(value.status));
  for (const [session, requestId] of [[denied, 'denied-1'], [crashed, 'crash-1'], [waiting, 'wait-1'],
    [mismatch, 'mismatch-1'], [malformed, 'malformed-1'], [flood, 'flood-1']]) {
    await turn(session, requestId, 'same request identity must not replay');
  }
  for (const marker of ['FIXTURE_DENIED', 'FIXTURE_CRASH', 'FIXTURE_WAIT', 'FIXTURE_BAD_ID', 'FIXTURE_BAD_JSON', 'FIXTURE_FLOOD']) {
    assert.equal(rows('prompt').filter(row => row.content.includes(marker)).length, 1, marker + ' must be sent once');
  }
});

test('Node Antigravity sidecars resume natively while legacy Gemini history stays read-only', async () => {
  const seed = await create('history-record-template');
  await completed(seed, 'history-template-1', 'hello');
  await stop();
  const registryFile = path.join(home, '.keepwork-mcp', 'agent-sessions-v1.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const template = registry.find(row => row.id === seed.id);
  const sidecars = registryFile + '.gemini'; fs.mkdirSync(sidecars, { recursive: true });
  const legacy = { ...template, id: 'legacy-gemini-fixture', threadId: 'legacy-gemini-thread',
    conversationId: 'legacy-gemini-record', status: 'idle' };
  const native = { ...template, id: 'node-antigravity-fixture', threadId: 'node-antigravity-thread',
    conversationId: 'node-antigravity-record', status: 'idle' };
  for (const record of [legacy, native]) {
    delete record.items; delete record.nativeMetadata;
    const thread = { id: record.threadId, cwd: root, roots: [root], turns: [
      { id: 'saved-history-turn', items: [{ id: 'saved-history-item', type: 'agentMessage', text: 'saved Node history' }] },
    ] };
    if (record === native) { thread.driver = 'antigravity-v1'; thread.nativeId = 'native-node-fixture-123'; }
    fs.writeFileSync(path.join(sidecars, record.threadId + '.json'), JSON.stringify(thread));
  }
  fs.writeFileSync(registryFile, JSON.stringify([...registry, legacy, native]));
  const count = rows('prompt').length;
  await start();
  for (const record of [legacy, native]) {
    const read = await request(`/sessions/${record.id}`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.equal(answers(read.json).at(-1).text, 'saved Node history');
  }
  const rejected = await turn(legacy, 'legacy-no-replay-1', 'legacy prompt must not dispatch');
  assert.notEqual(rejected.status, 200);
  assert.match(JSON.stringify(rejected.json), /Gemini|new Antigravity|legacy/i);
  assert.equal(rows('prompt').length, count);
  const resumed = await completed(native, 'node-resume-1', 'FIXTURE_INSPECT');
  const data = inspect(resumed);
  assert.equal(data.nativeId, 'native-node-fixture-123');
  assert.equal(data.args[data.args.indexOf('--conversation') + 1], 'native-node-fixture-123');
  assert.equal(answers(resumed)[0].text, 'saved Node history');
});

test('native cancellation results preserve interrupted status', async () => {
  for (const status of ['CANCELED', 'INTERRUPTED']) {
    const session = await create('native-' + status.toLowerCase());
    const result = await turn(session, 'native-cancel-1', 'FIXTURE_NATIVE_' + status);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    await waitSession(session, value => value.status === 'interrupted');
    assert.equal(rows('prompt').filter(row => row.content.includes('FIXTURE_NATIVE_' + status)).length, 1);
  }
});

test('only positively empty Node wrappers without uncertain submissions may initialize their first native conversation', async () => {
  const seed = await create('empty-node-record-template');
  await stop();
  const registryFile = path.join(home, '.keepwork-mcp', 'agent-sessions-v1.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const template = registry.find(row => row.id === seed.id);
  const directory = registryFile + '.gemini';
  const variants = [
    { name: 'safe-empty', receipts: {}, safe: true },
    { name: 'safe-rejected', receipts: { previous: { state: 'rejected' } }, safe: true },
    { name: 'unsafe-unknown', receipts: { previous: { state: 'unknown' } } },
    { name: 'unsafe-accepted', receipts: { previous: { state: 'accepted' } } },
    { name: 'unsafe-history', receipts: {}, history: true },
    { name: 'unsafe-missing-history', receipts: {}, missing: true },
  ];
  for (const variant of variants) {
    variant.record = { ...template, id: variant.name + '-id', threadId: variant.name + '-thread',
      conversationId: variant.name + '-conversation', status: 'idle', submissions: variant.receipts };
    delete variant.record.items; delete variant.record.nativeMetadata;
    if (variant.missing) {
      variant.record.items = [];
      variant.record.nativeMetadata = { driver: 'antigravity-v1' };
    } else {
      const thread = { id: variant.record.threadId, cwd: root, roots: [root], driver: 'antigravity-v1', turns: variant.history
        ? [{ id: 'existing-turn', items: [{ id: 'existing-reply', type: 'agentMessage', text: 'history without native ID' }] }] : [] };
      fs.writeFileSync(path.join(directory, variant.record.threadId + '.json'), JSON.stringify(thread));
    }
    registry.push(variant.record);
  }
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  await start();
  for (const variant of variants) {
    const count = rows('prompt').length;
    if (variant.safe) {
      const result = await completed(variant.record, 'first-native-turn', 'FIXTURE_INSPECT');
      assert.equal(inspect(result).args.includes('--conversation'), false, 'a proven empty wrapper creates its first native conversation');
      assert.equal(rows('prompt').length, count + 1);
    } else {
      const rejected = await turn(variant.record, 'must-not-submit', 'uncertain work must not initialize a new native conversation');
      assert.notEqual(rejected.status, 200, variant.name);
      assert.match(JSON.stringify(rejected.json), /identity|history|unavailable|preserve/i);
      assert.equal(rows('prompt').length, count, variant.name + ' must not dispatch');
    }
  }
});

test('context MCP configuration is scoped and native plan permissions stay intact', async () => {
  const conversationId = 'context-session';
  const registered = await request(`/contexts/${conversationId}`, { method: 'POST', body: {
    pageId: 'fixture-page', generation: 'fixture-generation', instructions: 'Use the owned workspace.',
    revision: 'fixture-revision', tools: [],
  } });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const session = await create(conversationId, { contextVersion: 1, roots: [root, extraRoot], mode: 'plan' });
  const result = await completed(session, 'context-1', 'FIXTURE_INSPECT');
  const data = inspect(result);
  assert.notEqual(data.cwd, root);
  assert.ok(data.args.includes('--add-dir'));
  assert.ok(data.args.includes(root)); assert.ok(data.args.includes(extraRoot));
  assert.equal(data.args[data.args.indexOf('--mode') + 1], 'plan');
  assert.ok(data.mcp.mcpServers.keepwork_aichat.command);
  assert.equal(data.hasCapability, true);
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  const config = fs.readFileSync(path.join(data.cwd, '.agents', 'mcp_config.json'), 'utf8');
  assert.doesNotMatch(config, /KEEPWORK_AICHAT_CAPABILITY/);
  assert.equal(data.mcp.mcpServers.keepwork_aichat.env, undefined);
  const registry = fs.readFileSync(path.join(home, '.keepwork-mcp', 'agent-sessions-v1.json'), 'utf8');
  assert.doesNotMatch(registry, /KEEPWORK_AICHAT_CAPABILITY/);
});

test('a failed model refresh keeps authentication unknown and ordinary sessions usable', async () => {
  fs.writeFileSync(logFile + '.models-fail', 'fail');
  try {
    const failed = await request('/backends?backend=gemini&refresh=1');
    assert.equal(failed.status, 200, JSON.stringify(failed.json));
    assert.equal(failed.json.gemini.authenticated, null);
    assert.equal(failed.json.gemini.authState, 'unknown');
    assert.ok(failed.json.gemini.error || failed.json.gemini.modelsError);
    assert.doesNotMatch(JSON.stringify(failed.json), /private-fixture-diagnostic/);
  } finally { fs.rmSync(logFile + '.models-fail'); }
  const session = await create('after-model-failure');
  await completed(session, 'after-model-failure-1', 'hello');
});
