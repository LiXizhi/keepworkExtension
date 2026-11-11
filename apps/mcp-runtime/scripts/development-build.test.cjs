const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const builder = path.join(__dirname, 'build.mjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-development-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function build(args) { return spawnSync(process.execPath, [builder, ...args], { encoding: 'utf8' }); }

test('custom output cannot weaken the release build or create an unrequested output', t => {
  const directory = fixture(t), output = path.join(directory, 'must-not-exist');
  const result = build(['--outdir', output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--outdir requires --development/);
  assert.equal(fs.existsSync(output), false);
});

test('custom development output requires an explicit value', () => {
  for (const args of [['--development', '--outdir'], ['--development', '--outdir', '--unexpected']]) {
    const result = build(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--outdir requires --development and an explicit output directory/);
  }
});

test('custom development output never deletes an existing directory', t => {
  const output = fixture(t), sentinel = path.join(output, 'active-runtime.txt');
  fs.writeFileSync(sentinel, 'a running runtime still owns these files');
  const result = build(['--development', '--outdir', output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--outdir must name a new directory/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'a running runtime still owns these files');
});
