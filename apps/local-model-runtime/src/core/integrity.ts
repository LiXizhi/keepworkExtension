import { createHash, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ModelConfig, SignedManifest } from './types.js';
import { canonicalize } from './canonicalJson.js';
import { fromProjectRoot } from './paths.js';
import { LocalModelError } from './errors.js';

export async function sha256File(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function manifestPayload(manifest: SignedManifest): string {
  const { signature: _signature, ...payload } = manifest;
  return canonicalize(payload);
}

export async function verifyModelPackage(
  config: ModelConfig,
): Promise<SignedManifest> {
  const modelPath = fromProjectRoot(config.artifact.path);
  const manifestPath = fromProjectRoot(config.artifact.manifest);
  const publicKeyPath = fromProjectRoot(config.artifact.publicKey);

  let modelStat;
  try {
    modelStat = await stat(modelPath);
  } catch {
    throw new LocalModelError('MODEL_NOT_INSTALLED', `Model artifact is missing: ${config.identity.id}`, {
      status: 503,
    });
  }
  if (modelStat.size !== config.artifact.bytes) {
    throw new LocalModelError('MODEL_SIZE_MISMATCH', 'Model artifact size does not match configuration');
  }
  const actualHash = await sha256File(modelPath);
  if (actualHash !== config.artifact.sha256) {
    throw new LocalModelError('MODEL_HASH_MISMATCH', 'Model artifact SHA-256 verification failed');
  }

  let manifest: SignedManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SignedManifest;
  } catch {
    throw new LocalModelError('MODEL_MANIFEST_INVALID', 'Signed model manifest is missing or invalid');
  }
  if (manifest.schemaVersion !== 1
    || manifest.modelId !== config.identity.id
    || manifest.modelVersion !== config.identity.version
    || manifest.artifact.path !== config.artifact.path
    || manifest.artifact.bytes !== config.artifact.bytes
    || manifest.artifact.sha256 !== config.artifact.sha256
    || !manifest.packageFiles
    || manifest.configSha256 !== sha256Text(canonicalize(config))) {
    throw new LocalModelError('MODEL_MANIFEST_MISMATCH', 'Model manifest does not match model configuration');
  }
  if (manifest.signature?.algorithm !== 'Ed25519' || !manifest.signature.value) {
    throw new LocalModelError('MODEL_SIGNATURE_INVALID', 'Model manifest signature is missing');
  }

  let publicKey: string;
  try {
    publicKey = await readFile(publicKeyPath, 'utf8');
  } catch {
    throw new LocalModelError('MODEL_PUBLIC_KEY_MISSING', 'Trusted model signing public key is missing');
  }
  const valid = verify(
    null,
    Buffer.from(manifestPayload(manifest)),
    publicKey,
    Buffer.from(manifest.signature.value, 'base64'),
  );
  if (!valid) {
    throw new LocalModelError('MODEL_SIGNATURE_INVALID', 'Model manifest signature verification failed');
  }

  const packageDirectory = path.dirname(manifestPath);
  for (const [name, expectedHash] of Object.entries(manifest.packageFiles)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new LocalModelError('MODEL_MANIFEST_INVALID', 'Model package file entry is invalid');
    }
    let packageHash: string;
    try {
      packageHash = await sha256File(path.join(packageDirectory, name));
    } catch {
      throw new LocalModelError('MODEL_PACKAGE_FILE_MISSING', `Signed model package file is missing: ${name}`);
    }
    if (packageHash !== expectedHash) {
      throw new LocalModelError('MODEL_PACKAGE_FILE_MISMATCH', `Signed model package file failed verification: ${name}`);
    }
  }

  let checksums: { algorithm?: unknown; files?: unknown };
  try {
    checksums = JSON.parse(await readFile(path.join(packageDirectory, 'checksums.json'), 'utf8')) as typeof checksums;
  } catch {
    throw new LocalModelError('MODEL_CHECKSUMS_INVALID', 'Model checksums file is missing or invalid');
  }
  const expectedChecksums: Record<string, string> = {
    [path.basename(modelPath)]: actualHash,
    ...manifest.packageFiles,
    [path.basename(manifestPath)]: await sha256File(manifestPath),
  };
  if (checksums.algorithm !== 'sha256'
    || !checksums.files
    || typeof checksums.files !== 'object'
    || canonicalize(checksums.files) !== canonicalize(expectedChecksums)) {
    throw new LocalModelError('MODEL_CHECKSUMS_INVALID', 'Model checksums do not match the signed package');
  }
  return manifest;
}
