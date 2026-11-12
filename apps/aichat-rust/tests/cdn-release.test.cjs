const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectInstallers, writeStepSummary } = require('../scripts/publish-cdn-release.cjs');

const appRoot = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;

function fixture(t, names = [
  `Keepwork_${version}_x64-setup.exe`,
  `Keepwork_${version}_arm64-setup.exe`,
  `Keepwork_${version}_universal.dmg`,
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-cdn-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `${name}:payload`);
  // The workflow merges GitHub artifacts into one directory; unrelated files must be ignored.
  fs.writeFileSync(path.join(dir, `release-manifest-${version}-x64.json`), '{}');
  return dir;
}

test('collects the three installers under one immutable version path', (t) => {
  const dir = fixture(t);
  const entries = collectInstallers(dir, version, 'keepwork/aichat-rust/', 'https://cdn.keepwork.com');
  assert.deepEqual(entries.map(({ platform, arch, name }) => ({ platform, arch, name })), [
    { platform: 'windows', arch: 'x64', name: `Keepwork_${version}_x64-setup.exe` },
    { platform: 'windows', arch: 'arm64', name: `Keepwork_${version}_arm64-setup.exe` },
    { platform: 'macos', arch: 'universal', name: `Keepwork_${version}_universal.dmg` },
  ]);
  for (const entry of entries) {
    assert.equal(entry.remoteKey, `keepwork/aichat-rust/${version}/${entry.name}`);
    assert.equal(entry.url, `https://cdn.keepwork.com/keepwork/aichat-rust/${version}/${entry.name}`);
    assert.equal(entry.size, fs.statSync(entry.filePath).size);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(fs.readFileSync(entry.filePath)).digest('hex'));
  }
});

test('writes a linked summary only when the runner asks for one', (t) => {
  const dir = fixture(t);
  const entries = collectInstallers(dir, version, 'keepwork/aichat-rust/', 'https://cdn.keepwork.com');
  const summary = path.join(dir, 'job-summary.md');
  const previous = process.env.GITHUB_STEP_SUMMARY;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
  });

  writeStepSummary(version, entries);
  assert.equal(fs.existsSync(summary), false);

  process.env.GITHUB_STEP_SUMMARY = summary;
  writeStepSummary(version, entries);
  const text = fs.readFileSync(summary, 'utf8');
  assert.ok(text.includes(`### CDN copy: ${version}`));
  for (const entry of entries) assert.ok(text.includes(`[${entry.name}](${entry.url})`), entry.url);
  assert.ok(text.includes(entries[0].sha256));
});

test('rejects a missing installer', (t) => {
  const dir = fixture(t, [`Keepwork_${version}_x64-setup.exe`, `Keepwork_${version}_universal.dmg`]);
  assert.throws(
    () => collectInstallers(dir, version, 'keepwork/aichat-rust/', 'https://cdn.keepwork.com'),
    /missing or empty: Keepwork_.*_arm64-setup\.exe/,
  );
});

test('rejects an ambiguous DMG set', (t) => {
  const dir = fixture(t, [
    `Keepwork_${version}_x64-setup.exe`,
    `Keepwork_${version}_arm64-setup.exe`,
    `Keepwork_${version}_universal.dmg`,
    `Keepwork_${version}_aarch64.dmg`,
  ]);
  assert.throws(
    () => collectInstallers(dir, version, 'keepwork/aichat-rust/', 'https://cdn.keepwork.com'),
    /exactly one macOS DMG/,
  );
});

test('rejects installers built for a different version', (t) => {
  const dir = fixture(t, [
    'Keepwork_0.0.1_x64-setup.exe',
    'Keepwork_0.0.1_arm64-setup.exe',
    'Keepwork_0.0.1_universal.dmg',
  ]);
  assert.throws(
    () => collectInstallers(dir, version, 'keepwork/aichat-rust/', 'https://cdn.keepwork.com'),
    /exactly one macOS DMG/,
  );
  assert.throws(
    () => collectInstallers(dir, '0.0.1', 'keepwork/aichat-rust/', 'https://cdn.keepwork.com'),
    /does not match apps\/aichat-rust\/package\.json/,
  );
});
