import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ModelRegistry } from '../src/core/registry.js';
import { fromProjectRoot } from '../src/core/paths.js';
import { startHttpService } from '../src/transports/http.js';

function metadataForm(audio: Buffer, metadata: Record<string, unknown>): FormData {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('audio', new Blob([Uint8Array.from(audio)], { type: 'application/octet-stream' }), 'audio.bin');
  return form;
}

test('HTTP service enforces origin policy and serves embedding/compare without matched', async () => {
  const registry = await ModelRegistry.create();
  const service = await startHttpService(registry, { port: 0 });
  try {
    const forbidden = await fetch(`${service.origin}/v1/health`, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(forbidden.status, 403);

    const preflight = await fetch(`${service.origin}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const health = await fetch(`${service.origin}/v1/health`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { protocolVersion: string; models: unknown[] };
    assert.equal(healthBody.protocolVersion, '1.0.0');
    assert.equal(healthBody.models.length, 1);

    const livePreviewHealth = await fetch(`${service.origin}/v1/health`, {
      headers: { Origin: 'http://127.0.0.1:3001' },
    });
    assert.equal(livePreviewHealth.status, 200);

    const fixtures = (await registry.getSpeakerConfig().selfTest.fixtures);
    const firstAudio = await readFile(fromProjectRoot(fixtures[0] ?? ''));
    const secondAudio = await readFile(fromProjectRoot(fixtures[1] ?? ''));
    const headers = { Origin: 'http://localhost:3000', 'X-Request-Id': 'http-test-embedding' };
    const embeddingResponse = await fetch(`${service.origin}/v1/speaker/embedding`, {
      method: 'POST', headers, body: metadataForm(firstAudio, { encoding: 'wav' }),
    });
    assert.equal(embeddingResponse.status, 200);
    assert.equal(embeddingResponse.headers.get('x-request-id'), 'http-test-embedding');
    const embedding = await embeddingResponse.json() as { embedding: number[]; dimension: number; normalized: boolean };
    assert.equal(embedding.dimension, 512);
    assert.equal(embedding.embedding.length, 512);
    assert.equal(embedding.normalized, true);

    const compareResponse = await fetch(`${service.origin}/v1/speaker/compare`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
      body: metadataForm(secondAudio, { encoding: 'wav', template: embedding.embedding }),
    });
    assert.equal(compareResponse.status, 200);
    const comparison = await compareResponse.json() as Record<string, unknown>;
    assert.equal(typeof comparison.score, 'number');
    assert.equal('matched' in comparison, false);
  } finally {
    await service.close();
  }
});
