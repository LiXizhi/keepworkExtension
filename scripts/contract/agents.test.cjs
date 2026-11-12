const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const h = require('./harness.cjs');

// Real HTTP and real child-process stdio; all provider behavior is an isolated
// ACP fixture. These tests make no claims about provider accounts or live models.
const ownerA = 'a'.repeat(32), ownerB = 'b'.repeat(32);
const fixture = path.join(__dirname, 'fixtures', 'agent-cli.cjs');
let dir, home, root, logFile, port, base, child, exited;

function logRows() {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function prompts() { return logRows().filter((row) => row.method === 'session/prompt'); }
function replayOnLoad(session, options = {}) {
  const file = logFile + '.load-replay.json';
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  settings[session.threadId] = options;
  fs.writeFileSync(file, JSON.stringify(settings));
}
async function registerReplayContext(conversationId, generation) {
  const registered = await request(`/contexts/${conversationId}`, { method: 'POST', body: {
    pageId: 'history-page', generation, instructions: 'Keep conversation history intact.', revision: generation, tools: [],
  } });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
}
function headers(owner = ownerA, extra = {}) {
  return { origin: `http://127.0.0.1:${port}`, 'x-agent-owner': owner, ...extra };
}
async function request(route, { method = 'GET', body, owner = ownerA, extra = {} } = {}) {
  const response = await fetch(base + '/agents' + route, {
    method,
    headers: headers(owner, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await response.json(), headers: response.headers };
}
async function start(engine = 'rust') {
  const absent = path.join(dir, 'does-not-exist');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    KEEPWORK_MCP_PORT: String(port), KEEPWORK_MCP_ROOT: root,
    KEEPWORK_MCP_HOST_KIND: 'standalone', KEEPWORK_AGENT_FIXTURE_LOG: logFile,
    KEEPWORK_WORKBUDDY_PATH: fixture, KEEPWORK_CODEBUDDY_PATH: fixture,
  };
  // Discovery must never fall through to a developer's installed native agents.
  for (const backend of ['CODEX', 'COPILOT', 'CLAUDE', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) {
    env['KEEPWORK_' + backend + '_PATH'] = absent;
  }
  const command = engine === 'node' ? process.execPath : h.rustBinary();
  const args = [...(engine === 'node' ? [path.join(h.repoRoot, 'apps/mcp-runtime/dist/cli.cjs')] : []),
    '--port', String(port), '--root', root];
  child = spawn(command, args, {
    cwd: h.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await h.waitForHealth(port); }
  catch (error) { throw new Error(error.message + '\n' + output); }
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); })]);
  clearTimeout(timer);
  if (!result) { child.kill('SIGKILL'); await exited; }
}
before(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-agent-contract-')));
  home = path.join(dir, 'home'); root = path.join(dir, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(root);
  logFile = path.join(dir, 'fixture.log');
  port = await h.freePort(); base = `http://127.0.0.1:${port}`;
  await start();
});
after(async () => {
  await stop();
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function create(id, overrides = {}, owner = ownerA) {
  const result = await request('/sessions', {
    method: 'POST', owner,
    body: { backend: 'workbuddy', conversationId: id, roots: [root], ...overrides },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}
async function turn(session, id, text, overrides = {}) {
  return request(`/sessions/${session.id}/turns`, { method: 'POST', body: { requestId: id, text, ...overrides } });
}
async function waitSession(session, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    const result = await request(`/sessions/${session.id}`);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    last = result.json;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`Session did not reach expected state: ${JSON.stringify(last)}`);
}
function answerText(session) {
  return session.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join('');
}

test('Rust advertises native agent APIs and executable inventory never starts providers', async () => {
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.runtimeEngine, 'rust');
  assert.equal(health.agentSessionApi, 'v1');
  assert.equal(health.agentInventoryApi, 'v1');
  const result = await request('/backends?probe=executable');
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.workbuddy.available, true);
  assert.equal(result.json.workbuddy.probe, 'executable');
  assert.equal(result.json.workbuddy.authenticated, null);
  assert.equal(result.json.workbuddy.cli.path, fixture);
  assert.deepEqual(result.json.workbuddy.models, []);
  assert.equal(logRows().length, 0, 'inventory must not execute --version, login, protocol or model probes');
});

test('targeted WorkBuddy status discovers ACP models without claiming account verification', async () => {
  const result = await request('/backends?backend=workbuddy&cwd=' + encodeURIComponent(root) + '&conversationId=catalog');
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.deepEqual(Object.keys(result.json), ['workbuddy']);
  const backend = result.json.workbuddy;
  assert.equal(backend.available, true, JSON.stringify(backend));
  assert.equal(backend.protocol, 'acp');
  assert.equal(backend.authenticated, null, 'ACP initialization and models do not verify an account');
  assert.equal(backend.authState, 'unknown');
  assert.equal(backend.models.some((model) => model.id === 'fixture-model'), true);
  assert.equal(backend.models.some((model) => model.id === 'fixture-other'), true);
});

test('agents enforce explicit Origin, valid owner keys, and origin-scoped session ownership', async () => {
  const noOrigin = await fetch(base + '/agents/sessions', { headers: { 'x-agent-owner': ownerA } });
  assert.equal(noOrigin.status, 403);
  assert.equal((await request('/sessions', { extra: { origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await request('/sessions', { owner: 'short' })).status, 400);
  const session = await create('owner-session');
  for (const key of ['id', 'threadId', 'conversationId', 'backend', 'title', 'roots', 'status', 'cursor', 'items', 'pending']) {
    assert.ok(Object.hasOwn(session, key), `snapshot needs ${key}`);
  }
  assert.equal(session.owner, undefined);
  assert.equal(session.submissions, undefined);
  assert.equal(session.lastSubmission, null);
  assert.deepEqual(session.items, []);
  assert.deepEqual(session.pending, []);
  const other = await request(`/sessions/${session.id}`, { owner: ownerB });
  assert.notEqual(other.status, 200);
  assert.doesNotMatch(JSON.stringify(other.json), new RegExp(session.threadId));
  const otherModels = await request(`/backends?backend=workbuddy&sessionId=${session.id}`, { owner: ownerB });
  assert.notEqual(otherModels.status, 200, 'model discovery cannot access or reconfigure another owner session');
  const stolenEvents = await fetch(`${base}/agents/sessions/${session.id}/events`, { headers: headers(ownerB) });
  assert.notEqual(stolenEvents.status, 200, 'session streams enforce the same owner boundary as reads');
  await stolenEvents.body?.cancel();
  const differentOrigin = await request(`/sessions/${session.id}`, { extra: { origin: 'http://localhost:3000' } });
  assert.notEqual(differentOrigin.status, 200);
  const listed = await request('/sessions', { owner: ownerB });
  assert.deepEqual(listed.json.sessions, []);
  const ownAgain = await create('owner-session');
  assert.equal(ownAgain.id, session.id);
});

test('native agent routes keep daemon auth while the private tool proxy requires its own capability', async () => {
  const secured = await h.startRust({ requireAuth: true, env: { KEEPWORK_WORKBUDDY_PATH: fixture, KEEPWORK_MCP_ROOT: root } });
  try {
    const origin = `http://127.0.0.1:${secured.port}`;
    const denied = await fetch(secured.base + '/agents/backends?probe=executable', {
      headers: { origin, 'x-agent-owner': ownerA },
    });
    assert.equal(denied.status, 401);
    const token = fs.readFileSync(path.join(secured.home, '.keepwork-mcp', 'token'), 'utf8').trim();
    const allowed = await fetch(secured.base + '/agents/backends?probe=executable', {
      headers: { origin, 'x-agent-owner': ownerA, authorization: 'Bearer ' + token },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).workbuddy.available, true);
    const noCapability = await fetch(secured.base + '/agents/tool-proxy', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ method: 'tools/list' }),
    });
    assert.equal(noCapability.status, 403, 'daemon credentials are not a conversation capability');
  } finally { await secured.stop(); }
});

test('session creation validates roots and rejects unsupported execution semantics before spawning', async () => {
  const count = prompts().length;
  for (const roots of [['relative'], [], [path.join(dir, 'missing')]]) {
    const bad = await request('/sessions', { method: 'POST', body: { backend: 'workbuddy', conversationId: 'bad-root', roots } });
    assert.notEqual(bad.status, 200, JSON.stringify(bad.json));
  }
  const unsupported = await request('/sessions', {
    method: 'POST', body: { backend: 'claude', conversationId: 'unsupported-protocol', roots: [root] },
  });
  assert.notEqual(unsupported.status, 200);
  assert.match(JSON.stringify(unsupported.json), /unsupported|not implemented|not available|not found|尚未|不支持/i);
  assert.equal(prompts().length, count);
});

test('reusing a conversation cannot silently change context, roots, or mode', async () => {
  const conversationId = 'create-semantics';
  const existing = await create(conversationId);
  const registration = await request(`/contexts/${conversationId}`, { method: 'POST', body: {
    pageId: 'semantics-page', generation: 'semantics-generation', instructions: 'New context cannot upgrade an old session.',
    revision: 'semantics-rev', tools: [],
  } });
  assert.equal(registration.status, 200, JSON.stringify(registration.json));
  const differentRoot = path.join(root, 'different-root'); fs.mkdirSync(differentRoot);
  const count = logRows().filter((row) => row.method === 'session/new').length;
  for (const overrides of [{ contextVersion: 2 }, { contextVersion: 1 }, { roots: [differentRoot] }, { mode: 'ask' }]) {
    const response = await request('/sessions', { method: 'POST', body: {
      backend: 'workbuddy', conversationId, roots: [root], ...overrides,
    } });
    assert.notEqual(response.status, 200, `requested semantics must not be ignored: ${JSON.stringify(overrides)}`);
  }
  assert.equal(logRows().filter((row) => row.method === 'session/new').length, count);
  assert.equal((await create(conversationId)).id, existing.id, 'unchanged legacy create remains idempotent');
});

test('cloudPrimary requires an actual boolean and an explicitly registered context contract', async () => {
  const count = logRows().filter((row) => row.method === 'session/new').length;
  let sequence = 0;
  for (const cloudPrimary of [true, 'false', 0, null, {}]) {
    const response = await request('/sessions', { method: 'POST', body: {
      backend: 'workbuddy', conversationId: 'invalid-cloud-' + sequence++, roots: [root], cloudPrimary,
    } });
    assert.notEqual(response.status, 200, JSON.stringify({ cloudPrimary, response: response.json }));
  }
  assert.equal(logRows().filter((row) => row.method === 'session/new').length, count,
    'invalid execution semantics must be rejected before creating a native session');
  const conversationId = 'cloud-primary-context';
  const registered = await request(`/contexts/${conversationId}`, { method: 'POST', body: {
    pageId: 'cloud-page', generation: 'cloud-generation', instructions: 'CLOUD_PROJECT_CONTEXT',
    revision: 'cloud-rev', tools: [],
  } });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const cloud = await create(conversationId, { roots: [], contextVersion: 1, cloudPrimary: true });
  assert.equal(cloud.aichatContext, true);
  const relative = path.relative(fs.realpathSync(home), fs.realpathSync(cloud.roots[0]));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'cloud contexts use a confined temporary native cwd rather than a fake local project root');
  const sent = await turn(cloud, 'cloud-context-1', 'answer through cloud context', { contextVersion: 1, model: '', effort: '' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await waitSession(cloud, (snapshot) => snapshot.status === 'completed');
  const cloudPrompt = prompts().find((row) => row.params.sessionId === cloud.threadId);
  assert.match(JSON.stringify(cloudPrompt.params.prompt), /CLOUD_PROJECT_CONTEXT/);
});

test('AIChat context is required when requested and stays bound to its conversation and owner', async () => {
  const conversationId = 'context-session';
  const unregistered = await request('/sessions', {
    method: 'POST', body: { backend: 'workbuddy', conversationId, roots: [root], contextVersion: 1 },
  });
  assert.notEqual(unregistered.status, 200, 'contextVersion cannot be silently ignored');
  const registered = await request(`/contexts/${conversationId}`, {
    method: 'POST', body: {
      pageId: 'fixture-page', generation: 'fixture-generation',
      instructions: 'CONTEXT_ONLY_FOR_THIS_SESSION', revision: 'fixture-rev', tools: [],
    },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  assert.equal(registered.json.version, 1);
  const session = await create(conversationId, { contextVersion: 1 });
  assert.equal(session.aichatContext, true);
  assert.equal(session.context.version, 1);
  // Current AIChat explicitly sends empty selections, which retain the native
  // defaults and must not be interpreted as a requested reasoning setting.
  const submitted = await turn(session, 'context-1', 'context user text', { contextVersion: 1, model: '', effort: '' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  await waitSession(session, (view) => view.status === 'completed');
  const contextPrompt = prompts().find((row) => row.params.sessionId === session.threadId);
  assert.ok(contextPrompt);
  const promptText = contextPrompt.params.prompt.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(promptText, /CONTEXT_ONLY_FOR_THIS_SESSION/);
  assert.match(promptText, /context user text/);
  const other = await request('/sessions', {
    method: 'POST', owner: ownerB,
    body: { backend: 'workbuddy', conversationId, roots: [root], contextVersion: 1 },
  });
  assert.notEqual(other.status, 200, 'context registration must not leak across owners');
  const legacy = await create('legacy-no-context');
  const upgraded = await turn(legacy, 'legacy-context-1', 'must not ignore requested tools', { contextVersion: 1 });
  assert.notEqual(upgraded.status, 200);
});

test('real workspace registration preserves Git drafts while local file operations stay confined', async () => {
  const conversationId = 'workspace-grants';
  const route = `/contexts/${conversationId}`;
  const registered = await request(route, { method: 'POST', body: {
    pageId: 'workspace-page', generation: 'workspace-generation', instructions: 'Use authorized workspaces.',
    revision: 'workspace-rev', tools: [],
  } });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const credentials = {
    username: 'fixture-user', token: 'fixture-cloud-secret', git: { 'github.com': 'fixture-git-secret' },
    baseURL: 'https://api.keepwork.com/core/v0', primaryId: 'local-space', spaces: [
      { id: 'local-space', type: 'local', root, aliases: ['local-space', '.brain'] },
      { id: 'git-space', type: 'git', aliases: ['git-space'], host: 'github.com', owner: 'fixture', repo: 'fixture', branch: 'main' },
    ],
  };
  const granted = await request(route + '/credentials', { method: 'POST', body: credentials });
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  // This import is mandatory in the current AIChat page, even when the primary
  // workspace is local. Never acknowledge it without retaining the real draft.
  const draft = { content: 'UNCOMMITTED_BROWSER_DRAFT', updatedAt: 123, baseHash: 'fixture-base' };
  const imported = await request(route + '/overlay', { method: 'POST', body: {
    operation: 'import', spaceId: 'git-space', files: { 'draft.md': draft },
  } });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.files['draft.md'].content, draft.content);
  const conflict = await request(route + '/overlay', { method: 'POST', body: {
    operation: 'import', spaceId: 'git-space', files: { 'draft.md': { ...draft, content: 'conflicting draft' } },
  } });
  assert.notEqual(conflict.status, 200);
  const preserved = await request(route + '/overlay', { method: 'POST', body: { operation: 'get', spaceId: 'git-space' } });
  assert.equal(preserved.json.files['draft.md'].content, draft.content);
  const remote = await request(route + '/file', { method: 'POST', body: { operation: 'read', path: '//git-space/remote.md' } });
  assert.notEqual(remote.status, 200, 'remote execution must not be falsely claimed');
  assert.match(JSON.stringify(remote.json), /UNSUPPORTED|unavailable|不支持/i);
  const session = await create(conversationId, { contextVersion: 1 });
  assert.doesNotMatch(JSON.stringify(session), /fixture-cloud-secret|fixture-git-secret/);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'original local text');
  const read = await request(route + '/file', { method: 'POST', body: { operation: 'read', path: '//local-space/notes.txt' } });
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.content, 'original local text');
  const traversal = await request(route + '/file', { method: 'POST', body: { operation: 'read', path: '//local-space/../fixture.log' } });
  assert.notEqual(traversal.status, 200);
  const stale = await request(route + '/file', { method: 'POST', body: {
    operation: 'write', path: '//local-space/notes.txt', content: 'must not overwrite', expectedContent: 'stale text',
  } });
  assert.notEqual(stale.status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'original local text');
  const write = await request(route + '/file', { method: 'POST', body: {
    operation: 'write', path: '//local-space/notes.txt', content: 'authorized edit', expectedContent: 'original local text',
  } });
  assert.equal(write.status, 200, JSON.stringify(write.json));
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'authorized edit');
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside grant');
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'escape-link'));
    const escape = await request(route + '/file', { method: 'POST', body: { operation: 'read', path: '//local-space/escape-link' } });
    assert.notEqual(escape.status, 200);
  }
});

test('native ACP invokes the capability-scoped MCP proxy and receives only its bound web tool result', async () => {
  const conversationId = 'context-tool-session';
  const registered = await request(`/contexts/${conversationId}`, {
    method: 'POST', body: {
      pageId: 'tool-page', generation: 'tool-generation', instructions: 'Use the conversation tool.', revision: 'tool-rev',
      tools: [{ name: 'fixture_echo', description: 'Echo test input', inputSchema: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
      } }],
    },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const session = await create(conversationId, { contextVersion: 1 });
  const abort = new AbortController();
  const response = await fetch(`${base}/agents/contexts/${conversationId}/events?pageId=tool-page&generation=tool-generation`, {
    headers: headers(), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  async function nextEvent(name) {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.includes('event: ' + name + '\n')) {
          return JSON.parse(frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'));
        }
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'tool stream should stay connected');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  try {
    await nextEvent('ready');
    const submitted = await turn(session, 'webtool-1', 'FIXTURE_CONTEXT_TOOL', { contextVersion: 1 });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
    const call = await nextEvent('tool');
    assert.equal(call.name, 'fixture_echo');
    assert.deepEqual(call.arguments, { text: 'bridge test' });
    assert.equal(call.pageId, 'tool-page');
    assert.equal(call.generation, 'tool-generation');
    const stolen = await request(`/contexts/${conversationId}/result`, {
      method: 'POST', owner: ownerB, body: { ...call, result: { content: [{ type: 'text', text: 'stolen' }] } },
    });
    assert.notEqual(stolen.status, 200);
    const answered = await request(`/contexts/${conversationId}/result`, {
      method: 'POST', body: { callId: call.callId, pageId: call.pageId, generation: call.generation,
        result: { content: [{ type: 'text', text: 'WEB_TOOL_REAL_RESULT' }] } },
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.json));
    const done = await waitSession(session, (view) => view.status === 'completed');
    assert.match(answerText(done), /WEB_TOOL_REAL_RESULT/);
    assert.doesNotMatch(answerText(done), /stolen|context-error/);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test('rebinding the webpage restores tools on the same native session without replaying previous work', async () => {
  const conversationId = 'rebind-context-tool';
  const register = async (pageId, generation) => {
    const result = await request(`/contexts/${conversationId}`, { method: 'POST', body: {
      pageId, generation, instructions: 'Use the bound conversation tool.', revision: generation,
      tools: [{ name: 'fixture_echo', description: 'Echo test input', inputSchema: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
      } }],
    } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
  };
  const run = async (session, pageId, generation, requestId, expected) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/agents/contexts/${conversationId}/events?pageId=${pageId}&generation=${generation}`, {
      headers: headers(), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    const next = async (name) => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (frame.startsWith('event: ' + name + '\n')) {
            return JSON.parse(frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'));
          }
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      await next('ready');
      const sent = await turn(session, requestId, 'FIXTURE_CONTEXT_TOOL', { contextVersion: 1, model: '', effort: '' });
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      const call = await next('tool');
      assert.equal(call.pageId, pageId); assert.equal(call.generation, generation);
      const replied = await request(`/contexts/${conversationId}/result`, { method: 'POST', body: {
        callId: call.callId, pageId, generation, result: { content: [{ type: 'text', text: expected }] },
      } });
      assert.equal(replied.status, 200, JSON.stringify(replied.json));
      const complete = await waitSession(session, (snapshot) => snapshot.status === 'completed');
      assert.match(answerText(complete), new RegExp(expected));
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  };
  await register('rebind-page-a', 'rebind-generation-a');
  const initialLogSize = logRows().length;
  const session = await create(conversationId, { contextVersion: 1 });
  const descriptorA = logRows().slice(initialLogSize).find((row) => row.method === 'session/new')?.params.mcpServers[0];
  await run(session, 'rebind-page-a', 'rebind-generation-a', 'rebind-1', 'FIRST_PAGE_RESULT');
  await waitSession(session, (snapshot) => snapshot.context?.online === false);
  const newCalls = logRows().filter((row) => row.method === 'session/new').length;
  await register('rebind-page-b', 'rebind-generation-b');
  await run(session, 'rebind-page-b', 'rebind-generation-b', 'rebind-2', 'SECOND_PAGE_RESULT');
  assert.equal(logRows().filter((row) => row.method === 'session/new').length, newCalls,
    'reconnecting the page must retain the native session identity');
  const reloaded = logRows().filter((row) => row.method === 'session/load' && row.params.sessionId === session.threadId).at(-1);
  assert.ok(reloaded, 'a live native process must reload the session when its tool capability changes');
  const capability = (descriptor) => descriptor?.env.find((entry) => entry.name === 'KEEPWORK_AICHAT_CAPABILITY')?.value;
  assert.ok(capability(descriptorA));
  assert.notEqual(capability(reloaded.params.mcpServers[0]), capability(descriptorA));
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, 2,
    'only the two explicit requests may execute across a page reconnect');
});

test('ACP session/load history is isolated during page rebinding while another session stays live', async () => {
  const conversationId = 'history-rebind';
  await registerReplayContext(conversationId, 'history-generation-a');
  const session = await create(conversationId, { contextVersion: 1, mode: 'craft' });
  assert.equal((await turn(session, 'history-rebind-1', 'First question')).status, 200);
  const first = await waitSession(session, (view) => view.status === 'completed');
  const peer = await create('history-rebind-peer', { mode: 'ask' });
  assert.equal((await turn(peer, 'history-peer-1', 'FIXTURE_SLOW')).status, 200);
  await waitSession(peer, (view) => answerText(view).includes('中文 fixture'));
  replayOnLoad(session, { permission: true, metadata: true, peerSessionId: peer.threadId });
  await registerReplayContext(conversationId, 'history-generation-b');
  try {
    const sent = await turn(session, 'history-rebind-2', 'List the top-level project files');
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const complete = await waitSession(session, (view) => view.status === 'completed');
    assert.deepEqual(complete.items.slice(0, first.items.length), first.items, 'restoring native history must preserve the first turn');
    assert.doesNotMatch(JSON.stringify(complete.items), /HISTORY_/, 'load replay must never enter a live turn');
    assert.deepEqual(complete.items.filter((item) => item.type === 'agentMessage').map((item) => item.text),
      ['中文 fixture answer', '中文 fixture answer']);
    assert.equal(complete.items.filter((item) => item.type === 'userMessage').length, 2);
    assert.deepEqual(complete.pending, [], 'historical permissions cannot become current approval prompts');
    const response = logRows().find((row) => row.id === 'history-permission-' + session.threadId && !row.method);
    assert.ok(response, 'history permission requests must receive a bounded rejection');
    assert.ok(response.error || response.result?.outcome?.outcome === 'cancelled', 'history permissions cannot be approved');
    const backend = await request(`/backends?backend=workbuddy&sessionId=${session.id}`);
    assert.equal(backend.status, 200, JSON.stringify(backend.json));
    assert.ok(backend.json.workbuddy.models.some((model) => model.id === 'restored-model'),
      'configuration notifications survive a load reply without optional metadata');
    assert.ok(logRows().some((row) => row.method === 'session/set_mode'
      && row.params.sessionId === session.threadId && row.params.modeId === 'default'),
    'the replayed native plan mode is reconciled with the requested Craft mode');
    const peerView = await waitSession(peer, (view) => answerText(view).includes('LIVE_DURING_RESTORE'));
    assert.equal(peerView.status, 'running', 'a load guard belongs only to its own session');
    const promptCount = prompts().filter((row) => row.params.sessionId === session.threadId).length;
    assert.equal(promptCount, 2);
    assert.equal((await turn(session, 'history-rebind-2', 'Do not repeat this request')).status, 200);
    assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, promptCount);
  } finally {
    await request(`/sessions/${peer.id}/interrupt`, { method: 'POST', body: {} });
    await waitSession(peer, (view) => view.status === 'interrupted');
  }
});

test('ACP session/load failure preserves saved turns and a later explicit request can recover', async () => {
  const conversationId = 'history-load-failure';
  await registerReplayContext(conversationId, 'failure-generation-a');
  const session = await create(conversationId, { contextVersion: 1, mode: 'ask' });
  assert.equal((await turn(session, 'history-failure-1', 'First question')).status, 200);
  const first = await waitSession(session, (view) => view.status === 'completed');
  const count = prompts().filter((row) => row.params.sessionId === session.threadId).length;
  replayOnLoad(session, { fail: true });
  await registerReplayContext(conversationId, 'failure-generation-b');
  const rejected = await turn(session, 'history-failure-2', 'Must not dispatch if restore fails');
  assert.notEqual(rejected.status, 200);
  assert.match(rejected.json.error, /history load failed/);
  const failed = await request(`/sessions/${session.id}`);
  assert.equal(failed.status, 200, JSON.stringify(failed.json));
  assert.deepEqual(failed.json.items, first.items, 'failed restore cannot append any historical output');
  assert.equal(failed.json.lastSubmission.state, 'rejected');
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, count);
  replayOnLoad(session);
  const recovered = await turn(session, 'history-failure-3', 'A new explicit request after restoring the connection');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  const complete = await waitSession(session, (view) => view.status === 'completed');
  assert.doesNotMatch(JSON.stringify(complete.items), /HISTORY_/);
  assert.deepEqual(complete.items.slice(0, first.items.length), first.items);
  assert.equal(complete.items.filter((item) => item.type === 'userMessage').length, 2);
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, count + 1);
});

test('ACP session/load after daemon restart preserves history without adding replayed messages', async () => {
  const session = await create('history-daemon-restart', { mode: 'ask' });
  assert.equal((await turn(session, 'history-restart-1', 'First question')).status, 200);
  const first = await waitSession(session, (view) => view.status === 'completed');
  replayOnLoad(session);
  const count = prompts().filter((row) => row.params.sessionId === session.threadId).length;
  await stop(); await start();
  const read = await request(`/sessions/${session.id}`);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.deepEqual(read.json.items, first.items, 'reading persisted history cannot start or replay native work');
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, count);
  const sent = await turn(session, 'history-restart-2', 'Continue after restart');
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const complete = await waitSession(session, (view) => view.status === 'completed');
  assert.equal(complete.threadId, session.threadId);
  assert.deepEqual(complete.items.slice(0, first.items.length), first.items);
  assert.doesNotMatch(JSON.stringify(complete.items), /HISTORY_/);
  assert.equal(complete.items.filter((item) => item.type === 'userMessage').length, 2);
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, count + 1);
  assert.equal((await turn(session, 'history-restart-1', 'Do not repeat the first question')).status, 200);
  assert.equal(prompts().filter((row) => row.params.sessionId === session.threadId).length, count + 1);
});

test('send streams Node-compatible NDJSON snapshots and reconnect never resubmits a prompt', async () => {
  const session = await create('streaming', { model: 'fixture-other' });
  const abort = new AbortController();
  const stream = await fetch(`${base}/agents/sessions/${session.id}/events?cursor=0`, {
    headers: headers(), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /application\/x-ndjson/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  async function next() {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) return JSON.parse(line);
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'stream should remain available');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  try {
    const initial = await next();
    assert.equal(initial.session.id, session.id);
    assert.equal(initial.cursor, initial.session.cursor);
    const result = await turn(session, 'stream-1', 'hello fixture');
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.session.id, session.id);
    let completed, lastCursor = initial.cursor;
    for (let i = 0; i < 30; i++) {
      const event = await next();
      assert.ok(event.cursor >= lastCursor);
      lastCursor = event.cursor;
      if (event.session.status === 'completed') { completed = event.session; break; }
    }
    assert.ok(completed, 'completion snapshot should arrive without polling or Stop');
    assert.equal(answerText(completed), '中文 fixture answer');
    assert.equal(completed.items.some((item) => item.type === 'userMessage'), true);
    assert.equal(completed.model, 'fixture-other');
    assert.equal(completed.lastSubmission.requestId, 'stream-1');
    assert.equal(completed.lastSubmission.state, 'accepted');
    const count = prompts().length;
    const duplicate = await turn(session, 'stream-1', 'changed text must not replay');
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
    assert.equal(prompts().length, count);
    assert.equal((await request(`/sessions/${session.id}`)).json.status, 'completed');
    assert.equal(prompts().length, count);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});

test('concurrent creations and duplicate turn IDs submit once; other sessions continue independently', async () => {
  const created = await Promise.all([create('concurrent-create'), create('concurrent-create')]);
  assert.equal(created[0].id, created[1].id);
  const a = created[0], b = await create('parallel-session');
  const beforeCount = prompts().length;
  const same = await Promise.all([turn(a, 'concurrent-1', 'FIXTURE_SLOW'), turn(a, 'concurrent-1', 'FIXTURE_SLOW')]);
  for (const result of same) assert.equal(result.status, 200, JSON.stringify(result.json));
  await waitSession(a, (view) => answerText(view).includes('中文 fixture'));
  assert.equal(prompts().length, beforeCount + 1);
  const busy = await turn(a, 'concurrent-2', 'must not dispatch');
  assert.notEqual(busy.status, 200);
  assert.equal(prompts().length, beforeCount + 1);
  const parallel = await turn(b, 'parallel-1', 'hello independently');
  assert.equal(parallel.status, 200, JSON.stringify(parallel.json));
  await waitSession(b, (view) => view.status === 'completed');
  const interrupted = await request(`/sessions/${a.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(interrupted.status, 200, JSON.stringify(interrupted.json));
  await waitSession(a, (view) => view.status === 'interrupted');
  assert.equal((await request(`/sessions/${b.id}`)).json.status, 'completed');
});

test('receipt reconciliation uses submission order rather than request ID sorting', async () => {
  const session = await create('receipt-order');
  assert.equal((await turn(session, 'z-first', 'first request')).status, 200);
  await waitSession(session, (view) => view.status === 'completed');
  assert.equal((await turn(session, 'a-second', 'second request')).status, 200);
  const done = await waitSession(session, (view) => view.status === 'completed');
  assert.equal(done.lastSubmission.requestId, 'a-second');
  const duplicate = await turn(session, 'z-first', 'duplicate older request');
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(duplicate.json.session.lastSubmission.requestId, 'a-second');
});

test('unsupported reasoning effort and image semantics fail before native prompt submission', async () => {
  const session = await create('unsupported-input');
  const count = prompts().length;
  const effort = await turn(session, 'unsupported-effort', 'must not use a different reasoning setting', { effort: 'high' });
  assert.notEqual(effort.status, 200);
  assert.equal(prompts().length, count);
  const image = await turn(session, 'unsupported-image', 'must not silently drop an image', {
    images: ['data:image/png;base64,aGVsbG8='],
  });
  assert.notEqual(image.status, 200);
  assert.equal(prompts().length, count);
});

test('non-string model and effort inputs are rejected before native execution', async () => {
  const session = await create('invalid-model-inputs', { model: 'fixture-other' });
  const count = prompts().length;
  let sequence = 0;
  for (const options of [{ model: 77 }, { effort: 77 }, { model: [] }, { effort: false }, { model: {} }]) {
    const response = await turn(session, 'bad-option-' + sequence++, 'must not dispatch malformed settings', options);
    assert.notEqual(response.status, 200, JSON.stringify({ options, response: response.json }));
  }
  assert.equal(prompts().length, count);
  const view = await request(`/sessions/${session.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.items.length, 0);
  assert.ok(!['starting', 'running', 'waiting', 'uncertain'].includes(view.json.status));
  for (const options of [{ model: null, effort: null }, { model: '', effort: '' }]) {
    const defaults = await turn(session, 'legacy-default-' + sequence++, 'retain native defaults', options);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    const complete = await waitSession(session, (snapshot) => snapshot.status === 'completed');
    assert.equal(complete.model, 'fixture-other', 'unset selections must not misreport the actual native model');
  }
  assert.equal(prompts().length, count + 2, 'legacy empty and nullable selections each submit exactly once');
});

test('scoped active model discovery never reconfigures a running native session', async () => {
  const session = await create('active-model-discovery', { model: 'fixture-model' });
  assert.equal((await turn(session, 'active-model-1', 'FIXTURE_SLOW')).status, 200);
  await waitSession(session, (view) => answerText(view).includes('中文 fixture'));
  const modelChanges = logRows().filter((row) => row.method === 'session/set_model').length;
  const queried = await request(`/backends?backend=workbuddy&sessionId=${session.id}&model=fixture-other&refresh=1`);
  assert.equal(queried.status, 200, JSON.stringify(queried.json));
  assert.equal(queried.json.workbuddy.models.find((model) => model.isDefault)?.id, 'fixture-model');
  assert.equal(logRows().filter((row) => row.method === 'session/set_model').length, modelChanges);
  const mismatch = await request(`/backends?backend=codebuddy&sessionId=${session.id}`);
  assert.notEqual(mismatch.status, 200);
  assert.equal((await request(`/sessions/${session.id}`)).json.model, 'fixture-model');
  assert.equal((await request(`/sessions/${session.id}/interrupt`, { method: 'POST', body: {} })).status, 200);
  await waitSession(session, (view) => view.status === 'interrupted');
});

test('Stop during native configuration reports a retryable state without falsely claiming cancellation', async () => {
  const session = await create('stop-before-prompt', { model: 'fixture-model' });
  const count = prompts().length;
  const sending = turn(session, 'stop-starting-1', 'FIXTURE_SLOW', { model: 'fixture-delayed' });
  const deadline = Date.now() + 3000;
  while (!logRows().some((row) => row.method === 'session/set_model'
    && row.params.sessionId === session.threadId && row.params.modelId === 'fixture-delayed')) {
    assert.ok(Date.now() < deadline, 'fixture must enter delayed native configuration');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const stopped = await request(`/sessions/${session.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(stopped.status, 400, JSON.stringify(stopped.json));
  assert.match(stopped.json.error, /starting.*retry|retry.*starting/i);
  assert.equal(stopped.json.acceptanceUnknown, false);
  const sent = await sending;
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await waitSession(session, (snapshot) => snapshot.status === 'running' && answerText(snapshot).includes('中文 fixture'));
  assert.equal(prompts().length, count + 1, 'rejected Stop cannot silently duplicate or cancel the original submission');
  const retry = await request(`/sessions/${session.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  const view = await waitSession(session, (snapshot) => snapshot.status === 'interrupted');
  assert.equal(view.items.filter((item) => item.type === 'userMessage').length, 1);
  assert.equal(view.lastSubmission.state, 'accepted');
});

test('manual ACP permission stays pending until its owner answers and cannot be answered twice', async () => {
  const session = await create('permissions', { mode: 'ask' });
  const result = await turn(session, 'permission-1', 'FIXTURE_PERMISSION', { mode: 'ask' });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const waiting = await waitSession(session, (view) => view.status === 'waiting');
  assert.equal(waiting.pending.length, 1);
  const approval = waiting.pending[0];
  assert.ok(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(approval.method));
  const stranger = await request(`/sessions/${session.id}/respond`, {
    method: 'POST', owner: ownerB, body: { id: approval.id, decision: 'accept' },
  });
  assert.notEqual(stranger.status, 200);
  assert.equal((await request(`/sessions/${session.id}`)).json.pending.length, 1);
  const answered = await request(`/sessions/${session.id}/respond`, {
    method: 'POST', body: { id: approval.id, decision: 'decline' },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  const complete = await waitSession(session, (view) => view.status === 'completed');
  assert.equal(answerText(complete), 'permission:denied');
  assert.deepEqual(complete.pending, []);
  const duplicate = await request(`/sessions/${session.id}/respond`, {
    method: 'POST', body: { id: approval.id, decision: 'accept' },
  });
  assert.notEqual(duplicate.status, 200);
});

test('explicit Craft mode approves supported tool permissions without leaving stale prompts', async () => {
  const session = await create('craft-permission', { mode: 'craft' });
  const result = await turn(session, 'craft-permission-1', 'FIXTURE_PERMISSION', { mode: 'craft' });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const complete = await waitSession(session, (view) => view.status === 'completed');
  assert.equal(answerText(complete), 'permission:allowed');
  assert.deepEqual(complete.pending, []);
});

test('archiving and local removal preserve history while preventing new execution', async () => {
  const session = await create('archiving');
  assert.equal((await turn(session, 'archive-1', 'keep this answer')).status, 200);
  await waitSession(session, (view) => view.status === 'completed');
  const archive = await request(`/sessions/${session.id}`, {
    method: 'PATCH', body: { archived: true, title: 'Archived fixture' },
  });
  assert.equal(archive.status, 200, JSON.stringify(archive.json));
  assert.equal(archive.json.archived, true);
  assert.equal(answerText(archive.json), '中文 fixture answer');
  const count = prompts().length;
  assert.notEqual((await turn(session, 'archive-2', 'must not execute')).status, 200);
  assert.equal(prompts().length, count);
  const removed = await request(`/sessions/${session.id}`, { method: 'PATCH', body: { remove: true } });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const listed = await request('/sessions');
  assert.equal(listed.json.sessions.some((row) => row.id === session.id), false);
  assert.notEqual((await request(`/sessions/${session.id}`)).status, 200);
  assert.equal(logRows().some((row) => /delete|remove/.test(row.method || '')), false,
    'local removal must never call a native provider deletion method');
});

test('provider failure is bounded and ordinary MCP operations still work', async () => {
  const session = await create('provider-exit');
  const accepted = await turn(session, 'exit-1', 'FIXTURE_EXIT');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  const failed = await waitSession(session, (view) => ['failed', 'error', 'interrupted', 'uncertain'].includes(view.status));
  assert.ok(failed.error || failed.status === 'interrupted');
  assert.equal((await fetch(base + '/health')).status, 200);
  const exists = await (await fetch(base + '/exists?path=' + encodeURIComponent(root))).json();
  assert.equal(exists.exists, true);
});

test('daemon restart preserves session identity and receipts without replaying uncertain work', async () => {
  const completedSession = await create('completed-before-restart');
  assert.equal((await turn(completedSession, 'completed-restart-1', 'answer before restart')).status, 200);
  await waitSession(completedSession, (view) => view.status === 'completed');
  const session = await create('restart-persistence');
  const accepted = await turn(session, 'restart-1', 'FIXTURE_SLOW');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  await waitSession(session, (view) => answerText(view).includes('中文 fixture'));
  const count = prompts().length;
  await stop(); await start();
  const resumed = await request(`/sessions/${session.id}`);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  assert.equal(resumed.json.id, session.id);
  assert.equal(resumed.json.threadId, session.threadId);
  assert.ok(['interrupted', 'uncertain'].includes(resumed.json.status), resumed.json.status);
  assert.equal(resumed.json.lastSubmission.requestId, 'restart-1');
  assert.equal(prompts().length, count, 'reading persisted state cannot replay a prompt');
  const completed = await request(`/sessions/${completedSession.id}`);
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  assert.equal(completed.json.status, 'completed');
  assert.equal(answerText(completed.json), '中文 fixture answer', 'completed history survives daemon restart');
  assert.equal(prompts().length, count, 'recovering completed history cannot execute a new provider turn');
  const duplicate = await turn(session, 'restart-1', 'changed after reconnect');
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(prompts().length, count, 'persisted request IDs prevent automatic duplicate mutations');
  assert.notEqual((await request(`/sessions/${session.id}`, { owner: ownerB })).status, 200);
});

test('the same legacy ACP client request contract remains consumable by the Node reference', async (t) => {
  if (!h.hasNodeReference()) return t.skip('Node reference has not been built; Rust contracts above still ran');
  const referenceHome = path.join(dir, 'reference-home'); fs.mkdirSync(referenceHome);
  const referencePort = await h.freePort();
  const referenceBase = `http://127.0.0.1:${referencePort}`;
  const daemon = spawn(process.execPath, [path.join(h.repoRoot, 'apps/mcp-runtime/dist/cli.cjs'), '--port', String(referencePort), '--root', root], {
    cwd: h.repoRoot,
    env: {
      ...process.env, HOME: referenceHome, USERPROFILE: referenceHome,
      KEEPWORK_MCP_HOST_KIND: 'standalone', KEEPWORK_WORKBUDDY_PATH: fixture,
      KEEPWORK_AGENT_FIXTURE_LOG: path.join(dir, 'reference-fixture.log'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const done = new Promise((resolve) => daemon.once('exit', resolve));
  let timer;
  t.after(async () => {
    daemon.kill('SIGTERM');
    await Promise.race([done, new Promise((resolve) => {
      timer = setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 5000);
    })]);
    clearTimeout(timer);
  });
  await h.waitForHealth(referencePort);
  async function call(route, body) {
    const response = await fetch(referenceBase + '/agents' + route, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10_000),
      headers: { origin: referenceBase, 'x-agent-owner': ownerA,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  // Omit all new optional fields exactly as an older AIChat client does.
  const session = await call('/sessions', { backend: 'workbuddy', conversationId: 'legacy-contract', roots: [root] });
  assert.equal(session.status, 'idle');
  const sent = await call(`/sessions/${session.id}/turns`, { requestId: 'legacy-1', text: 'legacy request' });
  assert.equal(sent.session.id, session.id);
  assert.equal(sent.submission.state, 'accepted');
  let complete;
  const deadline = Date.now() + 5000;
  do {
    complete = await call(`/sessions/${session.id}`);
    if (complete.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(complete.status, 'completed');
  assert.equal(answerText(complete), '中文 fixture answer');
  assert.equal(complete.lastSubmission.requestId, 'legacy-1');
  const duplicate = await call(`/sessions/${session.id}/turns`, { requestId: 'legacy-1', text: 'must not repeat' });
  assert.equal(duplicate.submission.state, 'accepted');
});

test('malformed or duplicate persisted records stay read-only and preserve their exact original bytes', async (t) => {
  for (const corruption of ['bad-row', 'duplicate-id', 'receipt-string']) {
    await t.test(corruption, async () => {
      const isolated = fs.mkdtempSync(path.join(dir, 'invalid-registry-'));
      const isolatedPort = await h.freePort();
      const origin = `http://127.0.0.1:${isolatedPort}`;
      const owner = createHash('sha256').update(origin + '\0' + ownerA).digest('hex');
      const record = {
        id: 'persisted-session', owner, backend: 'workbuddy', conversationId: 'persisted-chat',
        threadId: 'persisted-native', title: 'Original persisted session', roots: [root],
        archived: false, removed: false, status: 'idle', mode: 'craft', cursor: 1, updatedAt: 1,
        items: [], pending: [], submissions: {},
      };
      const records = corruption === 'bad-row' ? [record, 'invalid row']
        : corruption === 'duplicate-id' ? [record, { ...record, title: 'Conflicting duplicate' }]
        : [{ ...record, submissions: { receipt: 'invalid receipt' }, lastRequestId: 'receipt' }];
      const original = Buffer.from(JSON.stringify(records, null, 1) + '\n');
      const registry = path.join(isolated, '.keepwork-mcp', 'agent-sessions-v1.json');
      fs.mkdirSync(path.dirname(registry), { recursive: true }); fs.writeFileSync(registry, original);
      const isolatedLog = path.join(isolated, 'native.log');
      const daemon = spawn(h.rustBinary(), ['--port', String(isolatedPort), '--root', root], {
        cwd: h.repoRoot, stdio: ['ignore', 'ignore', 'ignore'], env: {
          ...process.env, HOME: isolated, USERPROFILE: isolated, KEEPWORK_MCP_HOST_KIND: 'standalone',
          KEEPWORK_MCP_PORT: String(isolatedPort), KEEPWORK_MCP_ROOT: root, KEEPWORK_MCP_REQUIRE_AUTH: '0',
          KEEPWORK_WORKBUDDY_PATH: fixture, KEEPWORK_AGENT_FIXTURE_LOG: isolatedLog,
        },
      });
      const done = new Promise((resolve) => daemon.once('exit', resolve));
      try {
        await h.waitForHealth(isolatedPort);
        const read = await fetch(origin + '/agents/sessions', { headers: { origin, 'x-agent-owner': ownerA } });
        assert.ok(read.status < 500, 'malformed persisted receipts cannot panic the HTTP task');
        await read.json();
        const create = await fetch(origin + '/agents/sessions', {
          method: 'POST', headers: { origin, 'x-agent-owner': ownerA, 'content-type': 'application/json' },
          body: JSON.stringify({ backend: 'workbuddy', conversationId: 'must-not-rewrite', roots: [root] }),
        });
        assert.notEqual(create.status, 200, 'an incompatible registry is read-only');
        await create.json();
        assert.deepEqual(fs.readFileSync(registry), original, 'requests must preserve every original byte');
        assert.equal(fs.existsSync(isolatedLog), false, 'read-only registry rejects native session creation before provider I/O');
      } finally {
        daemon.kill('SIGTERM'); let timer;
        await Promise.race([done, new Promise((resolve) => {
          timer = setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 5000);
        })]);
        clearTimeout(timer);
      }
      assert.deepEqual(fs.readFileSync(registry), original, 'daemon shutdown must not rewrite the malformed registry');
    });
  }
});

test('Rust and Node can take turns hosting one profile without losing ACP history or replaying requests', async (t) => {
  if (!h.hasNodeReference()) return t.skip('Node reference has not been built; cross-engine live fixture not available');
  const createdByRust = await create('rust-to-node-history');
  assert.equal((await turn(createdByRust, 'rust-history-1', 'answer from Rust host')).status, 200);
  const rustDone = await waitSession(createdByRust, (view) => view.status === 'completed');
  assert.equal(answerText(rustDone), '中文 fixture answer');
  const firstCount = prompts().length;
  await stop(); await start('node');
  const onNode = await request(`/sessions/${createdByRust.id}`);
  assert.equal(onNode.status, 200, JSON.stringify(onNode.json));
  assert.equal(answerText(onNode.json), '中文 fixture answer');
  assert.equal(prompts().length, firstCount, 'downgrading to Node must only read, never replay a request');
  const duplicate = await turn(createdByRust, 'rust-history-1', 'must not replay after switch');
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(prompts().length, firstCount);
  const createdByNode = await create('node-to-rust-history');
  assert.equal((await turn(createdByNode, 'node-history-1', 'answer from Node host')).status, 200);
  await waitSession(createdByNode, (view) => view.status === 'completed');
  const secondCount = prompts().length;
  await stop(); await start();
  for (const session of [createdByRust, createdByNode]) {
    const onRust = await request(`/sessions/${session.id}`);
    assert.equal(onRust.status, 200, JSON.stringify(onRust.json));
    assert.equal(answerText(onRust.json), '中文 fixture answer');
    assert.equal(onRust.json.threadId, session.threadId);
  }
  assert.equal(prompts().length, secondCount, 'returning to Rust must not dispatch historical prompts');
});
