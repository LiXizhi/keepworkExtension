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
