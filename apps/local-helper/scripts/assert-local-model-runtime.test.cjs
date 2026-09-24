const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertLocalModelRuntime } = require('./assert-local-model-runtime.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-model-resource-'));
  const manifest = {
    schemaVersion: 1,
    product: 'keepwork-local-model-node-runtime',
    platform: 'windows',
    arch: 'x64',
    entry: 'app/dist/src/cli.js',
  };
  const files = [
    'node.exe',
    manifest.entry,
    'app/configs/models/speaker-eres2net-base-zh-16k.yaml',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/model.onnx',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/manifest.json',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/checksums.json',
  ];
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(manifest));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

test('requires a complete Windows x64 local-model resource', () => {
  const root = fixture();
  try {
    const config = { extraResources: [{ from: root, to: 'local-model-runtime' }] };
    let verificationCall;
    const verify = (command, args, options) => {
      verificationCall = { command, args, options };
      return JSON.stringify({ ok: true, dimension: 512 });
    };
    assert.equal(assertLocalModelRuntime(config, verify), root);
    assert.equal(verificationCall.command, path.join(root, 'node.exe'));
    assert.deepEqual(verificationCall.args.slice(-3), ['models', 'verify', 'speaker-eres2net-base-zh-16k']);
    assert.equal(verificationCall.options.env.LOCAL_MODEL_ROOT, path.join(root, 'app'));
    fs.rmSync(path.join(root, 'node.exe'));
    assert.throws(() => assertLocalModelRuntime(config, verify), /node\.exe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects installer configuration without local-model resources', () => {
  assert.throws(() => assertLocalModelRuntime({ extraResources: [] }, () => ''), /KP_LOCAL_MODEL_RUNTIME_DIR is required/);
});
