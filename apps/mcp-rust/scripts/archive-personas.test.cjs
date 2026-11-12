const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { createPlan, applyPlan, restoreArchive, withOfflineProfile } = require('./archive-personas.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const ownerGroup = owner => hash(owner);
const ownerA = hash('fixture-owner-obsolete-a');
const ownerB = hash('fixture-owner-obsolete-b');
const ownerCurrent = hash('fixture-owner-current');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-persona-archive-test-')));
  const profileDir = path.join(directory, '.keepwork-mcp');
  const store = path.join(profileDir, 'personas-v1');
  const brain = path.join(directory, 'brain');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(brain);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  function add(owner, overrides = {}) {
    const row = {
      owner, id: 'default-persona', name: '我的分身', avatar: '🧠', prompt: 'fixture instructions',
      root: brain, executor: 'auto', model: '', pinned: true, order: 0,
      messages: [], requests: {}, schedules: [], summary: '', readAt: 0,
      ...overrides,
    };
    const file = hash(`${row.owner}\0${row.id}`) + '.json';
    const bytes = Buffer.from(JSON.stringify(row, null, 2) + '\n');
    fs.writeFileSync(path.join(store, file), bytes);
    return { file, bytes, row };
  }
  function bindings(rows) {
    const directory = path.join(profileDir, 'messaging-v1');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'bindings.json'), JSON.stringify(rows));
  }
  function plan(obsolete = [ownerA], protectedOwners = [ownerCurrent]) {
    return createPlan(profileDir, obsolete.map(ownerGroup), protectedOwners.map(ownerGroup));
  }
  return { directory, profileDir, store, add, bindings, plan };
}

function storeBytes(store) {
  return Object.fromEntries(fs.readdirSync(store).sort().map(file => [file, fs.readFileSync(path.join(store, file))]));
}

test('planning is read-only and only selects explicit obsolete identities with a retained peer', t => {
  const f = fixture(t);
  const old = f.add(ownerA);
  const current = f.add(ownerCurrent);
  const unknown = f.add(hash('unclassified-owner'));
  const unique = f.add(ownerA, { id: 'unique-agent', name: 'Unique', prompt: 'unique instructions' });
  const before = storeBytes(f.store);
  const plan = f.plan();
  assert.equal(plan.version, 1);
  assert.equal(plan.profileDir, f.profileDir);
  assert.match(plan.storeDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(plan.candidates[0], {
    file: old.file, sha256: hash(old.bytes), retainedFile: current.file, retainedSha256: hash(current.bytes),
  });
  for (const kept of [current, unknown, unique]) {
    assert.ok(plan.kept.some(item => item.file === kept.file && typeof item.reason === 'string'));
  }
  assert.deepEqual(storeBytes(f.store), before);
  assert.ok(!fs.existsSync(path.join(f.profileDir, 'persona-archives')));
  const serialized = JSON.stringify(plan);
  for (const owner of [ownerA, ownerCurrent, unknown.row.owner]) assert.ok(!serialized.includes(owner));
});

test('an identity marked protected takes precedence over obsolete selection', t => {
  const f = fixture(t);
  f.add(ownerA);
  f.add(ownerCurrent);
  assert.equal(f.plan([ownerA], [ownerA, ownerCurrent]).candidates.length, 0);
});

test('multiple obsolete copies use a peer outside the entire selected set', t => {
  const f = fixture(t);
  const a = f.add(ownerA);
  const b = f.add(ownerB);
  const current = f.add(ownerCurrent);
  const plan = f.plan([ownerA, ownerB]);
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(new Set(plan.candidates.map(item => item.file)), new Set([a.file, b.file]));
  assert.ok(plan.candidates.every(item => item.retainedFile === current.file));
});

test('a group with no protected peer retains at least one equivalent configuration', t => {
  const f = fixture(t);
  f.add(ownerA);
  f.add(ownerB);
  const plan = f.plan([ownerA, ownerB], []);
  assert.equal(plan.candidates.length, 1);
  assert.notEqual(plan.candidates[0].file, plan.candidates[0].retainedFile);
  assert.ok(plan.kept.some(item => item.file === plan.candidates[0].retainedFile));
});

test('a different configuration cannot be used as the retained peer', t => {
  const f = fixture(t);
  f.add(ownerA, { prompt: 'instructions only present in this old identity' });
  f.add(ownerCurrent);
  assert.equal(f.plan().candidates.length, 0);
});

const protectedStates = {
  messages: { messages: [{ id: 'message', role: 'user', text: 'preserve me', time: 1 }] },
  requests: { requests: { 'accepted-request': 'accepted' } },
  schedules: { schedules: [{ id: 'schedule', enabled: false }] },
  summary: { summary: 'past conversation summary' },
  job: { job: { state: 'done' } },
  'null job': { job: null },
  sales: { sales: {} },
  approval: { approval: {} },
  'enabled messaging': { messaging: { version: 1, enabled: true, groups: [] } },
  'disabled messaging with groups': { messaging: { version: 1, enabled: false, groups: [{ id: 'group' }] } },
  'unknown field': { futureRuntimeState: {} },
};
for (const [label, state] of Object.entries(protectedStates)) {
  test(`planning protects records containing ${label}`, t => {
    const f = fixture(t);
    const old = f.add(ownerA, state);
    f.add(ownerCurrent);
    const plan = f.plan();
    assert.equal(plan.candidates.length, 0);
    assert.ok(plan.kept.some(item => item.file === old.file));
  });
}

for (const kind of ['direct', 'peer']) {
  test(`planning protects ${kind} references in stopped messaging bindings`, t => {
    const f = fixture(t);
    const old = f.add(ownerA);
    f.add(ownerCurrent);
    const reference = kind === 'direct'
      ? { agentOwner: ownerA, agentId: 'default-persona' }
      : { agentOwner: ownerCurrent, agentId: 'default-persona', peers: [{ owner: ownerA, agentId: 'default-persona' }] };
    f.bindings([{ id: 'stopped-binding', enabled: false, status: 'stopped', ...reference }]);
    const plan = f.plan();
    assert.equal(plan.candidates.length, 0);
    assert.ok(plan.kept.some(item => item.file === old.file));
  });
}

test('archive and restore preserve exact bytes and leave retained records intact', t => {
  const f = fixture(t);
  const old = f.add(ownerA, { messaging: { version: 1, enabled: false, groups: [] } });
  const current = f.add(ownerCurrent, { messaging: { version: 1, enabled: false, groups: [] } });
  const before = storeBytes(f.store);
  const result = applyPlan(f.plan());
  assert.equal(result.archived, 1);
  assert.equal(result.retained, 1);
  assert.equal(path.dirname(result.archiveDir), path.join(f.profileDir, 'persona-archives'));
  assert.ok(fs.existsSync(path.join(result.archiveDir, 'manifest.json')));
  assert.deepEqual(fs.readFileSync(path.join(result.archiveDir, 'files', old.file)), old.bytes);
  assert.ok(!fs.existsSync(path.join(f.store, old.file)));
  assert.deepEqual(fs.readFileSync(path.join(f.store, current.file)), current.bytes);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(result.archiveDir, 'manifest.json')).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(result.archiveDir, 'files', old.file)).mode & 0o077, 0);
  }
  const restored = restoreArchive(result.archiveDir);
  assert.equal(restored.restored, 1);
  assert.deepEqual(storeBytes(f.store), before);
});

for (const changed of ['source', 'peer', 'unrelated record', 'bindings']) {
  test(`apply rejects a plan after ${changed} changes without moving any records`, t => {
    const f = fixture(t);
    const old = f.add(ownerA);
    const current = f.add(ownerCurrent);
    const unrelated = f.add(hash('unrelated-owner'), { id: 'another-agent', name: 'Another' });
    f.bindings([]);
    const plan = f.plan();
    if (changed === 'bindings') {
      f.bindings([{ id: 'new-binding', agentOwner: ownerA, agentId: 'default-persona' }]);
    } else {
      const record = changed === 'source' ? old : changed === 'peer' ? current : unrelated;
      fs.appendFileSync(path.join(f.store, record.file), '\n');
    }
    const before = storeBytes(f.store);
    assert.throws(() => applyPlan(plan));
    assert.deepEqual(storeBytes(f.store), before);
  });
}

test('apply rejects malformed or path-traversing plans without moving records', t => {
  const f = fixture(t);
  f.add(ownerA);
  f.add(ownerCurrent);
  const plan = f.plan();
  const before = storeBytes(f.store);
  assert.throws(() => applyPlan({}));
  for (const file of ['../outside.json', path.join(f.directory, 'outside.json')]) {
    const changed = JSON.parse(JSON.stringify(plan));
    changed.candidates[0].file = file;
    assert.throws(() => applyPlan(changed));
  }
  const changed = JSON.parse(JSON.stringify(plan));
  changed.candidates[0].retainedFile = changed.candidates[0].file;
  assert.throws(() => applyPlan(changed));
  assert.deepEqual(storeBytes(f.store), before);
});

test('apply refuses a source replaced by a symbolic link', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const old = f.add(ownerA);
  f.add(ownerCurrent);
  const plan = f.plan();
  const outside = path.join(f.directory, 'outside.json');
  fs.writeFileSync(outside, old.bytes);
  fs.unlinkSync(path.join(f.store, old.file));
  fs.symlinkSync(outside, path.join(f.store, old.file));
  assert.throws(() => applyPlan(plan));
  assert.deepEqual(fs.readFileSync(outside), old.bytes);
  assert.ok(fs.lstatSync(path.join(f.store, old.file)).isSymbolicLink());
});

test('restore rejects a destination conflict and preserves both copies', t => {
  const f = fixture(t);
  const old = f.add(ownerA);
  f.add(ownerCurrent);
  const result = applyPlan(f.plan());
  const conflict = Buffer.from('{"new":"user data after archive"}\n');
  fs.writeFileSync(path.join(f.store, old.file), conflict);
  assert.throws(() => restoreArchive(result.archiveDir));
  assert.deepEqual(fs.readFileSync(path.join(f.store, old.file)), conflict);
  assert.deepEqual(fs.readFileSync(path.join(result.archiveDir, 'files', old.file)), old.bytes);
});

test('restore resumes after an identical record was already restored without overwriting it', t => {
  const f = fixture(t);
  const oldA = f.add(ownerA);
  const oldB = f.add(ownerB);
  f.add(ownerCurrent);
  const original = storeBytes(f.store);
  const result = applyPlan(f.plan([ownerA, ownerB]));
  const alreadyRestored = path.join(f.store, oldA.file);
  fs.writeFileSync(alreadyRestored, oldA.bytes);
  const before = fs.statSync(alreadyRestored);
  assert.equal(restoreArchive(result.archiveDir).restored, 1);
  assert.deepEqual(storeBytes(f.store), original);
  assert.equal(fs.statSync(alreadyRestored).ino, before.ino);
  assert.equal(fs.statSync(alreadyRestored).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readFileSync(path.join(result.archiveDir, 'files', oldB.file)), oldB.bytes);
  assert.equal(restoreArchive(result.archiveDir).restored, 0);
});

test('separate fresh plans support a second archive batch and independent restoration', t => {
  const f = fixture(t);
  f.add(ownerA);
  f.add(ownerB);
  f.add(ownerCurrent);
  const original = storeBytes(f.store);
  const first = applyPlan(f.plan([ownerA]));
  const second = applyPlan(f.plan([ownerB]));
  assert.equal(first.archived, 1);
  assert.equal(second.archived, 1);
  assert.notEqual(first.archiveDir, second.archiveDir);
  assert.equal(fs.readdirSync(f.store).length, 1);
  assert.equal(restoreArchive(first.archiveDir).restored, 1);
  assert.equal(restoreArchive(second.archiveDir).restored, 1);
  assert.deepEqual(storeBytes(f.store), original);
});

test('offline guard refuses a profile whose recorded daemon PID is alive', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.profileDir, 'instance.json'), JSON.stringify({
    pid: process.pid, port: 8089, name: 'keepwork-mcp',
  }));
  let called = false;
  await assert.rejects(async () => withOfflineProfile(f.profileDir, () => { called = true; }));
  assert.equal(called, false);
});

test('offline guard refuses an occupied configured TCP port and removes its maintenance lock', {
  skip: process.env.KEEPWORK_ARCHIVE_NETWORK_TEST !== '1',
}, async t => {
  const f = fixture(t);
  const listener = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port;
  fs.writeFileSync(path.join(f.profileDir, 'config.json'), JSON.stringify({ port }));
  let called = false;
  await assert.rejects(async () => withOfflineProfile(f.profileDir, () => { called = true; }));
  assert.equal(called, false);
  assert.ok(!fs.existsSync(path.join(f.profileDir, 'persona-maintenance.lock')));
});
