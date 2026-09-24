import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeAndPrepareAudio, float32ToBuffer } from '../src/capabilities/speaker/audio.js';
import { loadModelConfigs } from '../src/core/config.js';
import { LocalModelError } from '../src/core/errors.js';
import { fromProjectRoot } from '../src/core/paths.js';

test('WAV input is decoded as finite 16 kHz mono PCM', async () => {
  const model = (await loadModelConfigs())[0];
  assert.ok(model);
  const wav = await readFile(fromProjectRoot(model.config.selfTest.fixtures[0] ?? ''));
  const output = decodeAndPrepareAudio(wav, { encoding: 'wav' }, model.config);
  assert.equal(output.sampleRate, 16000);
  assert.ok(output.durationMs > 3000);
  assert.ok(output.samples.every(Number.isFinite));
});

test('raw stereo Float32 input is downmixed and resampled', async () => {
  const model = (await loadModelConfigs())[0];
  assert.ok(model);
  const stereo = new Float32Array(8000 * 2 * 0.4);
  for (let frame = 0; frame < stereo.length / 2; frame += 1) {
    stereo[frame * 2] = 0.5;
    stereo[frame * 2 + 1] = -0.25;
  }
  const output = decodeAndPrepareAudio(float32ToBuffer(stereo), {
    encoding: 'pcm_f32le',
    sampleRate: 8000,
    channels: 2,
  }, model.config);
  assert.equal(output.samples.length, 6400);
  assert.ok(Math.abs((output.samples[0] ?? 0) - 0.125) < 1e-6);
});

test('non-finite Float32 input is rejected without entering the model', async () => {
  const model = (await loadModelConfigs())[0];
  assert.ok(model);
  const samples = new Float32Array(16000);
  samples[20] = Number.NaN;
  assert.throws(
    () => decodeAndPrepareAudio(float32ToBuffer(samples), {
      encoding: 'pcm_f32le', sampleRate: 16000, channels: 1,
    }, model.config),
    (error: unknown) => error instanceof LocalModelError && error.code === 'AUDIO_RANGE_INVALID',
  );
});
