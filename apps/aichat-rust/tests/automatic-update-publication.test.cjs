const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectReleaseFiles, collectUpdateFeeds, publishRelease } = require('../scripts/publish-release.cjs');

const version = '1.2.3';
const publishedAt = '2026-11-13T08:00:00.000Z';
const targets = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const feedUrl = target => `https://cdn.keepwork.com/keepwork/aichat-desktop/${target}/latest-client.json`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-automatic-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const suffix of ['x64-setup.exe', 'arm64-setup.exe', 'universal.dmg']) {
    fs.writeFileSync(path.join(directory, `Keepwork_${version}_${suffix}`), `verified installer fixture: ${suffix}`);
  }
  return { directory, entries: collectReleaseFiles(directory, version) };
}

function readManifest(entry) {
  return JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));
}

function targetOf(entry) {
  return targets.find(target => entry.url === feedUrl(target));
}

function legacyDownload() {
  return {
    schemaVersion: 1,
    product: 'aichat-desktop',
    version: '0.1.10',
    platform: 'macos',
    arch: 'arm64',
    format: 'zip',
    fileName: 'Keepwork-Launcher-macos-arm64.zip',
    url: 'https://cdn.keepwork.com/keepwork/aichat-desktop/darwin-arm64/Keepwork-Launcher-macos-arm64.zip',
    size: 321,
    sha256: 'a'.repeat(64),
    publishedAt: '2026-10-30T08:00:00.000Z',
    customLegacyField: { keep: ['unknown', 'additive', 'fields'] },
  };
}

test('publishes discoverable manifests at every existing native desktop target path', t => {
  const { entries } = fixture(t);
  const feeds = collectUpdateFeeds(entries, version, publishedAt);
  assert.equal(feeds.length, targets.length);
  assert.deepEqual(feeds.map(targetOf).sort(), [...targets].sort());
  for (const feed of feeds) {
    const target = targetOf(feed);
    assert.equal(feed.remoteKey, `keepwork/aichat-desktop/${target}/latest-client.json`);
    const bytes = fs.readFileSync(feed.filePath);
    assert.equal(feed.size, bytes.length);
    assert.equal(feed.sha256, digest(bytes));
    const manifest = readManifest(feed);
    const installer = entries.find(entry => entry.name.endsWith(target.startsWith('darwin-')
      ? 'universal.dmg' : `${target.endsWith('arm64') ? 'arm64' : 'x64'}-setup.exe`));
    assert.ok(installer, `matching installer for ${target}`);
    const expected = {
      version,
      publishedAt,
      format: target.startsWith('darwin-') ? 'dmg' : 'exe',
      fileName: installer.name,
      url: installer.url,
      size: installer.size,
      sha256: installer.sha256,
    };
    assert.deepEqual(manifest.installer, expected);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(manifest[key], value);
  }
  assert.equal(readManifest(feeds.find(feed => targetOf(feed) === 'darwin-x64')).url,
    readManifest(feeds.find(feed => targetOf(feed) === 'darwin-arm64')).url,
    'both Mac architectures receive the same verified universal installer');
});

test('adds native installer metadata without changing legacy ZIP downloads or unknown fields', t => {
  const { entries } = fixture(t);
  const previous = legacyDownload();
  const original = structuredClone(previous);
  const feeds = collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous });
  const manifest = readManifest(feeds.find(feed => targetOf(feed) === 'darwin-arm64'));
  const { installer, ...preserved } = manifest;
  assert.deepEqual(preserved, original);
  assert.deepEqual(previous, original, 'planning must not mutate the live descriptor fixture');
  assert.equal(installer.version, version);
  assert.equal(installer.format, 'dmg');
  assert.equal(installer.url, entries.find(entry => entry.name.endsWith('.dmg')).url);
  assert.equal(installer.publishedAt, publishedAt);
});

for (const legacy of [true, false]) {
  test(`refuses downgrading an existing ${legacy ? 'legacy ZIP native installer' : 'native top-level'} feed`, t => {
    const { entries } = fixture(t);
    const feed = readManifest(collectUpdateFeeds(entries, version, publishedAt)
      .find(entry => targetOf(entry) === 'darwin-arm64'));
    const previous = legacy ? { ...legacyDownload(), installer: { ...feed.installer, version: '2.0.0' } }
      : { ...feed, version: '2.0.0', installer: undefined };
    assert.throws(() => collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous }));
  });

  for (const field of ['url', 'size', 'sha256']) {
    test(`refuses same-version ${field} conflicts in an existing ${legacy ? 'legacy ZIP native installer' : 'native top-level'} feed`, t => {
      const { entries } = fixture(t);
      const feed = readManifest(collectUpdateFeeds(entries, version, publishedAt)
        .find(entry => targetOf(entry) === 'darwin-arm64'));
      const changed = { ...feed.installer, [field]: field === 'url'
        ? 'https://cdn.keepwork.com/different-installer.dmg'
        : field === 'size' ? feed.installer.size + 1 : 'f'.repeat(64) };
      const previous = legacy ? { ...legacyDownload(), installer: changed }
        : { ...feed, ...changed, installer: undefined };
      assert.throws(() => collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous }));
    });
  }
}

test('an identical installer can be republished while retaining legacy ZIP fields', t => {
  const { entries } = fixture(t);
  const feed = readManifest(collectUpdateFeeds(entries, version, publishedAt)
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  const previous = { ...legacyDownload(), installer: feed.installer };
  const next = readManifest(collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous })
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  assert.deepEqual(next, previous);
});

test('a historical installer without its own version inherits the legacy descriptor version', t => {
  const { entries } = fixture(t);
  const previous = {
    ...legacyDownload(),
    installer: {
      format: 'dmg', fileName: 'Previous.dmg', url: 'https://cdn.keepwork.com/Previous.dmg',
      size: 55, sha256: 'b'.repeat(64),
    },
  };
  const manifest = readManifest(collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous })
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  assert.equal(manifest.version, previous.version, 'legacy ZIP release identity remains unchanged');
  assert.equal(manifest.url, previous.url);
  assert.equal(manifest.installer.version, version);
  assert.equal(manifest.installer.url, entries.find(entry => entry.name.endsWith('.dmg')).url);
  assert.throws(() => collectUpdateFeeds(entries, version, publishedAt,
    { 'darwin-arm64': { ...previous, version: '9.0.0' } }), /downgrade/i,
    'the missing nested version must not bypass the older format version fallback');
});

test('a standalone legacy ZIP release version does not block the independent native installer stream', t => {
  const { entries } = fixture(t);
  const previous = { ...legacyDownload(), version: '9.0.0' };
  const manifest = readManifest(collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous })
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  assert.equal(manifest.version, '9.0.0');
  assert.equal(manifest.sha256, previous.sha256);
  assert.equal(manifest.url, previous.url);
  assert.equal(manifest.installer.version, version);
});

test('a same-version historical installer without its own version cannot change identity', t => {
  const { entries } = fixture(t);
  const native = readManifest(collectUpdateFeeds(entries, version, publishedAt)
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  const { version: _version, ...unversioned } = native.installer;
  const previous = { ...legacyDownload(), version, installer: unversioned };
  const manifest = readManifest(collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous })
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  assert.equal(manifest.installer.version, version);
  assert.equal(manifest.installer.url, unversioned.url);
  assert.throws(() => collectUpdateFeeds(entries, version, publishedAt, {
    'darwin-arm64': { ...previous, installer: { ...unversioned, sha256: 'c'.repeat(64) } },
  }), /different installer/i);
});

test('an identical native installer preserves its original publication date across retries', t => {
  const { entries } = fixture(t);
  const previous = readManifest(collectUpdateFeeds(entries, version, publishedAt)
    .find(entry => targetOf(entry) === 'darwin-arm64'));
  const manifest = readManifest(collectUpdateFeeds(entries, version, '2026-11-14T08:00:00.000Z',
    { 'darwin-arm64': previous }).find(entry => targetOf(entry) === 'darwin-arm64'));
  assert.equal(manifest.publishedAt, publishedAt);
  assert.equal(manifest.installer.publishedAt, publishedAt);
});

test('invalid live descriptor values are rejected instead of being replaced as absent feeds', t => {
  const { entries } = fixture(t);
  for (const previous of [null, false, 0, '', [], 'invalid', { product: 'another-product' }]) {
    assert.throws(() => collectUpdateFeeds(entries, version, publishedAt, { 'darwin-arm64': previous }),
      /Invalid existing desktop update feed/, `must reject ${JSON.stringify(previous)}`);
  }
});

function publication(entries, { previousByTarget = {}, failAt } = {}) {
  const config = { bucket: 'fixture-bucket' };
  const events = [];
  const feedUploads = [];
  const dependencies = {
    fetchImpl: async url => {
      const withoutQuery = new URL(url);
      withoutQuery.search = '';
      const target = targets.find(target => feedUrl(target) === withoutQuery.href);
      if (target) {
        events.push(`read-feed:${target}`);
        return previousByTarget[target]
          ? Response.json(previousByTarget[target]) : new Response('', { status: 404 });
      }
      const installer = entries.find(entry => entry.url === withoutQuery.href);
      assert.ok(installer, `unexpected publication request ${url}`);
      events.push(`read-installer:${installer.name}`);
      return new Response('', { status: 404 });
    },
    transport: {
      uploadEntry: async (actualConfig, entry) => {
        const target = targetOf(entry);
        if (target) {
          assert.notEqual(actualConfig.insertOnly, true, 'latest-client.json must remain mutable');
          feedUploads.push({ target, manifest: readManifest(entry) });
          events.push(`upload-feed:${target}`);
        } else {
          assert.equal(actualConfig.insertOnly, true, 'versioned installers must remain immutable');
          assert.ok(entries.some(installer => installer.url === entry.url));
          events.push(`upload-installer:${entry.name}`);
        }
      },
      refreshUrls: async (_config, urls) => {
        const isFeed = urls.every(url => targets.some(target => feedUrl(target) === url));
        assert.ok(isFeed || urls.every(url => entries.some(entry => entry.url === url)));
        events.push(isFeed ? 'refresh-feeds' : 'refresh-installers');
      },
      verifyEntriesWithRetry: async (verifiedEntries, _attempts, _delay, cacheBust) => {
        assert.equal(cacheBust, false, 'verify the actual cached URLs clients will request');
        const isFeed = verifiedEntries.every(entry => targetOf(entry));
        if (isFeed) {
          assert.deepEqual(verifiedEntries.map(targetOf).sort(), [...targets].sort());
          events.push('verify-feeds');
          if (failAt === 'verify-feeds') throw Error('fixture feed CDN verification failure');
        } else {
          assert.deepEqual(verifiedEntries.map(entry => entry.url).sort(), entries.map(entry => entry.url).sort());
          events.push('verify-installers');
          if (failAt === 'verify-installers') throw Error('fixture installer CDN verification failure');
        }
      },
    },
    github: {
      readBody: async () => { events.push('read-notes'); return 'Existing release notes'; },
      writeBody: async () => { events.push('write-notes'); },
    },
  };
  return { config, events, feedUploads, dependencies };
}

test('switches automatic-update feeds only after every immutable installer is verified', async t => {
  const { entries } = fixture(t);
  const old = legacyDownload();
  const run = publication(entries, { previousByTarget: { 'darwin-arm64': old } });
  await publishRelease(entries, run.config, run.dependencies);
  assert.deepEqual(run.events.filter(event => event.startsWith('read-feed:')).sort(),
    targets.map(target => `read-feed:${target}`).sort());
  const firstMutation = run.events.findIndex(event => event.startsWith('upload-'));
  for (const target of targets) assert.ok(run.events.indexOf(`read-feed:${target}`) < firstMutation);
  assert.deepEqual(run.feedUploads.map(entry => entry.target).sort(), [...targets].sort());
  for (const target of targets) assert.ok(run.events.indexOf('verify-installers') < run.events.indexOf(`upload-feed:${target}`));
  assert.ok(run.events.indexOf('refresh-feeds') < run.events.indexOf('verify-feeds'));
  assert.ok(run.events.indexOf('verify-feeds') < run.events.indexOf('read-notes'));
  assert.ok(run.events.indexOf('read-notes') < run.events.indexOf('write-notes'));
  const { installer, ...preserved } = run.feedUploads.find(entry => entry.target === 'darwin-arm64').manifest;
  assert.deepEqual(preserved, old);
  assert.equal(installer.version, version);
});

test('a newer live feed aborts publication before uploads, refreshes or release-note writes', async t => {
  const { entries } = fixture(t);
  const run = publication(entries, {
    previousByTarget: { 'darwin-arm64': { ...legacyDownload(), installer: { version: '9.0.0' } } },
  });
  await assert.rejects(publishRelease(entries, run.config, run.dependencies));
  assert.ok(run.events.every(event => event.startsWith('read-')));
  assert.equal(run.feedUploads.length, 0);
});

for (const failAt of ['verify-installers', 'verify-feeds']) {
  test(`${failAt} failure never publishes success in GitHub notes`, async t => {
    const { entries } = fixture(t);
    const run = publication(entries, { failAt });
    await assert.rejects(publishRelease(entries, run.config, run.dependencies));
    assert.equal(run.events.includes('read-notes'), false);
    assert.equal(run.events.includes('write-notes'), false);
    if (failAt === 'verify-installers') assert.equal(run.feedUploads.length, 0);
  });
}
