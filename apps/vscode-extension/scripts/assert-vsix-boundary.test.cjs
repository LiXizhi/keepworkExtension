const assert = require('node:assert/strict');
const test = require('node:test');
const { assertEntry } = require('./assert-vsix-boundary.cjs');

test('VSIX boundary rejects native model code and artifacts', () => {
  for (const entry of [
    'extension/node_modules/sherpa-onnx-node/index.js',
    'extension/models/speaker/model.onnx',
    'extension/local-model-runtime/runtime.json',
    'extension/configs/speaker-eres2net-base.yaml',
  ]) {
    assert.throws(() => assertEntry(entry), /forbidden local-model resource/);
  }
  assert.doesNotThrow(() => assertEntry('extension/dist/extension.js'));
});
