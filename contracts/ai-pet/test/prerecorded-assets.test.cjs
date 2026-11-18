'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../fixtures/asset-bundle.json');
const { verifyAssetBundle, manifestDigest } = require('../asset-verifier.cjs');

test('prerecorded experiment is explicit and retains independent admission and integrity requirements', () => {
  const f = structuredClone(fixture);
  const resources = new Map(Object.entries(f.resourcesBase64).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]));
  f.manifest.mouthMode = 'prerecorded';
  assert.throws(() => verifyAssetBundle(f.manifest, { approval: f.approval, nowMs: f.nowMs, resources }), /manifest-binding/);
  f.approval.manifestSha256 = manifestDigest(f.manifest);
  assert.equal(verifyAssetBundle(f.manifest, { approval: f.approval, nowMs: f.nowMs, resources }).manifest.mouthMode, 'prerecorded');
  assert.throws(() => verifyAssetBundle(f.manifest, { approval: { ...f.approval, usage: 'production' }, nowMs: f.nowMs, resources }), /approval/);
  f.manifest.mouthMode = 'automatic-lip-sync';
  assert.throws(() => manifestDigest(f.manifest));
});
