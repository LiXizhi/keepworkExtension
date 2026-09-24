import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeAndPrepareAudio } from '../src/capabilities/speaker/audio.js';
import { LocalModelError } from '../src/core/errors.js';
import { fromProjectRoot } from '../src/core/paths.js';
import { ModelRegistry } from '../src/core/registry.js';

function norm(values: Float32Array): number {
  let squared = 0;
  for (const value of values) squared += value * value;
  return Math.sqrt(squared);
}

test('native model returns normalized embeddings, separates fixtures, and bounds its queue', async () => {
  const registry = await ModelRegistry.create();
  try {
    const config = registry.getSpeakerConfig();
    const prepared = await Promise.all(config.selfTest.fixtures.map(async fixture => (
      decodeAndPrepareAudio(await readFile(fromProjectRoot(fixture)), { encoding: 'wav' }, config)
    )));
    const outputs: Float32Array[] = [];
    const processing: number[] = [];
    for (const input of prepared) {
      const result = await registry.invokeSpeaker('embedding', input, new AbortController().signal);
      assert.ok('embedding' in result.output);
      outputs.push(result.output.embedding);
      processing.push(result.output.processingMs);
    }
    for (const embedding of outputs) {
      assert.equal(embedding.length, 512);
      assert.ok(embedding.every(Number.isFinite));
      assert.ok(Math.abs(norm(embedding) - 1) < 1e-5);
    }
    const compare = (left: Float32Array, right: Float32Array) => left.reduce(
      (score, value, index) => score + value * (right[index] ?? 0), 0,
    );
    assert.ok(compare(outputs[0]!, outputs[1]!) > compare(outputs[0]!, outputs[2]!));
    assert.ok(processing.every(value => value < 500));

    const segment = { samples: prepared[0]!.samples.slice(0, 24000), sampleRate: 16000 };
    const concurrent = Array.from({ length: 14 }, () => (
      registry.invokeSpeaker('embedding', segment, new AbortController().signal)
    ));
    const results = await Promise.allSettled(concurrent);
    const queueErrors = results.filter(result => result.status === 'rejected'
      && result.reason instanceof LocalModelError
      && result.reason.code === 'MODEL_QUEUE_FULL');
    assert.ok(queueErrors.length > 0);
    assert.ok(results.filter(result => result.status === 'fulfilled').length <= 9);
  } finally {
    await registry.dispose();
  }
});
