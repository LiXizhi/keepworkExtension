const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generate } = require('./generate-release-manifest.cjs');

test('generates a signed Android ARM64 unified helper manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-android-release-'));
  const file = path.join(root, 'KP-Local-Helper-Android-0.1.0-arm64-v8a.apk');
  fs.writeFileSync(file, 'signed-apk');
  const manifest = generate(file, '0.1.0', 'https://cdn.keepwork.com/keepwork/KP-Local-Helper-Android', 'a'.repeat(40), '2026-09-28T00:00:00.000Z');
  assert.equal(manifest.product, 'kp-local-helper-android');
  assert.equal(manifest.signed, true);
  assert.equal(manifest.platform, 'android');
  assert.equal(manifest.arch, 'arm64-v8a');
  assert.deepEqual(manifest.capabilities, ['mcp', 'local-model']);
  assert.equal(manifest.localModelProtocolVersion, '1.0.0');
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test('rejects non-Keepwork release origins and invalid commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-android-release-'));
  const file = path.join(root, 'KP-Local-Helper-Android-0.1.0-arm64-v8a.apk');
  fs.writeFileSync(file, 'x');
  assert.throws(() => generate(file, '0.1.0', 'https://example.com/android', 'a'.repeat(40)), /Keepwork HTTPS CDN/);
  assert.throws(() => generate(file, '0.1.0', 'https://cdn.keepwork.com/android', 'main'), /40-character/);
});
