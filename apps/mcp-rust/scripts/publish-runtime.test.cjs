const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { packageRuntime } = require('./package-runtime.cjs');
const { collectRelease, publishRelease } = require('./publish-runtime.cjs');
const evidence = require('../../../scripts/rust-validation-evidence.cjs');
const { readRuntimeArchive } = require('../../../scripts/lib/runtime-archive.cjs');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-rust-publication-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const info = { marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust', version: '0.2.51',
    commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), target: 'aarch64-apple-darwin',
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' }, endMarker: 'keepwork-mcp-build-end' };
  const binary = path.join(directory, 'binary');
  fs.writeFileSync(binary, Buffer.from('nonexecutable fixture\0' + JSON.stringify(info)));
  const output = path.join(directory, 'package');
  packageRuntime({ binary, target: info.target, output, expected: info });
  const options = { version: info.version, commit: info.commit, target: 'macos-arm64' };
  const release = collectRelease(output, options);
  const log = path.join(directory, 'fixture.log'); fs.writeFileSync(log, 'Synthetic publication test fixture only; no live acceptance is claimed.\n');
  const sourceHash = 'c'.repeat(64);
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), product: 'mcp-rust', version: info.version,
    commit: info.commit, sourceHash, sourceDirty: false, platform: 'macos', arch: 'arm64',
    artifact: { path: path.relative(directory, release.archive.filePath), sha256: release.archive.sha256, size: release.archive.size, signing: { status: 'not-applicable' } },
    runtime: { engine: 'rust', version: info.version, commit: info.commit, owner: 'desktop', capabilities: info.capabilities, source: 'build-info' }, web: null,
    checks: evidence.gates['mcp-rust'].map(id => ({ id, status: 'passed', level: id === 'source-checks' ? 'source' : id === 'fixture-contracts' ? 'fixture'
      : ['cli-live', 'messaging-live'].includes(id) ? 'live' : 'packaged', sourceHash, evidence: ['fixture.log'], evidenceSha256: { 'fixture.log': digest(fs.readFileSync(log)) },
      ...(['cli-live', 'messaging-live'].includes(id) ? { requirements: ['real-account', 'network'] } : {}) })), overallStatus: 'passed' };
  const reportFile = path.join(directory, 'report.json');
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); save();
  return { directory, output, options, release, report, reportFile, save };
}

function publication(release, { previous, archiveBytes, feedStatus = 404, failVerification = false } = {}) {
  const events = [], promoted = [];
  return {
    events, promoted,
    dependencies: {
      now: () => '2026-11-13T10:00:00.000Z',
      fetchImpl: async url => {
        const actual = new URL(url); actual.search = '';
        if (actual.href === release.feedUrl) {
          events.push('read-feed');
          return previous ? Response.json(previous) : new Response('', { status: feedStatus });
        }
        assert.equal(actual.href, release.archive.url);
        events.push('read-archive');
        return archiveBytes ? new Response(archiveBytes) : new Response('', { status: 404 });
      },
      transport: {
        uploadEntry: async (config, entry) => {
          const feed = entry.url === release.feedUrl;
          assert.equal(config.insertOnly, !feed);
          if (feed) {
            assert.equal(entry.mimeType, 'application/json');
            assert.equal(entry.cacheControl, 'public, max-age=60, must-revalidate');
          } else {
            assert.equal(entry.cacheControl, undefined, 'immutable archives retain the existing upload metadata');
          }
          events.push(feed ? 'upload-feed' : 'upload-archive');
          if (feed) promoted.push(JSON.parse(fs.readFileSync(entry.filePath, 'utf8')));
        },
        refreshUrls: async (_config, urls) => events.push(urls[0] === release.feedUrl ? 'refresh-feed' : 'refresh-archive'),
        verifyEntriesWithRetry: async (entries, _attempts, _delay, cacheBust) => {
          assert.equal(cacheBust, false);
          const feed = entries[0].url === release.feedUrl;
          events.push(feed ? 'verify-feed' : 'verify-archive');
          if (!feed && failVerification) throw Error('fixture CDN mismatch');
        },
      },
    },
  };
}

test('final package discovery validates target, archive bytes, runtime metadata and compiled identity', t => {
  const { release, output, options } = fixture(t);
  assert.equal(release.metadata.engine, 'rust');
  assert.equal(release.feedUrl, 'https://cdn.keepwork.com/keepwork/mcp-stable-rs/macos-arm64.json');
  assert.throws(() => collectRelease(output, { ...options, version: '0.2.50' }), /identity/);
  fs.appendFileSync(release.archive.filePath, 'corruption');
  assert.throws(() => collectRelease(output, options), /size\/SHA-256/);
});

test('archive inspection rejects traversal, symlinks, truncation and expanded-size abuse without extraction', t => {
  const { release } = fixture(t), original = fs.readFileSync(release.archive.filePath);
  assert.ok(readRuntimeArchive(original).get('runtime.json'));
  const central = original.indexOf(Buffer.from('PK\x01\x02'));
  const symlink = Buffer.from(original); symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  assert.throws(() => readRuntimeArchive(symlink), /Unsafe/);
  const oversized = Buffer.from(original); oversized.writeUInt32LE(64 * 1024 * 1024, central + 24);
  assert.throws(() => readRuntimeArchive(oversized), /oversized/);
  const traversal = Buffer.from(original);
  const license = traversal.indexOf(Buffer.from('LICENSE'), central);
  Buffer.from('../evil').copy(traversal, license);
  assert.throws(() => readRuntimeArchive(traversal), /Unsafe/);
  assert.throws(() => readRuntimeArchive(original.subarray(0, original.length - 1)), /ZIP/);
});

test('publishes immutable archive and verifies it before promoting the stable version file', async t => {
  const { release, reportFile } = fixture(t), run = publication(release);
  const result = await publishRelease(release, {}, { ...run.dependencies, reportFile });
  assert.deepEqual(run.events, ['read-feed', 'read-archive', 'upload-archive', 'refresh-archive', 'verify-archive', 'upload-feed', 'refresh-feed', 'verify-feed']);
  assert.equal(result.manifest.publishedAt, '2026-11-13T10:00:00.000Z');
  assert.equal(result.manifest.builtAt, undefined, 'upload time must not invent a build date');
  assert.deepEqual(run.promoted[0], result.manifest);
});

test('an identical retry reuses immutable bytes and retains the first publication time', async t => {
  const { release, reportFile } = fixture(t);
  const oldDate = '2026-11-12T08:00:00Z';
  const run = publication(release, { previous: { ...release.metadata, publishedAt: oldDate }, archiveBytes: fs.readFileSync(release.archive.filePath) });
  const result = await publishRelease(release, {}, { ...run.dependencies, reportFile });
  assert.equal(run.events.includes('upload-archive'), false);
  assert.equal(result.manifest.publishedAt, oldDate);
});

test('missing, dirty, incomplete or wrong-archive evidence prevents even the first CDN request', async t => {
  const { release, report, reportFile, save } = fixture(t);
  for (const mutate of [() => { report.sourceDirty = true; }, () => { report.sourceDirty = false; report.artifact.sha256 = 'd'.repeat(64); },
    () => { report.artifact.sha256 = release.archive.sha256; report.overallStatus = 'pending'; report.checks[0].status = 'pending'; report.checks[0].reason = 'fixture pending gate'; }]) {
    mutate(); save(); const run = publication(release);
    await assert.rejects(publishRelease(release, {}, { ...run.dependencies, reportFile }));
    assert.deepEqual(run.events, []);
  }
  await assert.rejects(publishRelease(release, {}, {}), /complete release acceptance/);
});

test('downgrades, same-version conflicts, unavailability and immutable-byte conflicts make no writes', async t => {
  const { release, reportFile } = fixture(t);
  for (const options of [{ previous: { ...release.metadata, version: '9.0.0' } },
    { previous: { ...release.metadata, sha256: 'f'.repeat(64) } }, { feedStatus: 503 }, { archiveBytes: Buffer.from('different archive') }]) {
    const run = publication(release, options);
    await assert.rejects(publishRelease(release, {}, { ...run.dependencies, reportFile }));
    assert.ok(run.events.every(event => event.startsWith('read-')));
  }
});

test('failed public archive verification never promotes a feed', async t => {
  const { release, reportFile } = fixture(t), run = publication(release, { failVerification: true });
  await assert.rejects(publishRelease(release, {}, { ...run.dependencies, reportFile }), /CDN mismatch/);
  assert.equal(run.events.includes('upload-feed'), false);
});

test('CLI defaults to review only and needs no credentials or acceptance relabeling', t => {
  const { output, options } = fixture(t);
  const child = spawnSync(process.execPath, [path.join(__dirname, 'publish-runtime.cjs'), '--release-dir', output,
    '--target', options.target, '--version', options.version, '--commit', options.commit], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /dry-run; no upload or feed promotion/);
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/mcp-rust-publish.yml'), 'utf8');
  assert.match(workflow, /default: false/); assert.match(workflow, /environment: rust-runtime-stable/); assert.match(workflow, /--report/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
});
