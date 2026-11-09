const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RuntimeSupervisor, validateManifest, validateRuntime, BASE } = require('../src/runtime.cjs');
// Tiny stored ZIP fixture; no packaging tools or native runtime download needed.
function zipFixture(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(entry, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
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
  assert.deepEqual(fs.readdirSync(home), ['state.json']);
  assert.equal(supervisor.updateSnapshot().stale, true);
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
  let health = { compatible: true, pid: 42123, hostKind: 'vscode-extension', runtimeVersion: '1.9.0' };
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
    { runtimeVersion: 'unknown' }, { runtimeVersion: undefined }, { runtimeVersion: undefined, version: '0.1.2' }, { compatible: false, runtimeVersion: '1.0.0' }]) {
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


test('heartbeat recovery excludes staged release; explicit activation verifies identity and promotes it', async t => {
  const { supervisor, writeRuntime } = localRuntimeFixture(t, '1.0.0');
  const pending = 'b'.repeat(64);
  writeRuntime(supervisor.directory(pending), '2.0.0');
  let health = null;
  const launches = [];
  supervisor.deps.probe = async () => health;
  supervisor.deps.spawn = (_exe, _args, options) => {
    launches.push(options.env.KEEPWORK_MCP_RUNTIME_VERSION);
    const child = new EventEmitter(); child.pid = 123; child.exitCode = null;
    health = { compatible: true, pid: 123, runtimeVersion: launches.at(-1) };
    child.kill = () => { child.exitCode = 0; health = null; child.emit('exit', 0); };
    return child;
  };
  await supervisor.start();
  supervisor.record.pending = pending;
  supervisor.record.pendingMetadata = { version: '2.0.0' };
  await supervisor.stop(); await supervisor.start();
  assert.deepEqual(launches, ['1.0.0', '1.0.0']);
  assert.equal(supervisor.record.pending, pending);
  await supervisor.restart(true);
  assert.deepEqual(launches, ['1.0.0', '1.0.0', '2.0.0']);
  assert.equal(supervisor.record.current, pending);
  assert.equal(supervisor.record.pending, undefined);
  assert.equal(supervisor.updateSnapshot().state, 'current');
  await supervisor.stop();
});

test('metadata-only check retains remote date and last successful metadata after offline failure', async t => {
  const { supervisor } = localRuntimeFixture(t, '1.0.0');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const remote = { ...manifest, version: '2.0.0', platform: supervisor.platform, arch: supervisor.arch,
    builtAt: '2026-10-20T00:00:00Z', url: `${BASE}2.0.0/${supervisor.platform}-${supervisor.arch}.zip` };
  let requests = 0;
  global.fetch = async () => { requests++; return new Response(JSON.stringify(remote)); };
  await supervisor.check(false);
  assert.equal(requests, 1);
  assert.equal(supervisor.updateSnapshot().latest.builtAt, remote.builtAt);
  assert.equal(supervisor.updateSnapshot().state, 'available');
  const checkedAt = supervisor.record.checkedAt;
  global.fetch = async () => { throw Error('offline'); };
  await assert.rejects(supervisor.check(false), /offline/);
  assert.equal(supervisor.updateSnapshot().stale, true);
  assert.equal(supervisor.record.checkedAt, checkedAt);
  assert.equal(supervisor.record.latest.version, '2.0.0');
});


test('wrong candidate health identity rolls back and remembers failed release', async t => {
  const { supervisor, writeRuntime } = localRuntimeFixture(t, '1.0.0');
  const pending = 'b'.repeat(64); writeRuntime(supervisor.directory(pending), '2.0.0');
  supervisor.record.pending = pending;
  let health = null; const launches = [];
  supervisor.deps.probe = async () => health;
  supervisor.deps.spawn = (_exe, _args, options) => {
    launches.push(options.env.KEEPWORK_MCP_RUNTIME_VERSION);
    const child = new EventEmitter(); child.pid = 321; child.exitCode = null;
    health = { compatible: true, pid: 321, runtimeVersion: 'wrong-version' };
    child.kill = () => { child.exitCode = 0; health = null; child.emit('exit', 0); };
    return child;
  };
  await supervisor.start();
  assert.deepEqual(launches, ['2.0.0', '1.0.0']);
  assert.equal(supervisor.record.pending, undefined);
  assert.equal(supervisor.record.failed, pending);
  assert.equal(supervisor.state.version, '1.0.0');
  assert.match(supervisor.updateSnapshot().error, /identity mismatch/);
  await supervisor.stop();
  await supervisor.download({ ...manifest, sha256: pending });
  assert.equal(supervisor.record.pending, undefined);
});

test('verified download stages once, reports progress and restores pending metadata on next launch', async t => {
  const { supervisor } = localRuntimeFixture(t, '1.0.0');
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const launch = { schemaVersion: 1, product: 'keepwork-mcp-node-runtime', version: '2.0.0',
    platform: supervisor.platform, arch: supervisor.arch, entry: 'app/cli.cjs', commit: 'a'.repeat(40) };
  const archive = zipFixture({ 'runtime.json': JSON.stringify(launch), 'app/cli.cjs': 'fixture',
    [supervisor.platform === 'windows' ? 'node.exe' : 'bin/node']: 'fixture' });
  const remote = { ...manifest, ...launch, builtAt: '2026-10-20T00:00:00Z', size: archive.length,
    sha256: require('node:crypto').createHash('sha256').update(archive).digest('hex'),
    url: `${BASE}2.0.0/${supervisor.platform}-${supervisor.arch}.zip` };
  let archives = 0; const states = [];
  supervisor.options.onUpdate = value => states.push(value.state);
  global.fetch = async url => String(url).endsWith('.json') ? new Response(JSON.stringify(remote))
    : (archives++, new Response(archive));
  await Promise.all([supervisor.check(), supervisor.check()]);
  assert.equal(archives, 1);
  assert.equal(supervisor.record.pending, remote.sha256);
  assert.equal(supervisor.record.current, undefined);
  assert.equal(supervisor.updateSnapshot().progress, 100);
  assert.ok(states.includes('downloading')); assert.equal(states.at(-1), 'ready');
  const restored = new RuntimeSupervisor(supervisor.home, supervisor.bundled, '0.1.0');
  assert.equal(restored.updateSnapshot().pending.builtAt, remote.builtAt);
  assert.equal(restored.updateSnapshot().currentVersion, '1.0.0');
  await supervisor.check(); assert.equal(archives, 1);
});
