const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const h = require('./harness.cjs');

// Exercise both real HTTP engines and ACP subprocesses using synthetic account
// data. The fixture never reads existing OpenCode credentials or uses a network.
const route = '/agents/opencode/config';
const owner = 'opencode-config-contract-owner-1234';
const fixtureKey = 'fixture-opencode-secret-1234';
const profile = {
  name: 'Fixture Gateway',
  baseUrl: 'https://gateway.example.test/v1',
  model: 'vendor/fixture-model',
};

function runNativeFixture() {
  const fs = require('node:fs');
  const { randomUUID } = require('node:crypto');
  const readline = require('node:readline');
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  const entries = Object.entries(config.provider || {});
  const [providerId, provider] = entries.find(([id]) => /^keepwork-openai-[0-9a-f]{16}$/.test(id)) || [];
  const endpoint = provider?.options;
  const modelIds = providerId ? Object.keys(provider.models).map(id => providerId + '/' + id) : [];
  const defaultModel = config.model || modelIds[0] || 'native-opencode/fixture-native';
  const availableModels = [defaultModel, ...modelIds.filter(id => id !== defaultModel)]
    .map(modelId => ({ modelId, name: modelId }));
  const sessions = new Map();
  function send(message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    const reply = result => send({ id, result });
    if (method === 'initialize') return reply({
      protocolVersion: 1, agentInfo: { name: 'opencode-fixture', version: '2.2.5' },
      agentCapabilities: { loadSession: true }, authMethods: [],
    });
    if (method === 'session/new' || method === 'session/load') {
      const sessionId = params.sessionId || randomUUID();
      sessions.set(sessionId, defaultModel);
      return reply({ sessionId, models: { currentModelId: defaultModel, availableModels },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } });
    }
    if (method === 'session/set_model') {
      if (!availableModels.some(model => model.modelId === params.modelId)) {
        return send({ id, error: { code: -32602, message: 'Unknown model' } });
      }
      sessions.set(params.sessionId, params.modelId);
      return reply({});
    }
    if (method === 'session/prompt') {
      fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({
        model: sessions.get(params.sessionId), baseUrl: endpoint?.baseURL,
        carriesFixtureKey: endpoint?.apiKey === '{env:KEEPWORK_OPENCODE_API_KEY}'
          && process.env.KEEPWORK_OPENCODE_API_KEY === 'fixture-opencode-secret-1234',
      }) + '\n');
      send({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture response' } } } });
      return reply({ stopReason: 'end_turn' });
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported fixture method: ' + method } });
  });
}

async function startNode(options) {
  const { home, port, env } = options;
  const child = spawn(process.execPath, [path.join(h.repoRoot, 'apps/mcp-runtime/dist/cli.cjs'), '--port', String(port), '--require-auth'], {
    cwd: h.repoRoot, env: { ...process.env, ...env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = 'http://127.0.0.1:' + port;
  const closed = once(child, 'close');
  const controller = new AbortController();
  let ownsEndpoint = false;
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (ownsEndpoint) {
        const token = fs.readFileSync(path.join(home, '.keepwork-mcp/token'), 'utf8').trim();
        const response = await fetch(base + '/admin/stop', { method: 'POST',
          headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer();
      } else child.kill();
    } finally {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  }
  try {
    const health = await Promise.race([
      h.waitForHealth(port, 10000, controller.signal),
      closed.then(() => { throw new Error('Node reference daemon exited before health'); }),
    ]);
    assert.equal(health.pid, child.pid);
    ownsEndpoint = true;
    return { base, health, stop, output: () => output };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    controller.abort();
  }
}

for (const engine of ['rust', 'node']) {
  test(engine + ' configures OpenCode and preserves its existing ACP session contract',
    { timeout: 45000, ...(engine === 'node' ? h.nodeReferenceTestOptions() : {}) }, async t => {
      const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-opencode-config-')));
      const home = path.join(directory, 'home');
      const root = path.join(directory, 'workspace');
      const cli = path.join(directory, 'opencode-fixture.cjs');
      const log = path.join(directory, 'prompts.ndjson');
      const xdg = path.join(home, '.config');
      const nativeConfig = path.join(xdg, 'opencode', 'opencode.jsonc');
      const originalConfig = '{\n  // openCode settings from outside AIChat\n  "model": "native-opencode/fixture-native"\n}\n';
      let daemon;
      t.after(async () => {
        try { await daemon?.stop(); }
        finally { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      });
      fs.mkdirSync(root);
      fs.mkdirSync(path.dirname(nativeConfig), { recursive: true });
      fs.writeFileSync(nativeConfig, originalConfig);
      fs.writeFileSync(cli, '(' + runNativeFixture + ')();\n');
      const env = {
        KEEPWORK_MCP_ROOT: root, KEEPWORK_MCP_HOST_KIND: 'standalone',
        KEEPWORK_OPENCODE_PATH: cli, KEEPWORK_NODE_PATH: process.execPath, KEEPWORK_AGENT_FIXTURE_LOG: log,
        OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '', KEEPWORK_OPENCODE_API_KEY: '', XDG_CONFIG_HOME: xdg,
      };
      const start = async () => {
        const options = { home, env, port: await h.freePort(), requireAuth: true };
        daemon = await (engine === 'rust' ? h.startRust(options) : startNode(options));
      };
      await start();
      async function request(endpoint, method = 'GET', body, extra = {}) {
        const token = fs.readFileSync(path.join(home, '.keepwork-mcp/token'), 'utf8').trim();
        const headers = { origin: daemon.base, 'x-agent-owner': owner, authorization: 'Bearer ' + token, ...extra };
        if (body !== undefined) headers['content-type'] = 'application/json';
        for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
        const response = await fetch(daemon.base + endpoint, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        const text = await response.text();
        assert.ok(!text.includes(fixtureKey), 'HTTP responses omit the stored API key');
        let value;
        try { value = JSON.parse(text); } catch { value = text; }
        return { response, value };
      }
      async function ok(endpoint, method, body) {
        const { response, value } = await request(endpoint, method, body);
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      }
      const catalog = async (includeManaged = false) => {
        const query = new URLSearchParams({ backend: 'opencode', refresh: '1', conversationId: 'catalog-preview', cwd: root });
        if (includeManaged) query.set('includeManagedOpenCode', '1');
        const info = (await ok('/agents/backends?' + query)).opencode;
        assert.equal(info.available, true, JSON.stringify(info));
        assert.equal(info.modelsError, undefined, JSON.stringify(info));
        return info.models;
      };
      const modelIds = async (includeManaged = false) => (await catalog(includeManaged)).map(model => model.id);
      const create = (conversationId, model) => ok('/agents/sessions', 'POST', {
        backend: 'opencode', conversationId, roots: [root], model,
      });
      async function prompt(session, requestId) {
        await ok('/agents/sessions/' + session.id + '/turns', 'POST', { requestId, text: 'Ordinary fixture prompt' });
        const deadline = Date.now() + 5000;
        do {
          const updated = await ok('/agents/sessions/' + session.id);
          assert.notEqual(updated.status, 'failed', JSON.stringify(updated));
          if (updated.status === 'completed' && updated.lastSubmission?.requestId === requestId) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        assert.fail('Fixture OpenCode prompt did not complete');
      }
      const promptLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);

      assert.equal(daemon.health.opencodeConfigApi, 'openai-compatible-v1');
      const empty = await request(route);
      assert.equal(empty.response.status, 200);
      assert.equal(empty.response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(empty.value, { version: 1, provider: null });
      for (const [headers, code] of [[{ origin: 'https://untrusted.example.test' }, 403],
        [{ 'x-agent-owner': undefined }, 400], [{ authorization: undefined }, 401]]) {
        assert.equal((await request(route, 'PATCH', { ...profile, apiKey: fixtureKey }, headers)).response.status, code);
      }
      assert.deepEqual(await modelIds(), ['native-opencode/fixture-native']);
      const native = await create('native-before-config');
      await prompt(native, 'before-config');

      assert.deepEqual(await ok(route, 'PATCH', { ...profile, apiKey: fixtureKey }),
        { version: 1, provider: { ...profile, hasApiKey: true } });
      for (const baseUrl of ['file:///tmp/fixture', 'https://user:password@gateway.example.test/v1']) {
        assert.equal((await request(route, 'PATCH', { ...profile, baseUrl })).response.status, 400);
      }
      const differentEndpoint = { ...profile, baseUrl: 'https://elsewhere.example.test/v1' };
      assert.equal((await request(route, 'PATCH', differentEndpoint)).response.status, 400);
      const renamed = { ...profile, name: 'Renamed Gateway' };
      assert.deepEqual(await ok(route, 'PATCH', renamed), { version: 1, provider: { ...renamed, hasApiKey: true } });
      assert.deepEqual(await modelIds(), ['native-opencode/fixture-native'], 'legacy catalog preserves native-only behavior');
      const managedOption = (await catalog(true)).find(option => option.id.endsWith('/' + profile.model));
      assert.ok(managedOption, 'opt-in model catalog advertises the configured OpenCode model');
      assert.notEqual(managedOption.isDefault, true, 'managed provider only runs on explicit selection');
      const managedModel = managedOption.id;
      const managed = await create('managed-after-config', managedModel);
      await prompt(managed, 'managed-config');
      await prompt(native, 'native-after-config');
      await prompt(await create('native-with-config'), 'legacy-omitted-model');
      assert.deepEqual(promptLog(), [
        { model: 'native-opencode/fixture-native', carriesFixtureKey: false },
        { model: managedModel, baseUrl: profile.baseUrl, carriesFixtureKey: true },
        { model: 'native-opencode/fixture-native', carriesFixtureKey: false },
        { model: 'native-opencode/fixture-native', carriesFixtureKey: false },
      ]);

      assert.ok(!daemon.output().includes(fixtureKey), 'daemon logs omit the stored API key');
      await daemon.stop();
      await start();
      assert.deepEqual(await ok(route), { version: 1, provider: { ...renamed, hasApiKey: true } });
      assert.ok((await modelIds(true)).includes(managedModel));
      assert.deepEqual(await ok(route, 'DELETE'), { version: 1, provider: null });
      assert.deepEqual(await modelIds(true), ['native-opencode/fixture-native']);
      await prompt(await create('native-after-delete'), 'deleted-config');
      assert.deepEqual(promptLog().at(-1), { model: 'native-opencode/fixture-native', carriesFixtureKey: false });
      assert.equal(fs.readFileSync(nativeConfig, 'utf8'), originalConfig);
      assert.ok(!daemon.output().includes(fixtureKey), 'daemon logs omit the stored API key');
    });
}
