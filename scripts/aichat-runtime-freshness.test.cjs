const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncRuntime } = require('./sync-aichat-runtime.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-freshness-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const repo = path.join(root, 'AIChat'), source = path.join(repo, 'runtime'), dest = path.join(root, 'vendor');
  fs.mkdirSync(source, {recursive:true});
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  execFileSync('git', ['init', '--bare', '-q', path.join(root, 'remote')]);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const commit = value => {
    fs.writeFileSync(path.join(source, 'agent.mjs'), `export const value = ${value};\n`);
    git('add', '.'); git('commit', '-qm', `Runtime ${value}`); return git('rev-parse', 'HEAD');
  };
  const first = commit(1);
  git('remote', 'add', 'origin', path.join(root, 'remote')); git('push', '-qu', 'origin', 'main');
  const options = {source, dest};
  syncRuntime(options);
  const snapshot = () => fs.readdirSync(dest).sort().map(f => [f, fs.readFileSync(path.join(dest,f),'utf8')]);
  return {options, git, commit, first, snapshot};
}
test('fetches upstream and blocks stale, diverged, dirty or unreachable source without changing packaged files', t => {
  const f = fixture(t), {options, git, commit, first} = f;
  const second = commit(2); git('push', '-q');
  // FETCH_HEAD must come from an actual fetch, not an obsolete tracking ref.
  git('reset', '--hard', first); git('update-ref', 'refs/remotes/origin/main', first);
  const original = f.snapshot();
  commit(3);
  assert.throws(() => syncRuntime(options), /behind or diverged/);
  assert.deepEqual(f.snapshot(), original);
  git('reset', '--hard', first);
  // Equal bytes are safe; no overwrite or provenance downgrade takes place.
  syncRuntime(options);
  git('reset', '--hard', second); syncRuntime(options);
  const newer = f.snapshot();
  git('reset', '--hard', first);
  assert.throws(() => syncRuntime(options), /behind or diverged/);
  assert.deepEqual(f.snapshot(), newer);
  // Even if upstream was rewound, the recorded packaged revision prevents downgrade.
  git('push', '--force', '-q', 'origin', 'main');
  assert.throws(() => syncRuntime(options), /packaged source revision/);
  assert.deepEqual(f.snapshot(), newer);
  git('reset', '--hard', second);
  fs.appendFileSync(path.join(options.source, 'agent.mjs'), '// local edits');
  assert.throws(() => syncRuntime(options), /uncommitted/);
  assert.deepEqual(f.snapshot(), newer);
  git('reset', '--hard', second); commit(4);
  git('remote', 'set-url', 'origin', path.join(options.source, 'nonexistent'));
  assert.throws(() => syncRuntime(options), /freshness/);
  assert.deepEqual(f.snapshot(), newer);
});
test('new clean commits sync; legacy copies need matching provenance before replacement', t => {
  const f = fixture(t);
  f.commit(2); // A locally committed successor of current upstream is allowed.
  syncRuntime(f.options);
  const manifestPath = path.join(f.options.dest, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  delete manifest.sourceRevision; fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2)+'\n');
  f.commit(3);
  assert.throws(() => syncRuntime(f.options), /no committed source provenance/);
  f.git('reset', '--hard', 'HEAD~1');
  syncRuntime(f.options); // Exact bytes safely establish provenance.
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).sourceRevision.dirty, false);
});
