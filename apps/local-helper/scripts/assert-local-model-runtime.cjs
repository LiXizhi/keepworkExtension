const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function assertLocalModelRuntime(
  config = require('../electron-builder.config.cjs'),
  execFile = execFileSync,
) {
  const resources = config.extraResources || [];
  const resource = resources.find(item => item.to === 'local-model-runtime');
  if (!resource) throw new Error('KP_LOCAL_MODEL_RUNTIME_DIR is required for a Local Helper installer');
  const root = path.resolve(resource.from);
  const manifestPath = path.join(root, 'runtime.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1
    || manifest.product !== 'keepwork-local-model-node-runtime'
    || manifest.platform !== 'windows'
    || manifest.arch !== 'x64'
    || manifest.entry !== 'app/dist/src/cli.js') {
    throw new Error('local-model runtime manifest is incompatible with Windows x64 Local Helper');
  }
  for (const file of [
    'node.exe',
    manifest.entry,
    'app/configs/models/speaker-eres2net-base-zh-16k.yaml',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/model.onnx',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/manifest.json',
    'app/models/speaker-eres2net-base-zh-16k/1.0.1/checksums.json',
  ]) {
    if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`local-model runtime file is missing: ${file}`);
    }
  }
  const verification = JSON.parse(execFile(path.join(root, 'node.exe'), [
    path.join(root, manifest.entry),
    'models',
    'verify',
    'speaker-eres2net-base-zh-16k',
  ], {
    cwd: root,
    env: { ...process.env, LOCAL_MODEL_ROOT: path.join(root, 'app') },
    encoding: 'utf8',
    windowsHide: true,
  }));
  if (verification.ok !== true || verification.dimension !== 512) {
    throw new Error('local-model runtime failed signed package and embedding verification');
  }
  return root;
}

if (require.main === module) {
  try {
    process.stdout.write(`${assertLocalModelRuntime()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertLocalModelRuntime };
