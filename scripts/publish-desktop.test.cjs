const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, publishRelease } = require('./publish-desktop.cjs');

test('Windows packaging produces both updater installer and website ZIP', () => {
  const desktopPackage = require('../apps/aichat-desktop/package.json');
  assert.match(desktopPackage.scripts['make:win'], /--win nsis zip --x64/);
});

test('desktop publication creates a ZIP-only browser download manifest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'KeepWork-SecondBrain-0.1.0-x64.zip'), 'zip fixture');
  fs.writeFileSync(path.join(dir, 'KeepWork-SecondBrain-0.1.0-x64.exe'), 'installer fixture');
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.1.0\n');
  const entries = collect(dir, 'win32-x64');
  const manifestEntry = entries.find(entry => entry.name === 'latest-client.json');
  const manifest = JSON.parse(fs.readFileSync(manifestEntry.filePath, 'utf8'));
  assert.deepEqual({ product: manifest.product, platform: manifest.platform, arch: manifest.arch, format: manifest.format },
    { product: 'aichat-desktop', platform: 'windows', arch: 'x64', format: 'zip' });
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.fileName, 'KeepWork-SecondBrain-0.1.0-x64.zip');
  assert.equal(manifest.url, 'https://cdn.keepwork.com/keepwork/aichat-desktop/win32-x64/KeepWork-SecondBrain-0.1.0-x64.zip');
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test('desktop publication rejects targets without exactly one ZIP client', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 0.1.0\n');
  assert.throws(() => collect(dir, 'darwin-arm64'), /Exactly one client ZIP/);
});

test('desktop publication verifies binaries before promoting and verifying descriptors', async () => {
  const entries = [
    { name: 'client.zip', url: 'https://cdn.keepwork.com/client.zip' },
    { name: 'installer.exe', url: 'https://cdn.keepwork.com/installer.exe' },
    { name: 'latest.yml', url: 'https://cdn.keepwork.com/latest.yml' },
    { name: 'latest-client.json', url: 'https://cdn.keepwork.com/latest-client.json' },
  ];
  const events = [];
  const transport = {
    uploadEntry: async (_config, entry) => events.push(`upload:${entry.name}`),
    refreshUrls: async (_config, urls) => events.push(`refresh:${urls.map(url => url.split('/').pop()).join(',')}`),
    verifyEntriesWithRetry: async group => events.push(`verify:${group.map(entry => entry.name).join(',')}`),
  };
  await publishRelease(entries, {}, transport);
  assert.deepEqual(events, [
    'upload:client.zip',
    'upload:installer.exe',
    'refresh:client.zip,installer.exe',
    'verify:client.zip,installer.exe',
    'upload:latest.yml',
    'upload:latest-client.json',
    'refresh:latest.yml,latest-client.json',
    'verify:latest.yml,latest-client.json',
  ]);
});
