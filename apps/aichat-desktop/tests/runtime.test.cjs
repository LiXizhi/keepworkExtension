const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RuntimeSupervisor, validateManifest, validateRuntime, BASE } = require('../src/runtime.cjs');
const manifest = { schemaVersion: 1, product: 'keepwork-mcp-node-runtime', version: '0.1.0', commit: 'a'.repeat(40), platform: 'windows', arch: 'x64', sha256: 'b'.repeat(64), size: 123, url: `${BASE}0.1.0/windows-x64.zip` };
test('stable manifests reject wrong platform, arbitrary URLs and corrupt integrity metadata', () => {
  assert.equal(validateManifest(manifest, 'windows', 'x64'), manifest);
  for (const change of [{ arch: 'arm64' }, { url: 'https://evil.test/runtime.zip' }, { version: 'next' }, { sha256: 'bad' }, { size: -1 }, { commit: '' }]) {
    assert.throws(() => validateManifest({ ...manifest, ...change }, 'windows', 'x64'));
  }
});
test('attaches to external services and never spawns or stops them', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const compatible of [true, false]) {
    const supervisor = new RuntimeSupervisor(home, '', '0.1.0', { probe: async () => ({ compatible, hostKind: 'vscode-extension' }), spawn: () => assert.fail('must not spawn') });
    await supervisor.start(); assert.equal(supervisor.state.state, compatible ? 'attached' : 'conflict');
    assert.equal(supervisor.state.owner, 'vscode-extension'); await supervisor.stop();
  }
});
test('invalid staged runtime falls back without losing the installed record', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor(home, 'missing', '0.1.0', { probe: async () => null, spawn: () => assert.fail('must not spawn corrupt archives') });
  supervisor.record = { pending: 'b'.repeat(64), current: 'c'.repeat(64) };
  await supervisor.start(); assert.equal(supervisor.state.state, 'error');
  assert.equal(supervisor.record.pending, undefined); assert.equal(supervisor.record.current, 'c'.repeat(64));
  assert.throws(() => supervisor.directory('../escape'));
  assert.throws(() => validateRuntime(home, 'windows', 'x64'));
});
test('failed pending launch rolls back to the current healthy runtime', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const current = 'c'.repeat(64), pending = 'b'.repeat(64);
  let active;
  const supervisor = new RuntimeSupervisor(home, 'missing', '0.1.0', {
    probe: async () => active?.exitCode === null ? { compatible: true, pid: active.pid } : null,
    spawn: (_exe, _args, options) => {
      active = new EventEmitter(); active.pid = 123;
      active.exitCode = options.cwd.endsWith(pending) ? 1 : null;
      active.kill = () => { active.exitCode = 0; active.emit('exit', 0); };
      return active;
    },
  });
  for (const hash of [current, pending]) {
    const dir = supervisor.directory(hash); fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    const exe = supervisor.platform === 'windows' ? 'node.exe' : 'bin/node';
    fs.mkdirSync(path.dirname(path.join(dir, exe)), { recursive: true });
    fs.writeFileSync(path.join(dir, exe), 'fixture'); fs.writeFileSync(path.join(dir, 'app/cli.cjs'), 'fixture');
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, product: 'keepwork-mcp-node-runtime', version: '0.1.0', platform: supervisor.platform, arch: supervisor.arch, entry: 'app/cli.cjs' }));
  }
  supervisor.record = { current, pending };
  await supervisor.start(); assert.equal(supervisor.state.state, 'running');
  assert.equal(supervisor.record.current, current); assert.equal(supervisor.record.pending, undefined);
  await supervisor.stop();
});
test('corrupt update bytes never replace the installed runtime', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-corrupt-'));
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; fs.rmSync(home, { recursive: true, force: true }); });
  const supervisor = new RuntimeSupervisor(home, 'missing', '0.1.0');
  supervisor.record.current = 'c'.repeat(64);
  global.fetch = async url => String(url).endsWith('.json')
    ? new Response(JSON.stringify({ ...manifest, platform: supervisor.platform, arch: supervisor.arch,
        url: `${BASE}0.1.0/${supervisor.platform}-${supervisor.arch}.zip`, size: 3 }))
    : new Response('bad');
  await assert.rejects(supervisor.check(), /integrity mismatch/);
  assert.equal(supervisor.record.current, 'c'.repeat(64)); assert.equal(supervisor.record.pending, undefined);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('restart rejects external ownership and refreshes current status without stopping it', async () => {
  const supervisor = new RuntimeSupervisor('unused', '', '0.1.0', {
    probe: async () => ({ compatible: true, hostKind: 'vscode-extension', pid: 42, runtimeVersion: '2.0.0' }),
    spawn: () => assert.fail('must not spawn'),
  });
  supervisor.stop = () => assert.fail('must not stop external server');
  await assert.rejects(supervisor.restart(), /vscode-extension/);
  assert.equal(supervisor.state.state, 'attached');
  assert.equal(supervisor.state.version, '2.0.0');
});

test('restart coalesces clicks and waits for owned shutdown before starting', async () => {
  const supervisor = new RuntimeSupervisor('unused', '', '0.1.0', { probe: async () => ({ compatible: true, pid: 7 }) });
  supervisor.child = { pid: 7 };
  const calls = [];
  supervisor.stop = async () => { calls.push('stop'); await new Promise(resolve => setImmediate(resolve)); calls.push('stopped'); };
  supervisor.start = async () => { calls.push('start'); supervisor.state = { state: 'running', owner: 'desktop' }; };
  const first = supervisor.restart();
  assert.equal(supervisor.restart(), first);
  await first;
  assert.deepEqual(calls, ['stop', 'stopped', 'start']);
  assert.equal(supervisor.restarting, null);
});

test('restart starts an offline service and reports failed readiness', async () => {
  const supervisor = new RuntimeSupervisor('unused', '', '0.1.0', { probe: async () => null });
  supervisor.stop = async () => {};
  supervisor.start = async () => { supervisor.state = { state: 'error', error: 'fixture startup failed' }; };
  await assert.rejects(supervisor.restart(), /fixture startup failed/);
  assert.equal(supervisor.restarting, null);
});

function localRuntimeFixture(t, version = '2.0.0', options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-takeover-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bundled = path.join(home, 'bundled');
  const supervisor = new RuntimeSupervisor(home, bundled, '0.1.0', {}, options);
  function writeRuntime(dir, runtimeVersion) {
    const exe = supervisor.platform === 'windows' ? 'node.exe' : 'bin/node';
    fs.mkdirSync(path.dirname(path.join(dir, exe)), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, exe), 'fixture');
    fs.writeFileSync(path.join(dir, 'app', 'cli.cjs'), 'fixture');
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ schemaVersion: 1,
      product: supervisor.options.product, version: runtimeVersion, platform: supervisor.platform,
      arch: supervisor.arch, entry: supervisor.options.entry }));
  }
  writeRuntime(bundled, version);
  return { supervisor, writeRuntime };
}

test('startup forcibly replaces an older compatible MCP and owns the new runtime', async t => {
  const { supervisor, writeRuntime } = localRuntimeFixture(t);
  const current = 'c'.repeat(64);
  writeRuntime(supervisor.directory(current), '1.0.0');
  supervisor.record.current = current;
  let health = { compatible: true, pid: 42123, hostKind: 'vscode-extension', version: '1.9.0' };
  const calls = [];
  supervisor.deps.probe = async () => health;
  supervisor.deps.kill = (pid, signal) => { calls.push(['kill', pid, signal]); health = null; };
  supervisor.deps.spawn = (_exe, _args, options) => {
    calls.push(['spawn', options.env.KEEPWORK_MCP_RUNTIME_VERSION]);
    const child = new EventEmitter(); child.pid = 42124; child.exitCode = null;
    child.kill = () => { child.exitCode = 0; health = null; child.emit('exit', 0); };
    health = { compatible: true, pid: child.pid, runtimeVersion: '2.0.0' };
    return child;
  };
  await supervisor.start();
  assert.deepEqual(calls, [['kill', 42123, 'SIGKILL'], ['spawn', '2.0.0']]);
  assert.equal(supervisor.state.state, 'running');
  assert.equal(supervisor.state.owner, 'desktop');
  await supervisor.stop();
});

test('startup preserves equal, newer, unknown and incompatible external services', async t => {
  for (const change of [{ runtimeVersion: '2.0.0' }, { runtimeVersion: '10.0.0' },
    { runtimeVersion: 'unknown' }, { runtimeVersion: undefined }, { compatible: false, runtimeVersion: '1.0.0' }]) {
    const { supervisor } = localRuntimeFixture(t);
    const health = { compatible: true, pid: 42123, hostKind: 'local-helper', ...change };
    supervisor.deps.probe = async () => health;
    supervisor.deps.kill = () => assert.fail('must not kill');
    supervisor.deps.spawn = () => assert.fail('must not spawn');
    await supervisor.start();
    assert.equal(supervisor.state.state, health.compatible ? 'attached' : 'conflict');
  }
});

test('startup does not kill local-model services or services without a valid local MCP', async t => {
  const { supervisor } = localRuntimeFixture(t, '2.0.0', { product: 'keepwork-local-model-node-runtime' });
  supervisor.deps.probe = async () => ({ compatible: true, pid: 42123, runtimeVersion: '1.0.0' });
  supervisor.deps.kill = () => assert.fail('must not kill model runtime');
  await supervisor.start();
  assert.equal(supervisor.state.state, 'attached');
  supervisor.options.product = 'keepwork-mcp-node-runtime';
  await supervisor.start();
  assert.equal(supervisor.state.state, 'attached');
});

test('takeover rechecks identity and fails safely when termination is unavailable', async t => {
  for (const mode of ['changed', 'invalid-pid', 'denied']) {
    const { supervisor } = localRuntimeFixture(t);
    const original = { compatible: true, pid: mode === 'invalid-pid' ? 0 : 42123, runtimeVersion: '1.0.0' };
    let probes = 0;
    supervisor.deps.probe = async () => ++probes > 1 && mode === 'changed'
      ? { compatible: true, pid: 42125, runtimeVersion: '3.0.0' } : original;
    supervisor.deps.kill = () => {
      assert.equal(mode, 'denied');
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    };
    supervisor.deps.spawn = () => assert.fail('must not spawn before port is free');
    await supervisor.start();
    assert.equal(supervisor.state.state, mode === 'changed' ? 'attached' : 'error');
  }
});

test('stop accepts signal-based child exit before a subsequent restart', async () => {
  const supervisor = new RuntimeSupervisor('unused', '', '0.1.0');
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  let kills = 0;
  child.kill = () => { kills++; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
  supervisor.child = child;
  await supervisor.stop();
  assert.equal(kills, 1);
  assert.equal(supervisor.child, null);
});
