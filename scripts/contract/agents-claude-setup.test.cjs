const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./harness.cjs');

// Real HTTP and child stdio against an isolated Rust daemon. All Claude behavior
// comes from a fixture: this suite neither installs nor signs into real Claude.
const owner = 'claude-setup-owner-'.padEnd(40, 'a');
let directory, home, root, cli, log, port, base, child, exited;
function rows() {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function users(thread) {
  return rows().filter((row) => row.type === 'message' && row.message.type === 'user' && (!thread || row.thread === thread));
}
function headers(extra = {}) { return { origin: base, 'x-agent-owner': owner, ...extra }; }
async function request(route, body, extra = {}) {
  const response = await fetch(base + '/agents' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers({ ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}
function env(auth = 'in') {
  const missing = path.join(directory, 'missing-cli');
  const value = { KEEPWORK_MCP_ROOT: root, KEEPWORK_CLAUDE_PATH: cli, KEEPWORK_AGENT_FIXTURE_LOG: log,
    KEEPWORK_CLAUDE_FIXTURE_AUTH: auth, KEEPWORK_MCP_REQUIRE_AUTH: '0', KEEPWORK_MCP_HOST_KIND: 'standalone' };
  for (const backend of ['CODEX', 'WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) value['KEEPWORK_' + backend + '_PATH'] = missing;
  return value;
}
async function start() {
  child = spawn(h.rustBinary(), ['--port', String(port), '--root', root], {
    cwd: h.repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, ...env(), KEEPWORK_MCP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await h.waitForHealth(port); } catch (error) { throw Error(error.message + '\n' + output); }
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); let timer;
  const result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); })]);
  clearTimeout(timer); if (!result) { child.kill('SIGKILL'); await exited; }
}
async function create(conversationId, options = {}) {
  const result = await request('/sessions', { backend: 'claude', conversationId, roots: [root], ...options });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
}
async function turn(session, requestId, text, options = {}) {
  const result = await request(`/sessions/${session.id}/turns`, { requestId, text, ...options });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
}
async function wait(session, predicate) {
  const until = Date.now() + 5000; let view;
  do {
    const result = await request('/sessions/' + session.id); assert.equal(result.status, 200, JSON.stringify(result.body));
    view = result.body; if (predicate(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < until);
  assert.fail('Claude session state: ' + JSON.stringify(view));
}
const answerText = (view) => view.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join('\n');
before(async () => {
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-claude-setup-contract-')));
  home = path.join(directory, 'home'); root = path.join(directory, 'workspace'); fs.mkdirSync(home); fs.mkdirSync(root);
  cli = path.join(directory, 'claude fixture.cjs'); fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-agent-cli.cjs'), cli);
  log = path.join(directory, 'native.log'); port = await h.freePort(); base = `http://127.0.0.1:${port}`; await start();
});
after(async () => { await stop(); if (directory) await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('Claude inventory detects an existing installation without starting it or claiming account verification', async () => {
  const result = await request('/backends?backend=claude&probe=executable');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const info = result.body.claude;
  assert.equal(info.available, true); assert.equal(info.cli.path, cli); assert.equal(info.protocol, 'claude');
  assert.equal(info.protocolSupported, true); assert.equal(info.probe, 'executable');
  assert.equal(info.authenticated, null); assert.equal(info.authState, 'unknown'); assert.deepEqual(info.models, []);
  assert.equal(fs.existsSync(log), false, 'executable inventory must not run version, login or native probes');
});

test('Claude native initialization discovers models and fixed auth status without submitting a prompt', async () => {
  const result = await request('/backends?backend=claude&refresh=1');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const info = result.body.claude;
  assert.equal(info.available, true, JSON.stringify(info)); assert.equal(info.protocolSupported, true);
  assert.equal(info.authenticated, true); assert.equal(info.authState, 'verified');
  const model = info.models.find((model) => model.id === 'fixture-claude'); assert.ok(model, JSON.stringify(info.models));
  assert.deepEqual(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort), ['low', 'medium', 'high']);
  assert.equal(info.models.find((model) => model.id === 'fast').supportedReasoningEfforts?.length || 0, 0);
  assert.equal(users().length, 0, 'model/account discovery cannot generate a turn');
  assert.doesNotMatch(JSON.stringify(info), /SECRET_CLAUDE_AUTH_TOKEN/);
});

test('Claude native auth distinguishes explicit signed-out status from unavailable status', async () => {
  for (const auth of ['out', 'unknown']) {
    const daemon = await h.startRust({ env: env(auth) });
    try {
      const response = await fetch(daemon.base + '/agents/backends?backend=claude&refresh=1', { headers: { origin: daemon.base, 'x-agent-owner': owner }, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200); const info = (await response.json()).claude;
      assert.equal(info.protocolSupported, true);
      assert.equal(info.authenticated, auth === 'out' ? false : null, JSON.stringify(info));
      assert.equal(info.authState, auth === 'out' ? 'required' : 'unknown', JSON.stringify(info));
      assert.doesNotMatch(JSON.stringify(info), /SECRET_CLAUDE_AUTH_TOKEN/);
    } finally { await daemon.stop(); }
  }
});

test('Claude turns stream Unicode once, continue in the same native process and keep request receipts', async () => {
  const session = await create('claude-stream', { model: 'fixture-claude' });
  await turn(session, 'stream-one', 'FIXTURE_STREAM', { model: 'fixture-claude', effort: 'high' });
  const completed = await wait(session, (view) => view.status === 'completed');
  assert.equal(answerText(completed), '中文😀 Claude fixture answer');
  const initial = users(session.threadId); assert.equal(initial.length, 1);
  await turn(session, 'stream-one', 'changed retry text');
  assert.equal(users(session.threadId).length, 1, 'accepted request IDs cannot be replayed with changed content');
  await turn(session, 'stream-two', 'second turn'); await wait(session, (view) => view.status === 'completed');
  const dispatched = users(session.threadId); assert.equal(dispatched.length, 2); assert.equal(dispatched[0].pid, dispatched[1].pid);
  const other = await create('claude-other'); await turn(other, 'other-one', 'another session'); await wait(other, (view) => view.status === 'completed');
  assert.notEqual(users(other.threadId)[0].pid, dispatched[0].pid, 'Claude sessions cannot share a stream-json process');
});

test('Claude Ask keeps native approval interactive, scrubs tool secrets and preserves user answers', async () => {
  const session = await create('claude-ask', { mode: 'ask' });
  await turn(session, 'ask-permission', 'FIXTURE_PERMISSION');
  let waiting = await wait(session, (view) => view.status === 'waiting');
  assert.equal(waiting.pending.length, 1); assert.doesNotMatch(JSON.stringify(waiting.pending), /SECRET_CLAUDE_TOOL_TOKEN/);
  const wrongOwner = await request(`/sessions/${session.id}/respond`, { id: waiting.pending[0].id, decision: 'accept' }, { 'x-agent-owner': 'another-owner'.padEnd(40, 'x') });
  assert.notEqual(wrongOwner.status, 200);
  assert.equal((await request(`/sessions/${session.id}/respond`, { id: waiting.pending[0].id, decision: 'decline' })).status, 200);
  await wait(session, (view) => ['completed', 'failed'].includes(view.status));
  const denial = rows().filter((row) => row.thread === session.threadId && row.message?.type === 'control_response').at(-1);
  assert.equal(denial.message.response.response.behavior, 'deny');
  await turn(session, 'ask-question', 'FIXTURE_QUESTION'); waiting = await wait(session, (view) => view.status === 'waiting');
  const question = waiting.pending[0].params.questions[0];
  assert.equal((await request(`/sessions/${session.id}/respond`, { id: waiting.pending[0].id, answers: { [question.id]: 'blue' } })).status, 200);
  const complete = await wait(session, (view) => view.status === 'completed'); assert.match(answerText(complete), /blue/);
});

test('Claude Plan rejects side effects while allowing native read-only requests', async () => {
  const session = await create('claude-plan', { mode: 'plan' });
  await turn(session, 'plan-write', 'FIXTURE_PERMISSION'); await wait(session, (view) => ['completed', 'failed'].includes(view.status));
  let decision = rows().filter((row) => row.thread === session.threadId && row.message?.type === 'control_response').at(-1);
  assert.equal(decision.message.response.response.behavior, 'deny');
  await turn(session, 'plan-read', 'FIXTURE_READ_PERMISSION'); await wait(session, (view) => view.status === 'completed');
  decision = rows().filter((row) => row.thread === session.threadId && row.message?.type === 'control_response').at(-1);
  assert.equal(decision.message.response.response.behavior, 'allow');
  await turn(session, 'plan-to-craft', 'FIXTURE_PERMISSION', { mode: 'craft' });
  await wait(session, (view) => view.status === 'completed');
  decision = rows().filter((row) => row.thread === session.threadId && row.message?.type === 'control_response').at(-1);
  assert.equal(decision.message.response.response.behavior, 'allow');
  const modes = rows().filter((row) => row.thread === session.threadId && row.message?.request?.subtype === 'set_permission_mode');
  assert.equal(modes.at(-1).message.request.mode, 'default', 'leaving Plan must restore native default permission mode');
});

test('Claude unadvertised model effort and unsupported image turns reject before sending a prompt', async () => {
  const session = await create('claude-options');
  for (const options of [{ model: 'fixture-claude', effort: 'max' }, { model: 'fast', effort: 'high' }, { images: [] }]) {
    const count = users(session.threadId).length;
    const result = await request(`/sessions/${session.id}/turns`, { requestId: 'invalid-' + count + '-' + Object.keys(options).join('-') + (options.model || ''), text: 'do not execute', ...options });
    assert.notEqual(result.status, 200, JSON.stringify(result.body));
    assert.equal(users(session.threadId).length, count, 'unavailable requested semantics cannot execute a degraded prompt');
  }
});

test('Claude interruption and process loss never replay uncertain work', async () => {
  const session = await create('claude-stop');
  await turn(session, 'slow-one', 'FIXTURE_SLOW'); await wait(session, (view) => view.status === 'running');
  assert.equal((await request(`/sessions/${session.id}/interrupt`, {})).status, 200);
  await wait(session, (view) => view.status === 'interrupted');
  const crashing = await create('claude-crash');
  await request(`/sessions/${crashing.id}/turns`, { requestId: 'crash-one', text: 'FIXTURE_EXIT' });
  await wait(crashing, (view) => ['interrupted', 'uncertain', 'error', 'failed'].includes(view.status));
  const count = users(crashing.threadId).length;
  await request(`/sessions/${crashing.id}/turns`, { requestId: 'crash-one', text: 'FIXTURE_EXIT' });
  assert.equal(users(crashing.threadId).length, count); assert.equal(count, 1);
});

test('Claude aggregate output limit fails only the affected turn without replaying it', async () => {
  const flooding = await create('claude-output-limit');
  await turn(flooding, 'flood-one', 'FIXTURE_FLOOD');
  const failed = await wait(flooding, (view) => view.status === 'failed');
  assert.match(failed.error, /output limit/i);
  assert.ok(JSON.stringify(failed.items).length < 2_100_000);
  await turn(flooding, 'flood-one', 'FIXTURE_FLOOD'); assert.equal(users(flooding.threadId).length, 1);
  const unaffected = await create('claude-after-output-limit');
  await turn(unaffected, 'after-flood', 'ordinary continuation');
  assert.match(answerText(await wait(unaffected, (view) => view.status === 'completed')), /Claude fixture answer/);
});

test('Claude roots and AIChat tool context reach its own process without leaking capability into snapshots', async () => {
  const extraRoot = path.join(directory, 'extra workspace'); fs.mkdirSync(extraRoot);
  const conversationId = 'claude-context';
  const registered = await request('/contexts/' + conversationId, { pageId: 'claude-page', generation: 'claude-generation', instructions: 'Use the current conversation tools.', revision: 'claude-rev', tools: [] });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const session = await create(conversationId, { roots: [root, extraRoot], contextVersion: 1 });
  await turn(session, 'context-one', 'context hello', { contextVersion: 1 });
  const done = await wait(session, (view) => view.status === 'completed');
  const launch = rows().find((row) => row.type === 'launch' && row.thread === session.threadId);
  assert.equal(launch.cwd, h.canonicalAgentRoot(root));
  assert.ok(launch.args.includes('--add-dir'));
  assert.ok(launch.args.includes(h.canonicalAgentRoot(extraRoot)));
  const configIndex = launch.args.indexOf('--mcp-config'); assert.notEqual(configIndex, -1);
  assert.ok(JSON.parse(launch.args[configIndex + 1]).mcpServers.keepwork_aichat);
  const nativeText = JSON.stringify(users(session.threadId)[0].message); assert.match(nativeText, /aichat_context/); assert.match(nativeText, /claude-rev/);
  assert.doesNotMatch(JSON.stringify(done), /KEEPWORK_AICHAT_CAPABILITY|SECRET_CLAUDE/);
});

test('Claude restart preserves transcript and resumes native identity only for a new explicit request', async () => {
  const untouched = await create('claude-untouched-restart');
  const session = await create('claude-restart', { model: 'fixture-claude' });
  await turn(session, 'before-restart', 'before restart', { model: 'fixture-claude', effort: 'high' });
  const before = await wait(session, (view) => view.status === 'completed'); const count = users(session.threadId).length;
  await stop(); await start();
  const restored = await request('/sessions/' + session.id); assert.equal(restored.status, 200); assert.deepEqual(restored.body.items, before.items);
  assert.equal(users(session.threadId).length, count, 'reading saved history cannot resume or replay a prompt');
  await turn(session, 'before-restart', 'must not replay'); assert.equal(users(session.threadId).length, count);
  await turn(session, 'after-restart', 'after restart'); await wait(session, (view) => view.status === 'completed');
  const launches = rows().filter((row) => row.type === 'launch' && row.thread === session.threadId);
  assert.ok(launches.at(-1).args.some((arg, index, args) => arg === '--resume=' + session.threadId || arg === '--resume' && args[index + 1] === session.threadId));
  const resumedEffort = rows().filter((row) => row.pid === launches.at(-1).pid && row.message?.request?.subtype === 'set_max_thinking_tokens');
  assert.equal(resumedEffort.at(-1)?.message.request.max_thinking_tokens, 20000, 'saved effort must apply to the resumed explicit turn');
  assert.equal(users(session.threadId).length, count + 1);
  await turn(untouched, 'untouched-first-turn', 'first turn after restart');
  await wait(untouched, (view) => view.status === 'completed');
  const untouchedLaunches = rows().filter((row) => row.type === 'launch' && row.thread === untouched.threadId);
  assert.equal(untouchedLaunches.length, 2);
  assert.notEqual(untouchedLaunches[0].pid, untouchedLaunches[1].pid);
  assert.ok(untouchedLaunches[1].args.includes('--session-id=' + untouched.threadId), 'an initialized but unused Claude session has no native history to resume');
});

test('Claude missing executable stays distinct from unsupported protocol and ordinary MCP health remains available', async () => {
  const fixture = fs.readFileSync(cli); fs.unlinkSync(cli);
  try {
    const result = await request('/backends?backend=claude&probe=executable&refresh=1');
    const info = result.body.claude; assert.equal(info.available, false); assert.equal(info.cli, undefined);
    assert.notEqual(info.setup, 'unsupported'); assert.notEqual(info.code, 'UNSUPPORTED_FEATURE');
    assert.equal(info.authenticated, null); assert.equal(info.authState, 'unknown');
  } finally { fs.writeFileSync(cli, fixture); }
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.runtimeEngine, 'rust');
  const accounts = await request('/accounts'); assert.equal(accounts.status, 200); assert.equal(accounts.body.claude.available, true);
  const login = await request('/login', { backend: 'claude' }); assert.equal(login.status, 200); assert.equal(login.body.command, 'claude auth login'); assert.equal(login.body.url, undefined);
});
