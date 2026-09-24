import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModelConfigs } from '../src/core/config.js';
import { LocalModelError } from '../src/core/errors.js';
import { verifyModelPackage } from '../src/core/integrity.js';

test('model configuration is schema-valid and its signed package is trusted', async () => {
  const loaded = await loadModelConfigs();
  assert.equal(loaded.length, 1);
  const model = loaded[0];
  assert.ok(model);
  assert.equal(model.config.identity.id, 'speaker-eres2net-base-zh-16k');
  const manifest = await verifyModelPackage(model.config);
  assert.equal(manifest.modelId, model.config.identity.id);
  assert.equal(manifest.artifact.sha256, model.config.artifact.sha256);
});

test('missing and hash-mismatched artifacts return stable error codes', async () => {
  const model = (await loadModelConfigs())[0];
  assert.ok(model);
  const missing = structuredClone(model.config);
  missing.artifact.path = 'models/missing/model.onnx';
  await assert.rejects(
    verifyModelPackage(missing),
    (error: unknown) => error instanceof LocalModelError && error.code === 'MODEL_NOT_INSTALLED',
  );

  const mismatched = structuredClone(model.config);
  mismatched.artifact.sha256 = 'f'.repeat(64);
  await assert.rejects(
    verifyModelPackage(mismatched),
    (error: unknown) => error instanceof LocalModelError && error.code === 'MODEL_HASH_MISMATCH',
  );
});
