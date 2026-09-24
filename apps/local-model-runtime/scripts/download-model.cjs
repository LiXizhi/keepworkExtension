const { createWriteStream } = require('node:fs');
const { mkdir, readFile, rename, stat, unlink } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const YAML = require('yaml');

const projectRoot = path.resolve(__dirname, '..');
const defaultModelId = 'speaker-eres2net-base-zh-16k';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function loadModelConfig(modelId) {
  const configPath = path.join(projectRoot, 'configs', 'models', `${modelId}.yaml`);
  return YAML.parse(await readFile(configPath, 'utf8'));
}

async function describeExisting(target, modelId) {
  try {
    const file = await stat(target);
    const hash = await sha256File(target);
    process.stdout.write(`${JSON.stringify({ modelId, path: target, bytes: file.size, sha256: hash, installed: true })}\n`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const modelId = process.argv[2] || defaultModelId;
  const config = await loadModelConfig(modelId);
  const target = path.join(projectRoot, config.artifact.path);
  const url = process.env.LOCAL_MODEL_ARTIFACT_URL;

  if (!url) {
    if (await describeExisting(target, modelId)) return;
    throw new Error('LOCAL_MODEL_ARTIFACT_URL must point to the exact artifact pinned by the model configuration');
  }

  const temporary = `${target}.part`;
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o644 }));
    const file = await stat(temporary);
    const hash = await sha256File(temporary);
    if (hash !== config.artifact.sha256) throw new Error(`Downloaded SHA-256 mismatch: ${hash}`);
    if (file.size !== config.artifact.bytes) throw new Error(`Downloaded size mismatch: ${file.size}`);
    await rename(temporary, target);
    process.stdout.write(`${JSON.stringify({ modelId, path: target, bytes: file.size, sha256: hash, installed: true })}\n`);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
