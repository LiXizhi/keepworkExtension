const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv/dist/2020');
const { validateDesktopManifest, validateRustManifest, timestamp } = require('./lib/update-manifest.cjs');
const schema = new Ajv({ strict: false, validateFormats: false }).compile(require('../docs/schemas/update-manifest.schema.json'));
const pkg = { version: '1.2.3', format: 'dmg', fileName: 'Keepwork_1.2.3_universal.dmg',
  url: 'https://cdn.keepwork.com/keepwork/aichat-rust/1.2.3/Keepwork_1.2.3_universal.dmg', size: 100, sha256: 'a'.repeat(64), publishedAt: '2026-11-13T12:00:00Z' };
const desktop = () => ({ schemaVersion: 1, product: 'aichat-desktop', platform: 'macos', arch: 'arm64', ...pkg, installer: { ...pkg }, optionalFutureField: { arbitrary: true } });
const runtime = () => ({ schemaVersion: 2, product: 'keepwork-mcp-runtime', engine: 'rust', platform: 'macos', arch: 'arm64',
  version: '0.2.50', commit: 'b'.repeat(40), sourceHash: 'c'.repeat(64), fileName: 'macos-arm64.zip',
  url: 'https://cdn.keepwork.com/keepwork/mcp-stable-rs/0.2.50/macos-arm64.zip', size: 123, sha256: 'd'.repeat(64) });

test('formal schema and publication validators accept native, additive legacy and independent Rust manifests', () => {
  const legacy = { ...desktop(), version: '0.1.12', format: 'zip', fileName: 'Launcher.zip', url: 'https://cdn.keepwork.com/Launcher.zip' };
  delete legacy.publishedAt;
  for (const value of [desktop(), legacy]) {
    validateDesktopManifest(value, { target: 'darwin-arm64' });
    assert.ok(schema(value), JSON.stringify(schema.errors));
  }
  validateRustManifest(runtime()); assert.ok(schema(runtime()), JSON.stringify(schema.errors));
  assert.equal(legacy.version, '0.1.12'); assert.equal(legacy.installer.version, '1.2.3');
});

test('legacy desktop identity omissions stay readable but explicit conflicting identity fails', () => {
  const value = desktop();
  for (const key of ['product', 'schemaVersion', 'platform', 'arch']) delete value[key];
  delete value.installer.version; delete value.installer.publishedAt;
  assert.doesNotThrow(() => validateDesktopManifest(value, { target: 'darwin-arm64', legacy: true }));
  assert.throws(() => validateDesktopManifest({ ...value, product: 'unrelated' }, { target: 'darwin-arm64', legacy: true }));
  assert.throws(() => validateDesktopManifest(desktop(), { target: 'win32-arm64' }));
});

test('unsafe or incomplete package fields fail before promotion while additive fields remain usable', () => {
  for (const change of [{ url: 'http://cdn.keepwork.com/package.dmg' }, { url: 'https://user:secret@cdn.keepwork.com/package.dmg' },
    { url: 'https://cdn.keepwork.com/package.dmg?token=x' }, { sha256: 'x'.repeat(64) }, { size: 0 }, { size: 1.5 },
    { fileName: '../escape.dmg' }, { version: '01.2.3' }, { publishedAt: '2026-02-31T12:00:00Z' }]) {
    assert.throws(() => validateDesktopManifest({ ...desktop(), installer: { ...pkg, ...change } }), JSON.stringify(change));
  }
  for (const change of [{ engine: 'node' }, { schemaVersion: 1 }, { commit: 'abc' }, { sourceHash: 'b' }, { fileName: 'windows-arm64.zip' }]) {
    assert.throws(() => validateRustManifest({ ...runtime(), ...change }));
  }
  for (const date of ['2026-11-13T12:00:00Z', '2026-11-13T12:00:00.123Z', '2026-11-13T12:00:00.123456Z']) timestamp(date, 'fixture');
});
