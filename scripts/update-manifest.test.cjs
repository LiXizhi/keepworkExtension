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

test('the three Rust desktop targets accept native packages including one universal Mac manifest', () => {
  const universal = { ...desktop(), arch: 'universal' };
  const windowsPackage = { ...pkg, format: 'exe', fileName: 'Keepwork_1.2.3_x64-setup.exe',
    url: 'https://cdn.keepwork.com/keepwork/aichat-rust/1.2.3/Keepwork_1.2.3_x64-setup.exe' };
  for (const arch of ['x64', 'arm64']) {
    const value = { ...desktop(), ...windowsPackage, platform: 'windows', arch,
      installer: { ...windowsPackage } };
    assert.doesNotThrow(() => validateDesktopManifest(value, { target: `win32-${arch}` }));
    assert.ok(schema(value), JSON.stringify(schema.errors));
  }
  assert.doesNotThrow(() => validateDesktopManifest(universal, { target: 'darwin-universal' }));
  assert.ok(schema(universal), JSON.stringify(schema.errors));
  for (const target of ['darwin-x64', 'darwin-arm64', 'win32-universal']) {
    assert.throws(() => validateDesktopManifest(universal, { target }));
  }
  const impossibleWindows = { ...desktop(), ...windowsPackage, platform: 'windows', arch: 'universal',
    installer: { ...windowsPackage } };
  assert.throws(() => validateDesktopManifest(impossibleWindows, { target: 'win32-universal' }));
  assert.equal(schema(impossibleWindows), false, 'Universal is a Mac desktop architecture only');
  const impossibleRuntime = { ...runtime(), arch: 'universal' };
  assert.throws(() => validateRustManifest(impossibleRuntime));
  assert.equal(schema(impossibleRuntime), false, 'Universal desktop installers do not change per-architecture MCP feeds');
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

test('version-status has a distinct strict schema and cannot pass installable manifest validation', () => {
  const { validateDesktopVersionStatus } = require('./lib/update-manifest.cjs');
  const status = {
    schemaVersion: 1, kind: 'version-status', product: 'aichat-desktop', channel: 'stable',
    platform: 'macos', arch: 'universal', version: '0.2.107', commit: 'a'.repeat(40),
    publishedAt: '2026-11-13T08:04:26.038Z', releaseStatus: 'version-only', installable: false,
    description: 'Current source version; installer not published.',
  };
  for (const target of ['darwin-universal', 'win32-x64', 'win32-arm64']) {
    const value = { ...status, platform: target.startsWith('darwin-') ? 'macos' : 'windows', arch: target.split('-')[1] };
    assert.doesNotThrow(() => validateDesktopVersionStatus(value, { target }));
    assert.ok(schema(value), JSON.stringify(schema.errors));
    assert.throws(() => validateDesktopManifest(value, { target, legacy: true }), /not an installable/);
  }
  for (const change of [{ schemaVersion: 2 }, { kind: 'package' }, { product: 'keepwork-mcp-runtime' },
    { installable: true }, { releaseStatus: 'released' }, { channel: 'preview' }, { commit: 'abc' },
    { arch: 'arm64' }, { installer: {} }, { url: pkg.url }, { format: 'dmg' }, { sha256: pkg.sha256 },
    { size: 100 }, { fileName: pkg.fileName }, { version: '01.2.3' }, { unexpected: true }]) {
    const value = { ...status, ...change };
    assert.throws(() => validateDesktopVersionStatus(value, { target: 'darwin-universal' }), JSON.stringify(change));
    assert.equal(schema(value), false, JSON.stringify(change));
  }
  const mixed = { ...desktop(), ...status };
  assert.throws(() => validateDesktopManifest(mixed), /not an installable/);
  assert.equal(schema(mixed), false, 'full package fields must not disguise a version-only record');
});

test('historical Rust build dates require explicit day precision, recorded source and timezone', () => {
  const recovery = {
    builtAt: '2026-11-13', builtAtPrecision: 'day',
    builtAtSource: 'recorded-build-session', builtAtTimezone: 'Asia/Shanghai',
  };
  const recovered = { ...runtime(), ...recovery };
  validateRustManifest(recovered);
  assert.ok(schema(recovered), JSON.stringify(schema.errors));
  for (const key of Object.keys(recovery)) {
    const partial = { ...recovered };
    delete partial[key];
    assert.throws(() => validateRustManifest(partial), `requires ${key}`);
    assert.equal(schema(partial), false, `schema requires ${key}`);
  }
  for (const change of [
    { builtAt: '2026-11-13T00:00:00Z' }, { builtAt: '2026-1-3' }, { builtAt: '2026-13-01' },
    { builtAt: '2026-11-00' }, { builtAt: null }, { builtAtPrecision: 'second' },
    { builtAtSource: 'mtime' }, { builtAtSource: 'publishedAt' }, { builtAtTimezone: 'UTC' },
  ]) {
    const invalid = { ...recovered, ...change };
    assert.throws(() => validateRustManifest(invalid), JSON.stringify(change));
    assert.equal(schema(invalid), false, JSON.stringify(change));
  }
  // The publication validator enforces calendar semantics even when a consumer
  // disables JSON Schema format assertions (as this suite's AJV instance does).
  for (const builtAt of ['2026-02-29', '2026-02-31', '1900-02-29', '2026-04-31']) {
    assert.throws(() => validateRustManifest({ ...recovered, builtAt }), /calendar date/);
  }
  for (const builtAt of ['2024-02-29', '2000-02-29', '2026-12-31']) {
    validateRustManifest({ ...recovered, builtAt });
  }
  const ordinary = { ...runtime(), builtAt: '2026-11-13T08:00:00.123Z' };
  validateRustManifest(ordinary);
  assert.ok(schema(ordinary), JSON.stringify(schema.errors));
  assert.throws(() => validateRustManifest({ ...runtime(), builtAt: recovery.builtAt }), /UTC ISO-8601/);
  assert.equal(schema({ ...runtime(), builtAt: recovery.builtAt }), false);
  for (const value of [{ ...desktop(), ...recovery }, { ...desktop(), installer: { ...pkg, ...recovery } }]) {
    assert.throws(() => validateDesktopManifest(value), /provenance/);
    assert.equal(schema(value), false, 'historical Rust recovery does not relax desktop installer timestamps');
  }
  assert.throws(() => validateRustManifest({ ...recovered, publishedAt: recovery.builtAt }), /UTC ISO-8601/);
});

test('precise compiled build timestamps accept only explicit clock or reproducible-epoch provenance', () => {
  for (const builtAtSource of ['compile-clock', 'source-date-epoch']) {
    const precise = { ...runtime(), builtAt: '2026-11-13T08:00:00Z', builtAtSource };
    validateRustManifest(precise);
    assert.ok(schema(precise), JSON.stringify(schema.errors));
    for (const change of [{ builtAt: '2026-11-13' }, { builtAt: null },
      { builtAtPrecision: 'day' }, { builtAtPrecision: 'second' }, { builtAtTimezone: 'Asia/Shanghai' },
      { builtAtTimezone: 'UTC' }, { builtAtSource: 'mtime' }, { builtAtSource: 'publishedAt' }]) {
      const invalid = { ...precise, ...change };
      assert.throws(() => validateRustManifest(invalid), JSON.stringify(change));
      assert.equal(schema(invalid), false, JSON.stringify(change));
    }
    const missing = { ...precise };
    delete missing.builtAt;
    assert.throws(() => validateRustManifest(missing));
    assert.equal(schema(missing), false);
  }
  const legacyPrecise = { ...runtime(), builtAt: '2026-11-13T08:00:00.123Z' };
  validateRustManifest(legacyPrecise);
  assert.ok(schema(legacyPrecise));
});
