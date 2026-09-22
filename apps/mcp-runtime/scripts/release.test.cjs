const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { sha256, verifyEntriesWithRetry } = require('../../../scripts/lib/qiniu-release.cjs');
const { PRODUCT, TARGETS, archiveName, releaseIdentity, collectRelease, publishRelease } = require('./release.cjs');
const { packageRuntime } = require('./package-runtime.cjs');

const identity = { version: '0.1.0', commit: 'a'.repeat(40) };
const prefix = 'keepwork/mcp-runtime/';
const domain = 'https://cdn.keepwork.com';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const target of TARGETS) {
    const [platform, arch] = target.split('-');
    const fileName = archiveName(platform, arch);
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, `archive-${target}`);
    fs.writeFileSync(path.join(dir, `${target}.json`), JSON.stringify({
      schemaVersion: 1, product: PRODUCT, ...identity, platform, arch, nodeVersion: '22.23.2',
      fileName, size: fs.statSync(file).size, sha256: sha256(file),
      url: `${domain}/${prefix}${fileName}`, builtAt: '2026-09-22T02:00:00.000Z',
    }));
  }
  return dir;
}

test('collects exactly six fixed-name files with independent package metadata', (t) => {
  const dir = fixture(t);
  const before = fs.readdirSync(dir).sort();
  const release = collectRelease(dir, identity, prefix, domain);
  assert.equal(release.archives.length, 3);
  assert.equal(release.descriptors.length, 3);
  assert.deepEqual([...release.archives, ...release.descriptors].map((entry) => entry.name).sort(), [
    'macos-arm64.json', 'macos-arm64.zip', 'macos-x64.json', 'macos-x64.zip', 'windows-x64.json', 'windows-x64.zip',
  ]);
  for (const entry of [...release.archives, ...release.descriptors]) {
    assert.equal(entry.url, `${domain}/${prefix}${entry.name}`);
    assert.equal(entry.remoteKey, `${prefix}${entry.name}`);
  }
  for (const metadata of release.metadata) {
    assert.equal(metadata.url, `${domain}/${prefix}${metadata.fileName}`);
    assert.equal(metadata.sha256, sha256(path.join(dir, metadata.fileName)));
    assert.equal(metadata.commit, identity.commit);
    assert.equal(metadata.version, identity.version);
    assert.ok(metadata.builtAt);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'validation must not generate a seventh file');
});

test('rejects missing platforms, corrupt archives and mixed build metadata', (t) => {
  const dir = fixture(t);
  const metaPath = path.join(dir, 'macos-arm64.json');
  const original = JSON.parse(fs.readFileSync(metaPath));
  for (const patch of [
    { commit: 'b'.repeat(40) }, { platform: 'windows' },
    { builtAt: 'not a timestamp' }, { builtAt: undefined }, { url: 'https://example.com/wrong.zip' },
    { version: '0.2.0' }, { nodeVersion: '22.1.0' }, { fileName: '../escape.zip' },
    { sha256: '0'.repeat(64) }, { size: 0 },
  ]) {
    fs.writeFileSync(metaPath, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => collectRelease(dir, identity, prefix, domain));
  }
  fs.writeFileSync(metaPath, JSON.stringify(original));
  const archive = path.join(dir, original.fileName);
  fs.writeFileSync(archive, 'corrupt');
  assert.throws(() => collectRelease(dir, identity, prefix, domain), /SHA-256/);
  fs.rmSync(metaPath);
  assert.throws(() => collectRelease(dir, identity, prefix, domain), /ENOENT/);
});

test('rejects path injection and invalid release identities', () => {
  assert.throws(() => releaseIdentity('01.0.0', identity.commit), /version/);
  assert.throws(() => releaseIdentity(identity.version, 'short'), /SHA/);
  assert.throws(() => archiveName('windows', 'arm64'), /Unsupported/);
  assert.throws(() => archiveName('../escape', 'x64'), /Unsupported/);
});

test('dry-run works without credentials or remote Git access', (t) => {
  const dir = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release.cjs'),
    '--release-dir', dir, '--version', identity.version,
    '--commit', identity.commit, '--prefix', prefix, '--domain', domain, '--dry-run',
  ], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 3);
});

function fakeTransport(calls, failVerify = false) {
  return {
    async uploadEntry(config, entry) { calls.push(`upload:${entry.remoteKey}`); },
    async refreshUrls(config, urls) { calls.push(`refresh:${urls.length}`); },
    async verifyEntriesWithRetry(entries) {
      calls.push(`verify:${entries.length}`);
      if (failVerify) throw new Error('CDN mismatch');
    },
  };
}

test('uploads exactly six files and verifies ZIPs before publishing matching JSON', async (t) => {
  const release = collectRelease(fixture(t), identity, prefix, domain);
  const calls = [];
  assert.equal(await publishRelease({}, release, () => true, fakeTransport(calls)), true);
  assert.deepEqual(calls, [
    ...TARGETS.map((target) => `upload:${prefix}${target}.zip`),
    'refresh:3', 'verify:3',
    ...TARGETS.map((target) => `upload:${prefix}${target}.json`),
    'refresh:3', 'verify:3',
  ]);
});

test('failed ZIP verification prevents publishing JSON for an unverified package', async (t) => {
  const release = collectRelease(fixture(t), identity, prefix, domain);
  const calls = [];
  await assert.rejects(publishRelease({}, release, () => true, fakeTransport(calls, true)), /CDN mismatch/);
  assert.ok(!calls.some((call) => call.endsWith('.json')));
});

test('superseded builds perform no writes; an accepted overwrite completes if main advances', async (t) => {
  const release = collectRelease(fixture(t), identity, prefix, domain);
  const skipped = [];
  assert.equal(await publishRelease({}, release, () => false, fakeTransport(skipped)), false);
  assert.deepEqual(skipped, []);
  const calls = [];
  let checks = 0;
  assert.equal(await publishRelease({}, release, () => ++checks === 1, fakeTransport(calls)), true);
  assert.equal(checks, 1);
  assert.equal(calls.filter((call) => call.startsWith('upload:')).length, 6);
});

test('a second publication replaces the same six object keys with new package bytes and hashes', async (t) => {
  const dir = fixture(t);
  const objects = new Map();
  const transport = {
    async uploadEntry(config, entry) { objects.set(entry.remoteKey, fs.readFileSync(entry.filePath)); },
    async refreshUrls() {},
    async verifyEntriesWithRetry(entries) {
      for (const entry of entries) assert.deepEqual(objects.get(entry.remoteKey), fs.readFileSync(entry.filePath));
    },
  };
  await publishRelease({}, collectRelease(dir, identity, prefix, domain), () => true, transport);
  const previousKeys = [...objects.keys()].sort();
  const previousHash = JSON.parse(objects.get(`${prefix}macos-arm64.json`)).sha256;
  for (const target of TARGETS) {
    const archive = path.join(dir, `${target}.zip`);
    fs.appendFileSync(archive, '-new-build');
    const metadataPath = path.join(dir, `${target}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath));
    Object.assign(metadata, { size: fs.statSync(archive).size, sha256: sha256(archive), builtAt: '2026-09-22T03:00:00.000Z' });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  }
  await publishRelease({}, collectRelease(dir, identity, prefix, domain), () => true, transport);
  assert.equal(objects.size, 6);
  assert.deepEqual([...objects.keys()].sort(), previousKeys);
  const current = JSON.parse(objects.get(`${prefix}macos-arm64.json`));
  assert.notEqual(current.sha256, previousHash);
  assert.equal(current.builtAt, '2026-09-22T03:00:00.000Z');
});

test('CDN verification checks the exact fixed URL and rejects stale bytes', async (t) => {
  const release = collectRelease(fixture(t), identity, prefix, domain);
  const entry = release.archives[0];
  const requested = [];
  t.mock.method(global, 'fetch', async (url) => {
    requested.push(url);
    return new Response(fs.readFileSync(entry.filePath));
  });
  await verifyEntriesWithRetry([entry], 1, 0, false);
  assert.deepEqual(requested, [entry.url]);
  t.mock.method(global, 'fetch', async () => new Response('stale archive'));
  await assert.rejects(verifyEntriesWithRetry([entry], 1, 0, false), /mismatch/);
});

test('archives preserve root layout, dependencies, hidden files and executable modes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime package spaces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = path.join(dir, 'stage');
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const arch = 'x64';
  const executable = platform === 'windows' ? 'node.exe' : 'bin/node';
  for (const name of [executable, 'LICENSE-node.txt', 'app/cli.cjs', 'app/package.json',
    'app/node_modules/node-pty/prebuilds/spawn-helper', 'app/node_modules/playwright-core/package.json',
    'app/node_modules/.hidden']) {
    const file = path.join(stage, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
  }
  fs.chmodSync(path.join(stage, executable), 0o755);
  fs.chmodSync(path.join(stage, 'app/node_modules/node-pty/prebuilds/spawn-helper'), 0o755);
  fs.writeFileSync(path.join(stage, 'runtime.json'), JSON.stringify({
    product: PRODUCT, version: identity.version, platform, arch, nodeVersion: '22.23.2', entry: 'app/cli.cjs',
  }));
  const output = packageRuntime(stage, path.join(dir, 'out'), identity);
  const extracted = path.join(dir, 'extracted');
  fs.mkdirSync(extracted);
  if (process.platform === 'win32') {
    // Git Bash can put GNU tar first on PATH; it treats C: as a remote host.
    // Use the same native ZIP API as packaging, with paths passed as data.
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:KP_ARCHIVE_SOURCE, $env:KP_ARCHIVE_DESTINATION)"], {
      env: { ...process.env, KP_ARCHIVE_SOURCE: output, KP_ARCHIVE_DESTINATION: extracted }, stdio: 'inherit',
    });
  } else {
    execFileSync('unzip', ['-q', output, '-d', extracted]);
  }
  assert.equal(path.basename(output), `${platform}-${arch}.zip`);
  assert.equal(fs.readFileSync(output).subarray(0, 4).toString('hex'), '504b0304');
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'out', `${platform}-${arch}.json`)));
  assert.equal(metadata.sha256, sha256(output));
  assert.equal(metadata.size, fs.statSync(output).size);
  assert.equal(metadata.url, `${domain}/${prefix}${platform}-${arch}.zip`);
  assert.ok(Number.isFinite(Date.parse(metadata.builtAt)));
  assert.ok(fs.existsSync(path.join(extracted, 'runtime.json')));
  assert.equal(fs.readFileSync(path.join(extracted, 'app/node_modules/.hidden'), 'utf8'), 'app/node_modules/.hidden');
  if (platform === 'macos') {
    assert.equal(fs.statSync(path.join(extracted, executable)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(extracted, 'app/node_modules/node-pty/prebuilds/spawn-helper')).mode & 0o777, 0o755);
  }
});
