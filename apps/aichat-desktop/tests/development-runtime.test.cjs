const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RuntimeSupervisor } = require('../src/runtime.cjs');
const { buildDevelopment } = require('../scripts/start-development.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function fixture(t, healths) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-dev-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 222, exitCode: null, signalCode: null,
    kill() { this.exitCode = 0; this.emit('exit', 0); } });
  const s = new RuntimeSupervisor(home, '/missing-staged-runtime', '1.0.0', {
    probe: async () => healths.shift() ?? null,
    stopExisting: async () => { calls.push('stop'); }, delay: async () => {},
    spawn: (node, args) => { calls.push({ node, args }); return child; },
  }, { updates: false, development: { node: process.execPath, entry: __filename } });
  s.record = { current: 'a'.repeat(64), pending: 'b'.repeat(64) };
  return { s, calls, child };
}
const old = { compatible: true, pid: 111, runtimeVersion: '99.0.0' };
const fresh = { compatible: true, pid: 222, runtimeVersion: '0.1.0' };
test('development replaces even newer daemon, launches exact rebuilt entry, ignores cached candidates', async t => {
  const { s, calls } = fixture(t, [old, old, null, fresh]);
  await s.start();
  assert.equal(s.state.state, 'running');
  assert.equal(calls[0], 'stop');
  assert.deepEqual(calls[1], { node: process.execPath, args: [__filename, '--port', '8089'] });
  await s.checkMetadata();
  assert.equal(s.record.pending, 'b'.repeat(64));
  await s.stop();
});
test('conflicting service and changed daemon identity are never stopped or launched over', async t => {
  for (const healths of [[{ compatible: false, pid: 999 }], [old, { ...old, pid: 333 }]]) {
    const { s, calls } = fixture(t, healths);
    await assert.rejects(s.start(), /another service|changed/);
    assert.deepEqual(calls, []);
  }
});
test('rejected stop aborts; readiness from a different PID never attaches or falls back', async t => {
  const blocked = fixture(t, [old, old]);
  blocked.s.deps.stopExisting = async () => { throw new Error('HTTP 401'); };
  await assert.rejects(blocked.s.start(), /401/);
  assert.deepEqual(blocked.calls, []);
  const mismatch = fixture(t, [null, old]);
  await assert.rejects(mismatch.s.start(), /PID mismatch/);
  assert.equal(mismatch.child.exitCode, 0);
  assert.equal(mismatch.s.state.state, 'error');
  assert.equal(mismatch.calls.length, 1);
});
test('both builds run in order and build failures prevent subsequent startup work', () => {
  const calls = [];
  buildDevelopment((node, args) => calls.push(args));
  assert.match(calls[0][0], /mcp-runtime[/\\]scripts[/\\]build.mjs$/);
  assert.deepEqual(calls[0].slice(1), ['--development']);
  assert.match(calls[1][0], /aichat-desktop[/\\]scripts[/\\]build.mjs$/);
  assert.deepEqual(calls[1].slice(1), []);
  let count = 0;
  assert.throws(() => buildDevelopment(() => { count++; throw Error('build failed'); }), /build failed/);
  assert.equal(count, 1);
});
