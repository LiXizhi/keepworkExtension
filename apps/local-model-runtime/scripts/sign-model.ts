import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModelConfigs } from '../src/core/config.js';
import { canonicalize } from '../src/core/canonicalJson.js';
import { manifestPayload, sha256File, sha256Text } from '../src/core/integrity.js';
import { fromProjectRoot, projectRoot } from '../src/core/paths.js';
import type { SignedManifest } from '../src/core/types.js';

const PRIVATE_KEY_PATH = path.join(projectRoot, '.keys', 'model-signing-private.pem');

async function signingKeys(generateDevKey: boolean): Promise<{ privateKey: string; publicKey: string }> {
  const configuredPrivateKey = process.env.LOCAL_MODEL_SIGNING_KEY;
  if (configuredPrivateKey) {
    const privateKey = await readFile(path.resolve(configuredPrivateKey), 'utf8');
    const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }).toString();
    return { privateKey, publicKey };
  }
  try {
    const privateKey = await readFile(PRIVATE_KEY_PATH, 'utf8');
    const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }).toString();
    return { privateKey, publicKey };
  } catch {
    if (!generateDevKey) {
      throw new Error('No signing key found. Set LOCAL_MODEL_SIGNING_KEY or pass --generate-dev-key.');
    }
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await mkdir(path.dirname(PRIVATE_KEY_PATH), { recursive: true });
    await writeFile(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
    return { privateKey, publicKey };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requestedId = args.find(value => !value.startsWith('--'));
  const keys = await signingKeys(args.includes('--generate-dev-key'));
  const publicDer = createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
  const configs = (await loadModelConfigs()).filter(item => !requestedId || item.config.identity.id === requestedId);
  if (configs.length === 0) throw new Error(`Unknown model: ${requestedId}`);

  for (const { config } of configs) {
    const modelPath = fromProjectRoot(config.artifact.path);
    const modelHash = await sha256File(modelPath);
    const modelBytes = (await readFile(modelPath)).byteLength;
    if (modelHash !== config.artifact.sha256 || modelBytes !== config.artifact.bytes) {
      throw new Error(`Configured hash or size does not match ${config.identity.id}`);
    }
    const unsigned: SignedManifest = {
      schemaVersion: 1,
      modelId: config.identity.id,
      modelVersion: config.identity.version,
      artifact: {
        path: config.artifact.path,
        bytes: config.artifact.bytes,
        sha256: config.artifact.sha256,
      },
      packageFiles: {
        LICENSE: await sha256File(path.join(path.dirname(modelPath), 'LICENSE')),
        'README.md': await sha256File(path.join(path.dirname(modelPath), 'README.md')),
      },
      configSha256: sha256Text(canonicalize(config)),
      createdAt: new Date().toISOString(),
      signature: { algorithm: 'Ed25519', keyId, value: '' },
    };
    const signature = sign(null, Buffer.from(manifestPayload(unsigned)), keys.privateKey).toString('base64');
    const manifest: SignedManifest = { ...unsigned, signature: { ...unsigned.signature, value: signature } };
    const manifestPath = fromProjectRoot(config.artifact.manifest);
    const publicKeyPath = fromProjectRoot(config.artifact.publicKey);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(path.dirname(publicKeyPath), { recursive: true });
    await writeFile(publicKeyPath, keys.publicKey, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const checksums = {
      algorithm: 'sha256',
      files: {
        [path.basename(modelPath)]: modelHash,
        ...manifest.packageFiles,
        'manifest.json': await sha256File(manifestPath),
      },
    };
    await writeFile(path.join(path.dirname(manifestPath), 'checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`, 'utf8');
    process.stdout.write(`${canonicalize({ modelId: config.identity.id, keyId, manifest: config.artifact.manifest })}\n`);
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
