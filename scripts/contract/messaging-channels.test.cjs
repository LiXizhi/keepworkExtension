const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

// Channel-hosting contract: the Rust daemon drives fake `dws` / `lark-cli`
// executables (KEEPWORK_DWS_PATH / KEEPWORK_LARK_PATH) so needs-login,
// connect, stop, restart, conflict, switch and inbox flows run end to end
// without network access. Binding ids and payloads must match the Node daemon.
let rust;
let rootDir;
let cliDir;
const ownerA = 'a'.repeat(32);
const ownerB = 'b'.repeat(32);

before(async () => {
  // mkdtemp returns the /var/... symlink alias on macOS; the daemon realpaths
  // binding roots, so canonicalize here and compare canonical paths everywhere.
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-channel-root-')));
  cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-channel-cli-'));
  const dws = path.join(cliDir, 'dws');
  fs.writeFileSync(dws, `#!/bin/bash
# Minimal fake \`dws\` CLI: only the subcommands the daemon calls.
case "$1 \${2:-}" in
  "profile list")
    echo '{"currentProfile":"corp1:user1","profiles":[{"corpId":"corp1","userId":"user1","corpName":"Acme","userName":"Tester","isCurrent":true}]}'
    ;;
  "event status")
    echo '{"identity":{"corpId":"corp1","userId":"user1","openDingTalkId":"oid-1"},"bus":{"live":{"consumers":[]}},"subscriptions":[]}'
    ;;
  "chat +chat-list"|"chat +chat-search")
    echo '[{"openConversationId":"cidG1","name":"研发群"},{"openConversationId":"cidG2","name":"客服群"}]'
    ;;
  "event consume")
    echo "[event] ready" >&2
    while kill -0 $PPID 2>/dev/null; do sleep 1; done
    ;;
  "auth login")
    exit 0
    ;;
  *)
    echo '{}'
    ;;
esac
`);
  fs.chmodSync(dws, 0o755);
  const lark = path.join(cliDir, 'lark-cli');
  fs.writeFileSync(lark, '#!/bin/bash\necho \'未登录: run lark auth login first\' >&2\nexit 1\n');
  fs.chmodSync(lark, 0o755);
  rust = await h.startRust({ env: { KEEPWORK_DWS_PATH: dws, KEEPWORK_LARK_PATH: lark } });
});

after(async () => {
  await rust?.stop();
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(cliDir, { recursive: true, force: true });
});

function headers(ownerKey, extra = {}) {
  return {
    origin: `http://127.0.0.1:${rust.port}`,
    'x-agent-owner': ownerKey,
    ...extra,
  };
}

async function persona(ownerKey, method, route, body) {
  const response = await fetch(`${rust.base}/agents/personas${route}`, {
    method,
    headers: headers(ownerKey, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

test('feishu connect surfaces needs-login when the CLI rejects with a login error', async () => {
  await persona(ownerA, 'POST', '', { id: 'agent-a', name: 'A', prompt: 'p', root: rootDir });
  const result = await persona(ownerA, 'POST', '/agent-a/channel-connect', { channel: 'feishu', root: rootDir });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { status: 'needs-login', listening: false, needsLogin: true });
});

test('dingtalk connect starts a listener and the persona view carries the binding', async () => {
  const result = await persona(ownerA, 'POST', '/agent-a/channel-connect', { root: rootDir });
  assert.equal(result.status, 200);
  assert.equal(result.json.channel, 'dingtalk');
  assert.equal(result.json.profile, 'corp1:user1');
  assert.equal(result.json.listening, true);
  assert.match(result.json.id, /^[0-9a-f]{32}$/);

  const view = await persona(ownerA, 'GET', '/agent-a');
  assert.equal(view.status, 200);
  assert.equal(view.json.channels.length, 1);
  assert.equal(view.json.channels[0].id, result.json.id);
  assert.equal(view.json.channels[0].listening, true);
  assert.equal(view.json.groupWorkActive, false);
});

test('channel-stop halts the listener and channel-start brings it back', async () => {
  const created = await persona(ownerA, 'POST', '/agent-a/channel-connect', { root: rootDir });
  const bindingId = created.json.id;

  const stopped = await persona(ownerA, 'POST', '/agent-a/channel-stop', { binding: bindingId });
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.json, { ok: true });
  const viewAfterStop = await persona(ownerA, 'GET', '/agent-a');
  assert.equal(viewAfterStop.json.channels[0].listening, false);

  const restarted = await persona(ownerA, 'POST', '/agent-a/channel-start', { binding: bindingId });
  assert.equal(restarted.status, 200);
  assert.deepEqual(restarted.json, { ok: true });
  const viewAfterStart = await persona(ownerA, 'GET', '/agent-a');
  assert.equal(viewAfterStart.json.channels[0].listening, true);
});

// The `/messaging/*` management surface rides on the same binding store, so
// these tests run while agent-a's dingtalk binding occupies rootDir.
async function messaging(ownerKey, method, route, body, extra = {}) {
  const response = await fetch(`${rust.base}/messaging${route}`, {
    method,
    headers: headers(ownerKey, { ...(body ? { 'content-type': 'application/json' } : {}), ...extra }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, response };
}

test('messaging config writes 0600 rules files and reports the stored shape', async () => {
  const saved = await messaging(ownerA, 'POST', '/config', {
    root: rootDir,
    profile: 'corp1:user1',
    config: { version: 1, keywords: ['发布', '周报'], groups: [], knowledge: [], executor: 'auto', model: '' },
    prompt: '只回答公开知识问题。',
  });
  assert.equal(saved.status, 200);
  // configure() stops an existing run first, exactly like Node.
  assert.equal(saved.json.enabled, false);
  assert.equal(saved.json.profile, 'corp1:user1');

  // Persona connects bind an agent, so the rules live in the agent-scoped
  // directory reported by the binding (Node's configure does the same).
  const rulesDir = path.join(rootDir, ...saved.json.rulesDir.split('/'));
  const config = JSON.parse(fs.readFileSync(path.join(rulesDir, 'config.json'), 'utf8'));
  assert.deepEqual(config.keywords, ['发布', '周报']);
  assert.equal(config.version, 1);
  assert.equal(config.executor, 'auto');
  assert.equal(fs.readFileSync(path.join(rulesDir, 'SKILL.md'), 'utf8'), '只回答公开知识问题。');
  for (const file of ['config.json', 'SKILL.md']) {
    assert.equal(fs.statSync(path.join(rulesDir, file)).mode & 0o777, 0o600, file);
  }

  const listed = await messaging(ownerA, 'GET', `/config?root=${encodeURIComponent(rootDir)}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.bindings.length, 1);
  assert.deepEqual(listed.json.bindings[0].config.keywords, ['发布', '周报']);
  assert.equal(listed.json.bindings[0].prompt, '只回答公开知识问题。');
  assert.equal(listed.json.defaults.config.version, 1);
  assert.equal(typeof listed.json.defaults.prompt, 'string');

  const missing = await messaging(ownerA, 'GET', '/config?root=/definitely/not/here');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'Existing local second-brain directory required');
});

test('messaging profiles and groups project CLI output into identifier-only rows', async () => {
  const profiles = await messaging(ownerA, 'POST', '/profiles', { root: rootDir });
  assert.equal(profiles.status, 200);
  assert.equal(profiles.json.profiles.length, 1);
  assert.equal(profiles.json.profiles[0].id, 'corp1:user1');
  assert.equal(profiles.json.profiles[0].name, 'Acme / Tester');
  assert.equal(profiles.json.profiles[0].current, true);
  assert.equal(profiles.json.profiles[0].corpId, undefined);

  const groups = await messaging(ownerA, 'POST', '/groups', { root: rootDir, profile: 'corp1:user1' });
  assert.equal(groups.status, 200);
  assert.deepEqual(groups.json.groups, [
    { id: 'cidG1', name: '研发群' },
    { id: 'cidG2', name: '客服群' },
  ]);
});

test('messaging start and stop drive the listener with conflict and switch guards', async () => {
  const config = await messaging(ownerA, 'GET', `/config?root=${encodeURIComponent(rootDir)}`);
  const bindingId = config.json.bindings[0].id;

  const started = await messaging(ownerA, 'POST', '/start', { id: bindingId });
  assert.equal(started.status, 200);
  assert.equal(started.json.listening, true);

  const stopped = await messaging(ownerA, 'POST', '/stop', { id: bindingId });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.listening, false);

  const badSwitch = await messaging(ownerA, 'POST', '/start', { id: bindingId, switchFromRoot: '/elsewhere' });
  assert.equal(badSwitch.status, 409);
  assert.equal(badSwitch.json.code, 'CHANNEL_OCCUPIED');

  const badProfile = await messaging(ownerA, 'POST', '/config', {
    root: rootDir,
    profile: 'not-a-profile',
    config: { version: 1, keywords: [], groups: [], knowledge: [] },
    prompt: 'p',
  });
  assert.equal(badProfile.status, 400);
  assert.equal(badProfile.json.error, 'Select a stable corpId:userId profile');
});

test('messaging routes enforce origin, worker gaps and the 404 contract', async () => {
  const status = await messaging(ownerA, 'GET', '/status');
  assert.equal(status.status, 200);
  assert.ok(Array.isArray(status.json.bindings));
  assert.equal(status.response.headers.get('cache-control'), 'no-store');
  assert.equal(status.response.headers.get('referrer-policy'), 'no-referrer');

  const evil = await fetch(`${rust.base}/messaging/status`, {
    headers: { origin: 'https://evil.example', 'x-agent-owner': ownerA },
  });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error, 'Messaging Origin rejected');

  const worker = await fetch(`${rust.base}/messaging/worker`, {
    headers: headers(ownerA),
  });
  assert.equal(worker.status, 422);
  assert.equal((await worker.json()).code, 'UNSUPPORTED_FEATURE');

  const unknown = await messaging(ownerA, 'POST', '/nonsense', {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'Messaging route not found');
});

test('messaging events streams the initial status frame and reacts to persistence writes', async () => {
  const controller = new AbortController();
  const events = await fetch(`${rust.base}/messaging/events`, {
    headers: headers(ownerA),
    signal: controller.signal,
  });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);

  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readFrame = async () => {
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        return frame;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed early');
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const first = await readFrame();
  assert.match(first, /^event: status\ndata: /);
  const payload = (frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
  assert.ok(Array.isArray(payload(first).bindings));

  // A stop persists the binding, so the stream must push a fresh frame.
  const config = await messaging(ownerA, 'GET', `/config?root=${encodeURIComponent(rootDir)}`);
  const stopped = await messaging(ownerA, 'POST', '/stop', { id: config.json.bindings[0].id });
  assert.equal(stopped.status, 200);
  const second = await readFrame();
  assert.match(second, /^event: status\ndata: /);
  assert.equal(payload(second).bindings[0].listening, false);

  controller.abort();
});

test('connecting another root on the occupied channel returns the conflict payload, then the switch lands', async () => {
  const root2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-channel-root2-')));
  try {
    await persona(ownerB, 'POST', '', { id: 'agent-b', name: 'B', prompt: 'p', root: root2 });
    const conflict = await persona(ownerB, 'POST', '/agent-b/channel-connect', { root: root2 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'CHANNEL_OCCUPIED');
    assert.equal(conflict.json.occupiedRoot, rootDir);
    assert.equal(conflict.json.requestedRoot, root2);
    assert.equal(conflict.json.confirmationRequired, true);

    const switched = await persona(ownerB, 'POST', '/agent-b/channel-connect', { root: root2, switchFromRoot: rootDir });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.listening, true);
    const viewB = await persona(ownerB, 'GET', '/agent-b');
    assert.equal(viewB.json.channels.length, 1);
    assert.equal(viewB.json.channels[0].listening, true);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('inbox actions and manual replies validate ownership and inputs', async () => {
  const view = await persona(ownerA, 'GET', '/agent-a');
  const bindingId = view.json.channels[0].id;

  const unknownAction = await persona(ownerA, 'POST', '/agent-a/inbox', { binding: bindingId, conversation: '', action: '' });
  assert.equal(unknownAction.status, 400);

  const read = await persona(ownerA, 'POST', '/agent-a/inbox', { binding: bindingId, conversation: '', action: 'read' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { ok: true });

  const invalidReply = await persona(ownerA, 'POST', '/agent-a/reply', { binding: bindingId, conversation: 'c1', requestId: 'r1', text: '  ' });
  assert.equal(invalidReply.status, 400);
  assert.equal(invalidReply.json.error, 'Invalid reply');

  // Another owner cannot act on a binding it does not own.
  const foreign = await persona(ownerB, 'POST', '/agent-b/inbox', { binding: bindingId, conversation: '', action: 'read' });
  assert.equal(foreign.status, 400);
});
