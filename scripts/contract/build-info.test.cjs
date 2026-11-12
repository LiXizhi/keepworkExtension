const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./harness.cjs');
const { readBuildInfo, sourceFingerprint } = require('../../apps/aichat-rust/scripts/bundle-mcp-rust.cjs');

test('Rust --build-info reports compiled identity before parsing user config or starting a daemon', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-build-info-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  const binary = h.rustBinary();
  const result = spawnSync(binary, ['--build-info', '--port', '8089'], {
    cwd: temporary,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(temporary, 'appdata'),
      LOCALAPPDATA: path.join(temporary, 'local-appdata'),
      XDG_CONFIG_HOME: path.join(temporary, 'xdg-config'),
      XDG_DATA_HOME: path.join(temporary, 'xdg-data'),
      XDG_CACHE_HOME: path.join(temporary, 'xdg-cache'),
      KEEPWORK_MCP_ROOT: path.join(temporary, 'workspace-must-not-be-created'),
      KEEPWORK_MCP_PORT: 'not-a-port',
      KEEPWORK_MCP_REQUIRE_AUTH: '1',
      KEEPWORK_MCP_RUNTIME_VERSION: '0.0.0',
      KEEPWORK_MCP_RUNTIME_COMMIT: '0'.repeat(40),
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', 'build information must not emit daemon startup logs');
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, 'build information is one JSON record without startup output');
  const info = JSON.parse(lines[0]);
  assert.equal(info.marker, 'keepwork-mcp-build-v1');
  assert.equal(info.endMarker, 'keepwork-mcp-build-end');
  assert.equal(info.product, 'keepwork-mcp-runtime');
  assert.equal(info.engine, 'rust');
  // A prepared release may be built from an immutable snapshot while unrelated
  // work continues in the shared checkout. Default checks still use this tree.
  const rustRoot = process.env.KEEPWORK_MCP_TEST_SOURCE_ROOT || path.join(h.repoRoot, 'apps/mcp-rust');
  const manifest = fs.readFileSync(path.join(rustRoot, 'crates/keepwork-mcp/Cargo.toml'), 'utf8');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  assert.ok(version, 'the runtime crate must declare its product version');
  assert.equal(info.version, version, 'runtime environment metadata cannot replace the compiled version');
  assert.match(info.commit, /^[a-f0-9]{40}$/);
  assert.notEqual(info.commit, '0'.repeat(40), 'runtime environment metadata cannot replace the compiled commit');
  assert.equal(typeof info.target, 'string');
  assert.ok(info.target.length > 0);
  assert.match(info.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(info.sourceHash, sourceFingerprint(rustRoot), 'the tested binary must contain the current source');
  for (const capability of ['agentSessionApi', 'agentInventoryApi', 'agentContextApi', 'agentModeApi']) {
    assert.equal(info.capabilities[capability], 'v1');
  }
  assert.deepEqual(info, readBuildInfo(binary), 'executed and statically embedded build records must agree');
  assert.deepEqual(fs.readdirSync(home), [], 'build information must not initialize a user profile or token');
  assert.deepEqual(fs.readdirSync(temporary).sort(), ['home'], 'build information must not create workspaces or app state');
});
