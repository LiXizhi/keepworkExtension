import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadModelConfigs } from '../src/core/config.js';
import { sha256File } from '../src/core/integrity.js';
import { fromProjectRoot } from '../src/core/paths.js';

async function main(): Promise<void> {
  const requestedId = process.argv[2] || 'speaker-eres2net-base-zh-16k';
  const loaded = (await loadModelConfigs()).find(item => item.config.identity.id === requestedId);
  if (!loaded) throw new Error(`Unknown model: ${requestedId}`);
  const url = process.env.LOCAL_MODEL_ARTIFACT_URL;
  if (!url) throw new Error('LOCAL_MODEL_ARTIFACT_URL must point to the exact artifact pinned by the model configuration');
  const target = fromProjectRoot(loaded.config.artifact.path);
  const temporary = `${target}.part`;
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  try {
    const body = response.body as unknown as import('node:stream/web').ReadableStream;
    await pipeline(Readable.fromWeb(body), createWriteStream(temporary, { mode: 0o644 }));
    const hash = await sha256File(temporary);
    const bytes = Number(response.headers.get('content-length') || 0) || undefined;
    if (hash !== loaded.config.artifact.sha256) throw new Error(`Downloaded SHA-256 mismatch: ${hash}`);
    if (bytes !== undefined && bytes !== loaded.config.artifact.bytes) {
      throw new Error(`Downloaded size mismatch: ${bytes}`);
    }
    await rename(temporary, target);
    process.stdout.write(`${JSON.stringify({ modelId: requestedId, bytes: loaded.config.artifact.bytes, sha256: hash })}\n`);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
