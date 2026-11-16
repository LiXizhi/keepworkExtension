const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

const observer = path.join(__dirname, 'fixtures', 'lifecycle-observer.cjs');
const harness = path.join(__dirname, 'harness.cjs');

function readJournal(journal) {
  try { return fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function observedPids(records) {
  const pids = new Set(records.filter(row => row.kind === 'process').map(row => row.pid));
  for (const row of records.filter(row => row.kind === 'directory')) {
    const log = path.join(row.directory, 'native.log');
    if (!fs.existsSync(log)) continue;
    for (const line of fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)) {
      pids.add(JSON.parse(line).pid);
    }
  }
  return [...pids];
}

async function subprocess(t, args, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-lifecycle-regression-'));
  const journal = path.join(directory, 'journal.jsonl');
  t.after(async () => {
    const records = readJournal(journal);
    // A broken teardown must fail the test without leaking our fixtures into
    // later suites. These PIDs and directories all came from this subprocess.
    for (const pid of observedPids(records)) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); }
        catch (error) { if (alive(pid)) throw error; }
      } else {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    for (const row of records.filter(row => row.kind === 'directory')) {
      await fs.promises.rm(row.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const childEnv = { ...process.env, KEEPWORK_LIFECYCLE_JOURNAL: journal, ...env };
  // This is a fresh test runner, not a worker recursively invoking its parent.
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--require', observer, ...args], {
    cwd: h.repoRoot,
    env: childEnv,
    encoding: 'utf8', timeout: 20_000,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, `subprocess must finish without a timeout:\n${result.error}\n${output}`);
  assert.equal(result.signal, null, output);
  return { result, output, records: readJournal(journal) };
}

test('workspace cleanup failure still stops the Cursor fixture and daemon and exits with failure', async t => {
  const { result, output, records } = await subprocess(t, [
    '--test', '--test-name-pattern=^Cursor authentication metadata refresh leaves',
    path.join(__dirname, 'agents-auth.test.cjs'),
  ], { KEEPWORK_LIFECYCLE_LOCK_WORKSPACE: '1' });
  assert.equal(result.status, 1, output);
  assert.match(output, /EBUSY: injected workspace cleanup failure/);
  assert.match(output, /failureType: 'hookFailed'/);
  const pids = observedPids(records);
  assert.ok(records.some(row => row.kind === 'process' && /keepwork-mcp(?:\.exe)?$/.test(row.command)),
    'the regression must have started an actual test daemon');
  const workspace = records.find(row => row.kind === 'directory' && path.basename(row.directory).startsWith('kp-cursor-auth-'));
  assert.ok(workspace, 'the injected workspace must be observed');
  const native = fs.readFileSync(path.join(workspace.directory, 'native.log'), 'utf8');
  assert.match(native, /session\/prompt/, 'the regression must exercise an owned native CLI session');
  for (const pid of pids) assert.equal(alive(pid), false, `test-owned process ${pid} survived the failed cleanup`);
  for (const row of records.filter(row => row.kind === 'directory' && path.basename(row.directory).startsWith('kp-contract-'))) {
    assert.equal(fs.existsSync(row.directory), false, 'daemon HOME must be removed before workspace failure');
  }
});

test('authenticated daemon stop is repeatable and removes its HOME after exiting', async t => {
  const { result, output, records } = await subprocess(t, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const h = require(${JSON.stringify(harness)});
    (async () => {
      const daemon = await h.startRust({ requireAuth: true });
      try {
        assert.equal(daemon.health.requireAuth, true);
        await Promise.all([daemon.stop(), daemon.stop()]);
        await daemon.stop();
        assert.equal(fs.existsSync(daemon.home), false);
        await assert.rejects(fetch(daemon.base + '/health', { signal: AbortSignal.timeout(1000) }));
      } finally { await daemon.stop(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `]);
  assert.equal(result.status, 0, output);
  assert.ok(records.some(row => row.kind === 'directory'), 'an isolated daemon HOME must have been created');
  for (const pid of observedPids(records)) assert.equal(alive(pid), false, `test daemon ${pid} survived stop`);
});

test('daemon spawn failure rejects and removes its isolated HOME', async t => {
  const { result, output, records } = await subprocess(t, ['-e', `
    const assert = require('node:assert/strict');
    const h = require(${JSON.stringify(harness)});
    // An existing directory passes path-existence validation but cannot execute.
    h.startRust().then(() => { throw new Error('expected a spawn failure'); }, error => {
      assert.match(String(error), /spawn|EACCES|ENOENT|ENOTDIR|EPERM|exited/i);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `], { KEEPWORK_MCP_TEST_BIN: __dirname });
  assert.equal(result.status, 0, output);
  const homes = records.filter(row => row.kind === 'directory');
  assert.equal(homes.length, 1, 'spawn failure must occur after HOME allocation');
  assert.equal(fs.existsSync(homes[0].directory), false, 'startup failure must remove the allocated HOME');
});

test('caller-owned profile survives repeatable stop and restart on the same port', async t => {
  const { result, output, records } = await subprocess(t, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const h = require(${JSON.stringify(harness)});
    (async () => {
      const home = h.isolatedHome(), port = await h.freePort();
      const sentinel = path.join(home, 'legacy-registry.json');
      fs.writeFileSync(sentinel, '{"legacy":true}');
      let daemon;
      try {
        daemon = await h.startRust({ home, port });
        const pid = daemon.health.pid, base = daemon.base;
        await Promise.all([daemon.stop(), daemon.stop()]);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"legacy":true}');
        daemon = await h.startRust({ home, port });
        assert.equal(daemon.base, base);
        assert.notEqual(daemon.health.pid, pid);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"legacy":true}');
      } finally {
        await daemon?.stop();
        await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `]);
  assert.equal(result.status, 0, output);
  assert.equal(records.filter(row => row.kind === 'directory').length, 1, 'only the caller allocates the profile');
  assert.equal(records.filter(row => row.kind === 'process').length, 2, 'the fixture must restart its daemon');
  for (const pid of observedPids(records)) assert.equal(alive(pid), false, `test daemon ${pid} survived stop/restart`);
  for (const row of records.filter(row => row.kind === 'directory')) assert.equal(fs.existsSync(row.directory), false);
});
