const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

let rust;

before(async () => {
  rust = await h.startRust();
});

after(async () => {
  await rust?.stop();
});

test('health reports the Node identity fields and the Rust engine', async () => {
  const response = await fetch(`${rust.base}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8/);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.name, 'keepwork-mcp');
  assert.equal(health.version, '0.1.2');
  assert.equal(health.hostKind, 'standalone');
  assert.equal(health.port, rust.port);
  assert.equal(health.requireAuth, false);
  assert.equal(health.runtimeEngine, 'rust');
  assert.equal(health.runtimeProduct, 'keepwork-mcp-runtime');
  assert.equal(typeof health.pid, 'number');
  // Node's realpath keeps the platform separator, so Windows reports backslashes.
  const suffix = path.join('.keepwork-mcp', 'workspace');
  assert.ok(
    String(health.workspaceRoot).replaceAll('/', path.sep).endsWith(suffix),
    `workspaceRoot ${health.workspaceRoot} should end with ${suffix}`
  );
});

test('health only advertises capabilities this build serves', async () => {
  const health = await (await fetch(`${rust.base}/health`)).json();
  assert.equal(health.fsApi, 'workspace');
  assert.equal(health.terminalApi, 'pty-session-v1');
  assert.equal(health.aichatPresenceApi, 'post-sse-v1');
  assert.equal(health.personasApi, 'personas-v1');
  assert.equal(health.agentSessionApi, 'v1');
  assert.equal(health.agentInventoryApi, 'v1');
  assert.equal(health.agentContextApi, 'v1');
  assert.equal(health.agentModeApi, 'v1');
  for (const unimplemented of [
    'browserApi',
    'webserverBase',
  ]) {
    assert.equal(health[unimplemented], undefined, `${unimplemented} must stay unadvertised until implemented`);
  }
});

test('health matches the Node reference on the shared identity fields', async () => {
  const node = await h.startNode();
  if (!node) return;
  try {
    for (const key of ['ok', 'name', 'version', 'hostKind', 'requireAuth', 'fsApi', 'terminalApi', 'aichatPresenceApi', 'personasApi', 'messagingApi']) {
      assert.equal(rust.health[key], node.health[key], `field ${key} must match the Node daemon`);
    }
    // Native agent sessions now share the Node v1 contract as an independent engine.
    assert.equal(node.health.terminalApi, rust.health.terminalApi);
    assert.equal(node.health.fsApi, rust.health.fsApi);
    assert.equal(node.health.agentSessionApi, 'v1');
    assert.equal(rust.health.agentSessionApi, 'v1');
  } finally {
    await node.stop();
  }
});

test('exists and fs/stat keep the Node payload shapes', async () => {
  const exists = await (await fetch(`${rust.base}/exists?path=${encodeURIComponent(os.homedir())}`)).json();
  assert.equal(exists.ok, true);
  assert.equal(exists.exists, true);
  assert.equal(exists.isDirectory, true);
  assert.equal(typeof exists.resolved, 'string');

  const missing = await fetch(`${rust.base}/exists`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'path is required');

  const root = encodeURIComponent(os.homedir());
  const stat = await fetch(`${rust.base}/fs/stat?root=${root}&path=missing-contract-entry`);
  assert.equal(stat.status, 200);
  const body = await stat.json();
  assert.equal(body.ok, true);
  assert.equal(body.exists, false);
  assert.equal(body.rel, 'missing-contract-entry');

  const noRoot = await fetch(`${rust.base}/fs/stat?path=x`);
  assert.equal(noRoot.status, 400);
  assert.equal((await noRoot.json()).error, 'root is required');
});

test('unknown routes answer like the Node daemon', async () => {
  const response = await fetch(`${rust.base}/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not found');

  const fsFallback = await fetch(`${rust.base}/fs/nope?root=${encodeURIComponent('/')}`);
  assert.equal(fsFallback.status, 404);
  assert.deepEqual(await fsFallback.json(), { ok: false, error: 'not found' });
});

test('admin status is loopback-only metadata without Node-only fields', async () => {
  const body = await (await fetch(`${rust.base}/admin/status`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.runtimeEngine, 'rust');
  assert.equal(body.platform, process.platform === 'darwin' ? 'darwin' : process.platform);
  assert.equal(body.port, rust.port);
  assert.ok(Array.isArray(body.clients));
  assert.equal(body.nodeVersion, undefined);
});
