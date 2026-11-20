const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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

function assertProvider(snapshot, expected) {
  assert.equal(snapshot.version, 1);
  const { name, baseUrl, model, hasApiKey, models } = snapshot.provider;
  assert.deepEqual({ name, baseUrl, model, hasApiKey }, { ...expected, hasApiKey: true });
  if (models !== undefined) assert.deepEqual(models, [expected.model]);
}

function runNativeFixture() {
  const fs = require('node:fs');
  const { randomUUID } = require('node:crypto');
  const readline = require('node:readline');
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  const entries = Object.entries(config.provider || {});
  const providers = entries.filter(([id]) => /^keepwork-openai-[0-9a-f]{16}$/.test(id));
  const endpoint = providers[0]?.[1]?.options;
  const modelIds = providers.flatMap(([providerId, provider]) =>
    Object.keys(provider.models).map(id => providerId + '/' + id));
  const defaultModel = config.model || modelIds[0] || 'native-opencode/fixture-native';
  const availableModels = [defaultModel, ...modelIds.filter(id => id !== defaultModel)]
    .map(modelId => ({ modelId, name: modelId }));
  const sessions = new Map();
  const directoryServers = new Map();
  const running = new Map();
  const releaseFile = process.env.KEEPWORK_AGENT_FIXTURE_LOG + '.release';
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
      const servers = directoryServers.get(params.cwd) || new Map();
      directoryServers.set(params.cwd, servers);
      let ownServer;
      for (const server of params.mcpServers) {
        const capability = server.env.find(entry => entry.name === 'KEEPWORK_AICHAT_CAPABILITY')?.value;
        if (!capability) continue;
        // OpenCode registers ACP MCP servers by name for the whole directory
        // in this process. A new registration can replace an earlier one.
        servers.set(server.name, capability);
        ownServer = { name: server.name, capability };
      }
      sessions.set(sessionId, { model: defaultModel, servers, ownServer });
      return reply({ sessionId, models: { currentModelId: defaultModel, availableModels },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } });
    }
    if (method === 'session/set_model') {
      if (!availableModels.some(model => model.modelId === params.modelId)) {
        return send({ id, error: { code: -32602, message: 'Unknown model' } });
      }
      sessions.get(params.sessionId).model = params.modelId;
      return reply({});
    }
    if (method === 'session/prompt') {
      const session = sessions.get(params.sessionId);
      const { ownServer, servers } = session;
      if (servers.size !== Number(Boolean(ownServer)) || (ownServer && servers.get(ownServer.name) !== ownServer.capability)) {
        return send({ id, error: { code: -32603, message: 'OpenCode session exposed another conversation’s tool connection' } });
      }
      fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({
        model: session.model, baseUrl: endpoint?.baseURL,
        carriesFixtureKey: endpoint?.apiKey === '{env:KEEPWORK_OPENCODE_API_KEY}'
          && process.env.KEEPWORK_OPENCODE_API_KEY === 'fixture-opencode-secret-1234',
      }) + '\n');
      const prompt = params.prompt.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const marker = prompt.match(/OPEN_CODE_CONTEXT_([AB])/)?.[0];
      const waiting = prompt.includes('WAIT_FOR_CANCEL') || prompt.includes('WAIT_FOR_RELEASE_FILE');
      send({ method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker || 'Fixture response' } } } });
      if (waiting) {
        const timer = prompt.includes('WAIT_FOR_RELEASE_FILE') ? setInterval(() => {
          if (!fs.existsSync(releaseFile)) return;
          clearInterval(timer);
          running.delete(params.sessionId);
          reply({ stopReason: 'end_turn' });
        }, 20) : undefined;
        running.set(params.sessionId, { reply, timer });
        return;
      }
      return reply({ stopReason: 'end_turn' });
    }
    if (method === 'session/cancel') {
      const pending = running.get(params.sessionId);
      if (pending) {
        clearInterval(pending.timer);
        running.delete(params.sessionId);
        pending.reply({ stopReason: 'cancelled' });
      }
      return;
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
      // The daemon fetches provider catalogs itself, so the fixture stays on
      // loopback and never depends on a public service or browser CORS.
      const discoveryRequests = [];
      const discovery = http.createServer((req, res) => {
        discoveryRequests.push({ path: req.url, authorization: req.headers.authorization || '' });
        const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!String(req.url).endsWith('/models')) return json(404, { error: 'not found' });
        if (String(req.url).startsWith('/auth/')) return json(401, { error: 'unauthorized' });
        if (String(req.url).startsWith('/broken/')) return json(500, { error: 'failed' });
        if (req.headers.authorization !== 'Bearer ' + fixtureKey) return json(401, { error: 'unauthorized' });
        if (String(req.url).startsWith('/empty/')) return json(200, { data: [] });
        return json(200, { data: [
          { id: 'vendor/fixture-model', name: 'Fixture Model' },
          { id: 'vendor/second-model', name: 'Second Model' },
          { id: 'vendor/third-model' },
        ] });
      });
      await new Promise(resolve => discovery.listen(0, '127.0.0.1', resolve));
      const discoveryBase = 'http://127.0.0.1:' + discovery.address().port;
      t.after(() => new Promise(resolve => discovery.close(resolve)));
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
        const headers = { origin: 'https://keepwork.com', 'x-agent-owner': owner, authorization: 'Bearer ' + token, ...extra };
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
      const create = (conversationId, model, options) => ok('/agents/sessions', 'POST', {
        backend: 'opencode', conversationId, roots: [root], model, ...options,
      });
      const startTurn = (session, requestId, options) => ok('/agents/sessions/' + session.id + '/turns', 'POST', {
        requestId, text: 'Ordinary fixture prompt', ...options,
      });
      async function waitTurn(session, requestId, status, hasReply = () => true) {
        const deadline = Date.now() + 5000;
        do {
          const updated = await ok('/agents/sessions/' + session.id);
          assert.ok(!['failed', 'error', 'uncertain'].includes(updated.status), JSON.stringify(updated));
          if (updated.status === status && updated.lastSubmission?.requestId === requestId && hasReply(updated)) return updated;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        assert.fail(`Fixture OpenCode turn ${requestId} did not reach ${status}`);
      }
      async function prompt(session, requestId, options) {
        await startTurn(session, requestId, options);
        return waitTurn(session, requestId, 'completed');
      }
      const register = (side, conversationId = `opencode-context-${side}`) => ok(`/agents/contexts/${conversationId}`, 'POST', {
        pageId: `fixture-page-${side}`, generation: 'fixture-generation', revision: 'fixture-revision',
        instructions: `OPEN_CODE_CONTEXT_${side}`, tools: [],
      });
      const replies = (session) => session.items.filter(item => item.type === 'agentMessage').map(item => item.text);
      const contextOptions = { contextVersion: 1 };
      const promptLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);

      assert.equal(daemon.health.opencodeConfigApi, 'openai-compatible-v1');
      assert.equal(daemon.health.opencodeModelCatalogApi, 'openai-models-v1');
      const empty = await request(route);
      assert.equal(empty.response.status, 200);
      assert.equal(empty.response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(empty.value, { version: 1, provider: null });
      for (const [headers, code] of [[{ origin: 'https://untrusted.example.test' }, 403],
        [{ 'x-agent-owner': undefined }, 400], [{ authorization: undefined }, 401]]) {
        assert.equal((await request(route, 'PATCH', { ...profile, apiKey: fixtureKey }, headers)).response.status, code);
      }
      const noKey = await request('/agents/opencode/models', 'POST', { baseUrl: discoveryBase + '/v1' });
      assert.equal(noKey.response.status, 400);
      assert.equal(noKey.value.code, 'AUTH_REQUIRED', 'discovery reports a missing key as an auth prompt');
      assert.equal((await request('/agents/opencode/models', 'POST', { baseUrl: 'file:///tmp/models' })).response.status, 400);
      assert.equal((await request('/agents/opencode/models', 'POST', { baseUrl: discoveryBase + '/v1', extra: 1 })).response.status, 400);
      assert.equal(discoveryRequests.length, 0, 'invalid discovery requests never reach the provider');
      assert.deepEqual(await modelIds(), ['native-opencode/fixture-native']);
      const native = await create('native-before-config');
      await prompt(native, 'before-config');

      assertProvider(await ok(route, 'PATCH', { ...profile, apiKey: fixtureKey }), profile);
      for (const baseUrl of ['file:///tmp/fixture', 'https://user:password@gateway.example.test/v1']) {
        assert.equal((await request(route, 'PATCH', { ...profile, baseUrl })).response.status, 400);
      }
      const differentEndpoint = { ...profile, baseUrl: 'https://elsewhere.example.test/v1' };
      assert.equal((await request(route, 'PATCH', differentEndpoint)).response.status, 400);
      const renamed = { ...profile, name: 'Renamed Gateway' };
      assertProvider(await ok(route, 'PATCH', renamed), renamed);
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

      await Promise.all(['A', 'B'].map(side => register(side)));
      const [first, second] = await Promise.all(['A', 'B'].map(side =>
        create(`opencode-context-${side}`, managedModel, contextOptions)));
      assert.notEqual(first.threadId, second.threadId);
      assert.deepEqual(first.roots, second.roots);
      assert.equal(first.aichatContext && second.aichatContext, true);

      const [firstDone, secondDone] = await Promise.all([
        prompt(first, 'context-a-first', contextOptions),
        prompt(second, 'context-b-first', contextOptions),
      ]);
      assert.deepEqual(replies(firstDone), ['OPEN_CODE_CONTEXT_A']);
      assert.deepEqual(replies(secondDone), ['OPEN_CODE_CONTEXT_B']);

      await Promise.all([
        startTurn(first, 'context-a-cancel', { ...contextOptions, text: 'WAIT_FOR_CANCEL' }),
        startTurn(second, 'context-b-continue', { ...contextOptions, text: 'WAIT_FOR_RELEASE_FILE' }),
      ]);
      await Promise.all([
        waitTurn(first, 'context-a-cancel', 'running', view => replies(view).length === 2),
        waitTurn(second, 'context-b-continue', 'running', view => replies(view).length === 2),
      ]);
      await ok(`/agents/sessions/${first.id}/interrupt`, 'POST', {});
      await waitTurn(first, 'context-a-cancel', 'interrupted');
      assert.equal((await ok(`/agents/sessions/${second.id}`)).status, 'running');
      fs.writeFileSync(log + '.release', '');
      const completed = await waitTurn(second, 'context-b-continue', 'completed');
      assert.equal(completed.threadId, second.threadId);
      assert.deepEqual(replies(completed), ['OPEN_CODE_CONTEXT_B', 'OPEN_CODE_CONTEXT_B']);

      assert.ok(!daemon.output().includes(fixtureKey), 'daemon logs omit the stored API key');
      await daemon.stop();
      await start();
      assertProvider(await ok(route), renamed);
      assert.ok((await modelIds(true)).includes(managedModel));
      await Promise.all(['A', 'B'].map(side => register(side)));
      const [firstRestored, secondRestored] = await Promise.all([
        prompt(first, 'context-a-restored', contextOptions),
        prompt(second, 'context-b-restored', contextOptions),
      ]);
      assert.equal(firstRestored.threadId, first.threadId);
      assert.equal(secondRestored.threadId, second.threadId);
      assert.equal(replies(firstRestored).at(-1), 'OPEN_CODE_CONTEXT_A');
      assert.equal(replies(secondRestored).at(-1), 'OPEN_CODE_CONTEXT_B');

      // Multiple models per provider stay additive: the first entry remains the
      // legacy `model` while every selection is persisted for newer clients.
      const multiBase = discoveryBase + '/v1';
      const multiModels = ['vendor/fixture-model', 'vendor/second-model'];
      const multi = { name: 'Renamed Gateway', baseUrl: multiBase, models: multiModels };
      assert.deepEqual(await ok(route, 'PATCH', { ...multi, apiKey: fixtureKey }),
        { version: 1, provider: { ...multi, model: multiModels[0], hasApiKey: true } });
      assert.deepEqual(await ok(route), { version: 1, provider: { ...multi, model: multiModels[0], hasApiKey: true } });
      const fetched = await ok('/agents/opencode/models', 'POST', { baseUrl: multiBase });
      assert.deepEqual(fetched, { version: 1, status: 'ok', models: [
        { id: 'vendor/fixture-model', name: 'Fixture Model' },
        { id: 'vendor/second-model', name: 'Second Model' },
        { id: 'vendor/third-model' },
      ] });
      assert.equal(discoveryRequests.at(-1).authorization, 'Bearer ' + fixtureKey,
        'discovery reuses the saved key for the same Base URL');
      assert.deepEqual(await ok('/agents/opencode/models', 'POST', { baseUrl: discoveryBase + '/auth', apiKey: fixtureKey }),
        { version: 1, status: 'auth', models: [], message: 'HTTP 401' });
      assert.deepEqual(await ok('/agents/opencode/models', 'POST', { baseUrl: discoveryBase + '/broken', apiKey: fixtureKey }),
        { version: 1, status: 'error', models: [], message: 'HTTP 500' });
      assert.deepEqual(await ok('/agents/opencode/models', 'POST', { baseUrl: discoveryBase + '/empty', apiKey: fixtureKey }),
        { version: 1, status: 'empty', models: [] });
      const managedIdFor = model => 'keepwork-openai-'
        + createHash('sha256').update(multiBase + '\0' + model).digest('hex').slice(0, 16) + '/' + model;
      const managedIds = multiModels.map(managedIdFor);
      const managedOptions = await catalog(true);
      for (const id of managedIds) {
        const option = managedOptions.find(item => item.id === id);
        assert.ok(option, 'multi-model catalog advertises ' + id);
        assert.notEqual(option.isDefault, true, 'managed provider only runs on explicit selection');
      }
      const secondManaged = managedIds[1];
      await prompt(await create('multi-model-second', secondManaged), 'multi-model-second');
      assert.deepEqual(promptLog().at(-1), { model: secondManaged, baseUrl: multiBase, carriesFixtureKey: true });

      await daemon.stop();
      await start();
      assert.deepEqual(await ok(route), { version: 1, provider: { ...multi, model: multiModels[0], hasApiKey: true } },
        'the extended model list survives a restart');

      // An older daemon only rewrites the v1 file. Its single model must win
      // when the two copies no longer describe the same provider.
      const savedV1 = JSON.parse(fs.readFileSync(path.join(home, '.keepwork-mcp', 'opencode-provider-v1.json'), 'utf8'));
      savedV1.provider.model = 'vendor/third-model';
      fs.writeFileSync(path.join(home, '.keepwork-mcp', 'opencode-provider-v1.json'), JSON.stringify(savedV1));
      await daemon.stop();
      await start();
      assert.deepEqual(await ok(route), { version: 1, provider: {
        ...multi, model: 'vendor/third-model', models: ['vendor/third-model'], hasApiKey: true,
      } });
      assert.deepEqual(await ok(route, 'DELETE'), { version: 1, provider: null });
      assert.deepEqual(await modelIds(true), ['native-opencode/fixture-native']);
      const [defaultA, defaultB] = await Promise.all(['A', 'B'].map(async side => {
        const conversationId = `opencode-default-context-${side}`;
        await register(side, conversationId);
        return create(conversationId, undefined, contextOptions);
      }));
      const [defaultFirst, defaultSecond] = await Promise.all([
        prompt(defaultA, 'default-context-a', contextOptions),
        prompt(defaultB, 'default-context-b', contextOptions),
      ]);
      assert.equal(replies(defaultFirst).at(-1), 'OPEN_CODE_CONTEXT_A');
      assert.equal(replies(defaultSecond).at(-1), 'OPEN_CODE_CONTEXT_B');
      await prompt(await create('native-after-delete'), 'deleted-config');
      assert.deepEqual(promptLog().at(-1), { model: 'native-opencode/fixture-native', carriesFixtureKey: false });
      assert.equal(fs.readFileSync(nativeConfig, 'utf8'), originalConfig);
      assert.ok(!daemon.output().includes(fixtureKey), 'daemon logs omit the stored API key');
    });
}
