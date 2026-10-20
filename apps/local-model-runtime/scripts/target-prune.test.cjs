const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneNativeDependencies, validateNativeDependencies } = require('./runtime-stage.cjs');

test('keeps the sherpa wrapper and only the target native package', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-target-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeModules = path.join(root, 'node_modules');
  for (const name of ['sherpa-onnx-node', 'sherpa-onnx-win-x64', 'sherpa-onnx-win-ia32', 'sherpa-onnx-darwin-arm64']) {
    fs.mkdirSync(path.join(nodeModules, name), { recursive: true });
  }
  pruneNativeDependencies(root, { nodePlatform: 'win', arch: 'x64' });
  validateNativeDependencies(root, { nodePlatform: 'win', arch: 'x64' });
  assert.deepEqual(fs.readdirSync(nodeModules).sort(), ['sherpa-onnx-node', 'sherpa-onnx-win-x64']);
});

test('rejects foreign sherpa packages after staging', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-target-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeModules = path.join(root, 'node_modules');
  for (const name of ['sherpa-onnx-win-ia32', 'sherpa-onnx-linux-ppc64']) {
    fs.mkdirSync(path.join(nodeModules, name), { recursive: true });
  }
  assert.throws(() => validateNativeDependencies(root, { nodePlatform: 'win', arch: 'x64' }), /foreign sherpa packages/);
});
