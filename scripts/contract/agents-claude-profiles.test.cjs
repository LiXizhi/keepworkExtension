const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const h = require('./harness.cjs');

// Both real HTTP engines use the same isolated, synthetic Claude peer. Nothing
// reads native account files, starts authorization or calls a model provider.
const owner = 'claude-profile-contract-'.padEnd(40, 'p');
const profile = (overrides = {}) => ({ name: 'First provider', baseUrl: 'https://fixture-first.example.test/anthropic',
  authType: 'authToken', secret: 'fixture-first-secret', model: 'fixture-first-model',
  sonnetModel: 'fixture-first-sonnet', opusModel: 'fixture-first-opus', haikuModel: 'fixture-first-haiku', ...overrides });
const secretPattern = /fixture-(?:first|second|replacement)-secret|SECRET_CLAUDE_AUTH_TOKEN/;

async function nodeDaemon(env, home, port) {
  const child = spawn(process.execPath, [path.join(h.repoRoot, 'apps/mcp-runtime/dist/cli.cjs'), '--port', String(port)], {
    cwd: h.repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, ...env, KEEPWORK_MCP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  let output = '', ownsEndpoint = false, stopping;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('exit', code => resolve({ code })); });
  const closed = new Promise(resolve => child.once('close', resolve));
  async function within(promise, delay) {
    let timer;
    try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), delay); })]); }
    finally { clearTimeout(timer); }
  }
  const stop = () => stopping ||= (async () => {
    if (child.exitCode === null && child.signalCode === null && ownsEndpoint) {
      try {
        const token = fs.readFileSync(path.join(home, '.keepwork-mcp/token'), 'utf8').trim();
        await fetch(`http://127.0.0.1:${port}/admin/stop`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000) });
        await within(exited, 5000);
      } catch { /* Bound cleanup to this test-owned process tree. */ }
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, resolve));
      else try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    assert.ok(await within(exited, 5000), 'test-owned Node daemon exited');
    if (!await within(closed, 1000)) { child.stdout.destroy(); child.stderr.destroy(); assert.fail('test-owned Node daemon left stdio open'); }
  })();
  try {
    const health = await Promise.race([h.waitForHealth(port), exited.then(result => { throw result.error || Error('Node reference stopped before health'); })]);
    assert.equal(health.pid, child.pid, 'only the test-owned endpoint can be stopped'); ownsEndpoint = true;
    return { base: `http://127.0.0.1:${port}`, health, stop, output: () => output };
  } catch (error) { await stop(); throw error; }
}

async function fixture(t, engine) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `kp-claude-profiles-${engine}-`)));
  const home = path.join(directory, 'home'), root = path.join(directory, 'workspace'), log = path.join(directory, 'native.log');
  fs.mkdirSync(home); fs.mkdirSync(root);
  const cli = path.join(directory, 'claude fixture.cjs'); fs.copyFileSync(path.join(__dirname, 'fixtures/claude-agent-cli.cjs'), cli);
  const port = await h.freePort(), absent = path.join(directory, 'missing');
  const env = { KEEPWORK_CLAUDE_PATH: cli, KEEPWORK_NODE_PATH: process.execPath, KEEPWORK_AGENT_FIXTURE_LOG: log,
    KEEPWORK_CLAUDE_FIXTURE_PROFILE_MODE: '1', KEEPWORK_MCP_ROOT: root, KEEPWORK_MCP_REQUIRE_AUTH: '1', KEEPWORK_MCP_HOST_KIND: 'standalone',
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_MODEL: '' };
  for (const backend of ['CODEX', 'WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) env['KEEPWORK_' + backend + '_PATH'] = absent;
  const originalSettings = JSON.stringify({ permissions: { defaultMode: 'default' }, env: { FIXTURE_UNRELATED: 'preserved' } });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR); fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), originalSettings);
  let daemon, activeEngine = engine;
  t.after(async () => { try { await daemon?.stop(); } finally { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } });
  async function start() { daemon = activeEngine === 'rust' ? await h.startRust({ env, home, port, requireAuth: true }) : await nodeDaemon(env, home, port); }
  await start();
  const token = () => fs.readFileSync(path.join(home, '.keepwork-mcp/token'), 'utf8').trim();
  async function request(route, method = 'GET', body, extra = {}) {
    const headers = { origin: daemon.base, 'x-agent-owner': owner, authorization: 'Bearer ' + token(), 'content-type': 'application/json', ...extra };
    for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
    const response = await fetch(daemon.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    assert.doesNotMatch(text, secretPattern, 'HTTP responses never expose fixture credentials');
    return { status: response.status, body: value, headers: response.headers };
  }
  async function ok(route, method, body) { const result = await request(route, method, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  const config = () => ok('/agents/claude/config');
  const status = () => ok('/agents/backends?backend=claude&refresh=1').then(value => value.claude);
  async function create(conversationId) { return ok('/agents/sessions', 'POST', { backend: 'claude', conversationId, roots: [root] }); }
  async function completed(session, requestId) {
    await ok(`/agents/sessions/${session.id}/turns`, 'POST', { requestId, text: 'ordinary fixture chat' });
    const until = Date.now() + 5000;
    do {
      const value = await ok('/agents/sessions/' + session.id);
      if (value.status === 'completed') return value;
      assert.notEqual(value.status, 'failed', JSON.stringify(value));
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < until);
    assert.fail('fixture turn did not complete');
  }
  const rows = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const launch = thread => rows().filter(row => row.type === 'launch' && row.thread === thread).at(-1);
  return { home, root, request, ok, config, status, create, completed, rows, launch,
    health: () => daemon.health,
    restart: async () => { await daemon.stop(); await start(); },
    switchEngine: async next => { await daemon.stop(); activeEngine = next; await start(); },
    unchangedNativeSettings: () => assert.equal(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'), originalSettings),
    output: () => daemon.output(),
  };
}

for (const engine of ['rust', 'node']) test(`${engine} Claude profiles-v1 preserves configuration, ownership and legacy sessions`,
  engine === 'node' ? h.nodeReferenceTestOptions() : {}, async t => {
    const f = await fixture(t, engine);
    let first, second, oldSession;
    await t.test('advertises the additive contract and guards it with Origin, owner and optional auth', async () => {
      assert.equal(f.health().claudeConfigApi, 'profiles-v1');
      const response = await f.request('/agents/claude/config'); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(response.body, { version: 1, activeProfileId: null, profiles: [] });
      assert.equal((await f.request('/agents/claude/config', 'GET', undefined, { origin: 'https://untrusted.example.test' })).status, 403);
      assert.equal((await f.request('/agents/claude/config', 'GET', undefined, { 'x-agent-owner': undefined })).status, 400);
      assert.equal((await f.request('/agents/claude/config', 'GET', undefined, { 'x-agent-owner': 'bad' })).status, 400);
      assert.equal((await f.request('/agents/claude/config', 'GET', undefined, { authorization: undefined })).status, 401);
      assert.deepEqual(await f.config(), response.body);
    });
    await t.test('validates CRUD atomically, hides credentials and preserves an omitted secret', async () => {
      const added = await f.ok('/agents/claude/config/profiles', 'POST', profile()); first = added.profiles[0];
      assert.equal(first.hasSecret, true); assert.equal('secret' in first, false);
      const original = await f.config();
      const invalid = [null, [], {}, profile({ baseUrl: 'file:///fixture' }), profile({ baseUrl: 'https://user:pass@example.test' }),
        profile({ baseUrl: 'https://example.test/?token=no' }), profile({ authType: 'oauth' }), profile({ secret: '' }), profile({ secret: 'bad\nheader' }),
        profile({ model: 'bad\u0000model' }), profile({ unsupported: true })];
      for (const input of invalid) {
        assert.equal((await f.request('/agents/claude/config/profiles', 'POST', input)).status, 400);
        assert.deepEqual(await f.config(), original, 'invalid create cannot change the saved configuration');
      }
      for (const input of [{}, null, [], { profileId: first.id, unsupported: true }, { profileId: 'missing' }]) {
        assert.equal((await f.request('/agents/claude/config/activate', 'POST', input)).status, 400);
        assert.deepEqual(await f.config(), original);
      }
      await f.ok('/agents/claude/config/profiles/' + first.id, 'PATCH', { name: 'Renamed provider' });
      assert.equal((await f.config()).profiles[0].name, 'Renamed provider');
      assert.equal((await f.request('/agents/claude/config/profiles/' + first.id, 'PATCH', { id: 'changed' })).status, 400);
      assert.equal((await f.request('/agents/claude/config/profiles/' + first.id + '/extra', 'PATCH', { name: 'reject' })).status, 404);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.home, '.keepwork-mcp/claude-profiles-v1.json')).mode & 0o777, 0o600);
    });
    await t.test('activation applies authentication and model mappings to new processes without modifying native settings', async () => {
      const native = await f.status(); assert.equal(native.available, true); assert.equal(native.authenticated, false);
      await f.ok('/agents/claude/config/activate', 'POST', { profileId: first.id });
      const info = await f.status(); assert.equal(info.authenticated, true); assert.equal(info.account.type, 'apiKey');
      assert.ok(info.models.some(model => model.id === 'fixture-first-model'));
      assert.ok(info.models.some(model => model.id === 'fixture-first-sonnet'));
      assert.equal(f.rows().some(row => row.type === 'message' && row.message.type === 'user'), false, 'discovery does not submit prompts');
      oldSession = await f.create('profile-live-original'); await f.completed(oldSession, 'first-original');
      const started = f.launch(oldSession.threadId); assert.equal(started.provider.credentialKind, 'authToken');
      assert.equal(started.provider.fixtureSecretMarker, 'fixture-first-secret');
      assert.equal(started.provider.baseUrl, 'https://fixture-first.example.test/anthropic');
      assert.equal(started.provider.model, 'fixture-first-model');
      assert.ok(!JSON.stringify(started.args).match(secretPattern), 'credentials never enter argv');
      if (process.platform !== 'win32') assert.equal(started.provider.settingsMode, 0o600);
      f.unchangedNativeSettings();
      assert.equal((await f.request('/agents/claude/config/profiles/' + first.id, 'DELETE')).status, 400);
      assert.ok([400, 403, 404].includes((await f.request('/agents/sessions/' + oldSession.id, 'GET', undefined, { 'x-agent-owner': 'other-profile-owner-'.padEnd(40, 'x') })).status));
    });
    await t.test('switching providers keeps the original live process and invalidates identity/model caches', async () => {
      second = (await f.ok('/agents/claude/config/profiles', 'POST', profile({ name: 'Second provider', baseUrl: 'https://fixture-second.example.test',
        authType: 'apiKey', secret: 'fixture-second-secret', model: 'fixture-second-model', sonnetModel: '', opusModel: '', haikuModel: '' }))).profiles.at(-1);
      await f.ok('/agents/claude/config/activate', 'POST', { profileId: second.id });
      const info = await f.status(); assert.equal(info.authenticated, true);
      assert.ok(info.models.some(model => model.id === 'fixture-second-model'));
      assert.equal(info.models.some(model => model.id.startsWith('fixture-first-')), false);
      const originalPid = f.launch(oldSession.threadId).pid;
      await f.completed(oldSession, 'second-original');
      assert.equal(f.launch(oldSession.threadId).pid, originalPid, 'provider switch preserves the live process');
      const newSession = await f.create('profile-new-provider'); await f.completed(newSession, 'new-provider');
      assert.equal(f.launch(newSession.threadId).provider.fixtureSecretMarker, 'fixture-second-secret');
      assert.equal(f.launch(newSession.threadId).provider.credentialKind, 'apiKey');
      assert.equal(f.launch(newSession.threadId).provider.model, 'fixture-second-model');
      await f.ok('/agents/claude/config/profiles/' + second.id, 'PATCH', { secret: 'fixture-replacement-secret' });
      const edited = await f.create('profile-edited-provider'); await f.completed(edited, 'edited-provider');
      assert.equal(f.launch(edited.threadId).provider.fixtureSecretMarker, 'fixture-replacement-secret');
      f.unchangedNativeSettings();
    });
    await t.test('restart restores the selected provider without replaying legacy prompts', async () => {
      const before = f.rows().filter(row => row.type === 'message' && row.message.type === 'user').length;
      await f.restart(); assert.equal((await f.config()).activeProfileId, second.id);
      assert.equal(f.rows().filter(row => row.type === 'message' && row.message.type === 'user').length, before);
      await f.completed(oldSession, 'after-profile-restart');
      const resumed = f.launch(oldSession.threadId);
      assert.ok(resumed.args.includes('--resume=' + oldSession.threadId));
      assert.equal(resumed.provider.fixtureSecretMarker, 'fixture-replacement-secret');
      assert.equal(f.rows().filter(row => row.type === 'message' && row.message.type === 'user').length, before + 1);
      const state = await f.ok('/agents/sessions/' + oldSession.id);
      assert.equal(state.status, 'completed'); assert.equal(state.backend, 'claude');
    });
    await t.test('native selection and profile deletion retain legacy ordinary session behavior', async () => {
      await f.ok('/agents/claude/config/activate', 'POST', { profileId: null });
      assert.equal((await f.status()).authenticated, false);
      const legacy = await f.create('legacy-native-no-config-fields'); await f.completed(legacy, 'legacy-native-turn');
      assert.equal(f.launch(legacy.threadId).args.includes('--settings'), false);
      await f.ok('/agents/claude/config/profiles/' + first.id, 'DELETE');
      await f.ok('/agents/claude/config/profiles/' + second.id, 'DELETE');
      assert.deepEqual(await f.config(), { version: 1, activeProfileId: null, profiles: [] });
      f.unchangedNativeSettings();
      assert.doesNotMatch(f.output(), secretPattern, 'daemon diagnostics never expose credentials');
      assert.equal(f.rows().some(row => row.type === 'launch' && row.args.includes('login')), false);
    });
  });

test('Claude profiles persist across Node to Rust and Rust to Node engine changes', h.nodeReferenceTestOptions(), async t => {
  const f = await fixture(t, 'node');
  const first = (await f.ok('/agents/claude/config/profiles', 'POST', profile())).profiles[0];
  await f.ok('/agents/claude/config/activate', 'POST', { profileId: first.id });
  const nodeSaved = await f.config();
  // Each switch awaits shutdown before starting the other engine on the same
  // port/profile. These are storage transfers, never concurrent file writers.
  await f.switchEngine('rust');
  assert.deepEqual(await f.config(), nodeSaved, 'Rust reads Node-written profiles and active selection');
  assert.equal((await f.status()).authenticated, true);
  const rustSession = await f.create('node-profile-read-by-rust'); await f.completed(rustSession, 'rust-cross-engine');
  assert.equal(f.launch(rustSession.threadId).provider.fixtureSecretMarker, 'fixture-first-secret');
  await f.ok('/agents/claude/config/profiles/' + first.id, 'PATCH', {
    name: 'Updated by Rust', authType: 'apiKey', secret: 'fixture-replacement-secret', model: 'fixture-rust-model',
  });
  const rustSaved = await f.config();
  await f.switchEngine('node');
  assert.deepEqual(await f.config(), rustSaved, 'Node reads Rust-written updates without losing omitted fields');
  const info = await f.status(); assert.equal(info.authenticated, true);
  assert.ok(info.models.some(model => model.id === 'fixture-rust-model'));
  assert.ok(info.models.some(model => model.id === 'fixture-first-sonnet'));
  const nodeSession = await f.create('rust-profile-read-by-node'); await f.completed(nodeSession, 'node-cross-engine');
  assert.equal(f.launch(nodeSession.threadId).provider.fixtureSecretMarker, 'fixture-replacement-secret');
  assert.equal(f.launch(nodeSession.threadId).provider.credentialKind, 'apiKey');
  assert.equal(f.launch(nodeSession.threadId).provider.model, 'fixture-rust-model');
  f.unchangedNativeSettings();
  assert.doesNotMatch(f.output(), secretPattern);
});
