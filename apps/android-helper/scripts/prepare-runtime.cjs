#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const source = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-source.json'), 'utf8'));
const modelRoot = path.resolve(appRoot, source.model.source);
const generatedRoot = path.join(appRoot, 'app', 'src', 'generated');
const assetsRoot = path.join(generatedRoot, 'assets', 'local-model');
const jniRoot = path.join(generatedRoot, 'jniLibs', 'arm64-v8a');
const cacheRoot = path.join(appRoot, '.cache');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSafeArchiveEntry(entry) {
  const normalized = String(entry).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe sherpa archive entry: ${entry}`);
  }
  if (normalized.split('/').some(part => part === '..')) throw new Error(`Unsafe sherpa archive entry: ${entry}`);
  return normalized;
}

function selectNativeEntries(entries, abi = 'arm64-v8a') {
  const safe = entries.map(assertSafeArchiveEntry);
  const find = name => {
    const matches = safe.filter(entry => entry.includes(`/${abi}/`) && entry.endsWith(`/${name}`));
    if (matches.length !== 1) throw new Error(`Expected one ${abi} ${name}, found ${matches.length}`);
    return matches[0];
  };
  return {
    'libsherpa-onnx-jni.so': find('libsherpa-onnx-jni.so'),
    'libonnxruntime.so': find('libonnxruntime.so'),
  };
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'kp-android-helper-build' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Unable to download sherpa-onnx: HTTP ${response.statusCode}`));
        return;
      }
      const temporary = `${target}.part`;
      const output = fs.createWriteStream(temporary, { flags: 'w', mode: 0o600 });
      response.pipe(output);
      output.on('finish', () => {
        output.close(() => {
          fs.renameSync(temporary, target);
          resolve();
        });
      });
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function ensureSherpaArchive() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, `sherpa-onnx-${source.sherpaOnnx.version}-android.tar.bz2`);
  if (fs.statSync(target, { throwIfNoEntry: false })?.isFile()
      && fs.statSync(target).size === source.sherpaOnnx.size
      && sha256File(target) === source.sherpaOnnx.sha256) return target;
  if (fs.existsSync(target)) fs.rmSync(target);
  await download(source.sherpaOnnx.url, target);
  if (fs.statSync(target).size !== source.sherpaOnnx.size || sha256File(target) !== source.sherpaOnnx.sha256) {
    throw new Error('Downloaded sherpa-onnx archive failed size or SHA-256 verification');
  }
  return target;
}

function loadModelConfig(configPath) {
  const yamlModule = path.join(modelRoot, 'node_modules', 'yaml');
  if (!fs.existsSync(yamlModule)) {
    throw new Error('Install apps/local-model-runtime dependencies before preparing Android runtime');
  }
  return require(yamlModule).parse(fs.readFileSync(configPath, 'utf8'));
}

function verifyAndCopyModel() {
  const relativePackage = path.join('models', source.model.id, source.model.version);
  const packageRoot = path.join(modelRoot, relativePackage);
  const configPath = path.join(modelRoot, 'configs', 'models', `${source.model.id}.yaml`);
  const config = loadModelConfig(configPath);
  const manifestPath = path.join(packageRoot, 'manifest.json');
  const checksumsPath = path.join(packageRoot, 'checksums.json');
  const keyPath = path.join(modelRoot, config.artifact.publicKey);
  const modelPath = path.join(modelRoot, config.artifact.path);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const checksums = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
  const { signature, ...unsigned } = manifest;

  if (config.identity.id !== source.model.id || config.identity.version !== source.model.version) {
    throw new Error('Android model source does not match runtime-source.json');
  }
  if (fs.statSync(modelPath).size !== config.artifact.bytes || sha256File(modelPath) !== config.artifact.sha256) {
    throw new Error('Android model artifact failed source integrity verification');
  }
  if (manifest.configSha256 !== sha256Buffer(canonicalize(config))) {
    throw new Error('Android model config does not match the signed manifest');
  }
  if (!crypto.verify(null, Buffer.from(canonicalize(unsigned)), crypto.createPublicKey(fs.readFileSync(keyPath)), Buffer.from(signature.value, 'base64'))) {
    throw new Error('Android model manifest signature verification failed');
  }
  for (const [name, expected] of Object.entries(checksums.files || {})) {
    const file = path.join(packageRoot, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile() || sha256File(file) !== expected) {
      throw new Error(`Android model package checksum failed: ${name}`);
    }
  }

  fs.mkdirSync(assetsRoot, { recursive: true });
  const copies = [
    [modelPath, 'model.onnx'],
    [manifestPath, 'manifest.json'],
    [checksumsPath, 'checksums.json'],
    [keyPath, 'model-signing-public.pem'],
    [path.join(packageRoot, 'LICENSE'), 'LICENSE'],
    [path.join(packageRoot, 'README.md'), 'README.md'],
  ];
  for (const [from, name] of copies) fs.copyFileSync(from, path.join(assetsRoot, name));
  fs.writeFileSync(path.join(assetsRoot, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  const archive = await ensureSherpaArchive();
  const entries = execFileSync('tar', ['-tjf', archive], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    .split(/\r?\n/).filter(Boolean);
  const selectedByAbi = {
    'arm64-v8a': selectNativeEntries(entries, 'arm64-v8a'),
    'x86_64': selectNativeEntries(entries, 'x86_64'),
  };
  fs.rmSync(generatedRoot, { recursive: true, force: true });
  for (const [abi, selected] of Object.entries(selectedByAbi)) {
    const abiRoot = path.join(generatedRoot, 'jniLibs', abi);
    fs.mkdirSync(abiRoot, { recursive: true });
    for (const [name, entry] of Object.entries(selected)) {
      const data = execFileSync('tar', ['-xOjf', archive, entry], { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
      if (!data.length) throw new Error(`Extracted native library is empty: ${entry}`);
      fs.writeFileSync(path.join(abiRoot, name), data, { mode: 0o755 });
    }
  }
  verifyAndCopyModel();
  fs.writeFileSync(path.join(assetsRoot, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'kp-local-helper-android',
    platform: 'android',
    arch: 'arm64-v8a',
    capabilities: ['mcp', 'local-model'],
    localModelProtocolVersion: '1.0.0',
    sherpaOnnxVersion: source.sherpaOnnx.version,
    modelId: source.model.id,
    modelVersion: source.model.version,
  }, null, 2)}\n`);
  process.stdout.write(`Prepared Android runtime in ${path.relative(repoRoot, generatedRoot)}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

module.exports = { assertSafeArchiveEntry, canonicalize, selectNativeEntries, sha256Buffer };
