const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneNodePty, validateTargetRuntime } = require('./stage-runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-target-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'app', 'node_modules', 'node-pty');
  for (const name of ['win32-x64', 'win32-arm64', 'darwin-x64']) {
    fs.mkdirSync(path.join(packageRoot, 'prebuilds', name), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'prebuilds', name, 'pty.node'), name);
  }
  for (const name of ['build', 'deps', 'scripts', 'src', 'third_party', 'typings']) fs.mkdirSync(path.join(packageRoot, name));
  fs.writeFileSync(path.join(packageRoot, 'prebuilds', 'win32-x64', 'pty.pdb'), 'debug');
  return root;
}

test('keeps only the target node-pty prebuild and runtime files', (t) => {
  const root = fixture(t);
  const target = { nodePlatform: 'win', arch: 'x64' };
  pruneNodePty(root + '/app', target);
  validateTargetRuntime(root, target);
  assert.deepEqual(fs.readdirSync(path.join(root, 'app/node_modules/node-pty/prebuilds')), ['win32-x64']);
  assert.ok(!fs.existsSync(path.join(root, 'app/node_modules/node-pty/prebuilds/win32-x64/pty.pdb')));
});

test('rejects foreign native files after staging', (t) => {
  const root = fixture(t);
  assert.throws(() => validateTargetRuntime(root, { nodePlatform: 'win', arch: 'x64' }), /foreign prebuilds/);
});
