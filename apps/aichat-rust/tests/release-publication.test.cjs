const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectReleaseFiles, updateReleaseBody, publishRelease } = require('../scripts/publish-release.cjs');

const version = '1.2.3';
const names = [
  `Keepwork_${version}_x64-setup.exe`,
  `Keepwork_${version}_arm64-setup.exe`,
  `Keepwork_${version}_universal.dmg`,
];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const updateTargets = ['win32-x64', 'win32-arm64', 'darwin-universal'];
const feedUrl = target => `https://cdn.keepwork.com/keepwork/aichat-rust/${target}/latest-client.json`;
const preflightFeeds = () => updateTargets.map(target => `preflight-feed:${target}`);
const publishFeeds = () => [
  ...updateTargets.map(target => `upload-feed:${target}`), 'refresh-feeds', 'verify-feeds',
];
const feedTarget = url => updateTargets.find(target => new URL(url).pathname === new URL(feedUrl(target)).pathname);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-release-publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `installer fixture for ${name}`);
  // Provenance and checksum files are not downloadable application installers.
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), '{}');
  return { dir, entries: collectReleaseFiles(dir, version) };
}

function publication(entries, {
  body = '原有发布说明\n\n- 保留原有验收记录。\n', response, feedResponse, failAt,
  refreshedUrls = entries.map(entry => entry.url),
} = {}) {
  const events = [], writes = [];
  const config = { accessKey: 'fixture access key', secretKey: 'fixture secret key' };
  const dependencies = {
    fetchImpl: async url => {
      const target = feedTarget(url);
      if (target) {
        events.push(`preflight-feed:${target}`);
        if (failAt === 'preflight-feed') throw new Error('fixture feed preflight unavailable');
        return feedResponse ? feedResponse(target) : new Response('', { status: 404 });
      }
      const entry = entries.find(item => new URL(url).pathname === new URL(item.url).pathname);
      assert.ok(entry, `unexpected preflight URL ${url}`);
      events.push(`preflight:${entry.name}`);
      if (failAt === 'preflight') throw new Error('fixture preflight unavailable');
      return response ? response(entry) : new Response('', { status: 404 });
    },
    transport: {
      uploadEntry: async (actualConfig, entry) => {
        const target = feedTarget(entry.url);
        if (target) {
          assert.deepEqual(actualConfig, { ...config, insertOnly: false });
          events.push(`upload-feed:${target}`);
          if (failAt === 'upload-feed') throw new Error('fixture feed upload failure');
          const bytes = fs.readFileSync(entry.filePath);
          assert.equal(entry.size, bytes.length);
          assert.equal(entry.sha256, digest(bytes));
          return;
        }
        assert.deepEqual(actualConfig, { ...config, insertOnly: true });
        assert.ok(entries.some(installer => installer.url === entry.url && installer.remoteKey === entry.remoteKey),
          `unexpected publication upload ${entry.url}`);
        events.push(`upload:${entry.name}`);
        if (failAt === 'upload') throw new Error('fixture upload failure');
      },
      refreshUrls: async (actualConfig, urls) => {
        assert.equal(actualConfig, config);
        if (urls.some(url => feedTarget(url))) {
          assert.deepEqual(urls, updateTargets.map(feedUrl));
          events.push('refresh-feeds');
          if (failAt === 'refresh-feeds') throw new Error('fixture feed refresh failure');
          return;
        }
        assert.deepEqual(urls, refreshedUrls);
        events.push('refresh');
        if (failAt === 'refresh') throw new Error('fixture refresh failure');
      },
      verifyEntriesWithRetry: async (actualEntries, _attempts, _delayMs, cacheBust) => {
        assert.equal(cacheBust, false, 'verify the exact download URLs included in release notes');
        if (actualEntries.some(entry => feedTarget(entry.url))) {
          assert.deepEqual(actualEntries.map(entry => feedTarget(entry.url)), updateTargets);
          events.push('verify-feeds');
          if (failAt === 'verify-feeds') throw new Error('fixture feed CDN checksum mismatch');
          return;
        }
        assert.deepEqual(actualEntries, entries);
        events.push('verify');
        if (failAt === 'verify') throw new Error('fixture CDN checksum mismatch');
      },
    },
    github: {
      readBody: async () => {
        events.push('read-body');
        if (failAt === 'read-body') throw new Error('fixture GitHub read failure');
        return body;
      },
      writeBody: async text => {
        events.push('write-body');
        writes.push(text);
      },
    },
  };
  return { events, writes, config, dependencies };
}

test('collects three installers with version-specific CDN URLs and hashes of their actual bytes', t => {
  const { dir, entries } = fixture(t);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...names].sort());
  for (const entry of entries) {
    assert.ok(entry.label);
    assert.equal(entry.filePath, path.join(dir, entry.name));
    assert.equal(entry.remoteKey, `keepwork/aichat-rust/${version}/${entry.name}`);
    assert.equal(entry.url, `https://cdn.keepwork.com/${entry.remoteKey}`);
    const bytes = fs.readFileSync(entry.filePath);
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, digest(bytes));
  }
});

for (const name of names) {
  test(`rejects a release missing ${name}`, t => {
    const { dir } = fixture(t);
    fs.unlinkSync(path.join(dir, name));
    assert.throws(() => collectReleaseFiles(dir, version));
  });
}

test('rejects an empty installer, mixed release versions, and unexpected installer names', t => {
  for (const extraName of [`Keepwork_1.2.2_x64-setup.exe`, 'unreviewed-setup.exe', 'other.dmg']) {
    const { dir } = fixture(t);
    fs.writeFileSync(path.join(dir, extraName), 'unexpected installer');
    assert.throws(() => collectReleaseFiles(dir, version), extraName);
  }
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, names[0]), '');
  assert.throws(() => collectReleaseFiles(dir, version));
});

test('rejects versions that could escape or change the release URL path', t => {
  const { dir } = fixture(t);
  for (const invalid of ['', '../1.2.3', '1.2.3/next', '1.2.3?other', '01.2.3', '1.2']) {
    assert.throws(() => collectReleaseFiles(dir, invalid), invalid);
  }
});

test('CLI dry-run previews all three CDN links without credentials, GitHub access, or success claims', t => {
  const { dir, entries } = fixture(t);
  const output = execFileSync(process.execPath, [
    path.join(__dirname, '../scripts/publish-release.cjs'),
    '--release-dir', dir, '--version', version, '--dry-run',
  ], { encoding: 'utf8', env: {} });
  for (const entry of entries) assert.ok(output.includes(entry.url));
  for (const target of updateTargets) assert.ok(output.includes(feedUrl(target)));
  assert.equal((output.match(/latest-client\.json/g) || []).length, 3);
  assert.doesNotMatch(output, /aichat-desktop|aichat-cef|darwin-(x64|arm64)/);
  assert.match(output, /Windows.*x64/i);
  assert.match(output, /Windows.*ARM64/i);
  assert.match(output, /macOS.*Universal/i);
  assert.doesNotMatch(output, /发布成功|已上传|已发布|published|uploaded/i);
  assert.equal(output.includes(dir), false);
});

test('prepends all three complete CDN URLs and preserves the existing release notes', t => {
  const { dir, entries } = fixture(t);
  const body = '本版功能说明\n\n- 已验证安装包。\n\n源码提交：`abc123`\n';
  const updated = updateReleaseBody(body, entries);
  assert.ok(updated.endsWith(body));
  assert.match(updated, /Windows.*x64/i);
  assert.match(updated, /Windows.*ARM64/i);
  assert.match(updated, /macOS.*Universal/i);
  for (const entry of entries) {
    assert.ok(updated.includes(entry.url));
    assert.ok(updated.indexOf(entry.url) < updated.indexOf(body));
  }
  assert.equal(updated.includes(dir), false);
  assert.equal(updated.includes('fixture secret key'), false);
});

test('a rerun replaces the generated links block without duplication or lost notes', t => {
  const { entries } = fixture(t);
  const body = '人工发布说明\n\n保留测试结果和其他下载说明。\n';
  const once = updateReleaseBody(body, entries);
  assert.equal(updateReleaseBody(once, entries), once);
  const laterEntries = entries.map(entry => ({ ...entry, url: entry.url.replace('/1.2.3/', '/1.2.4/') }));
  const replaced = updateReleaseBody(once, laterEntries);
  assert.ok(replaced.endsWith(body));
  for (const entry of laterEntries) assert.ok(replaced.includes(entry.url));
  for (const entry of entries) assert.equal(replaced.includes(entry.url), false);
});

test('an empty release body still receives a complete, repeatable downloads block', t => {
  const { entries } = fixture(t);
  const updated = updateReleaseBody('', entries);
  for (const entry of entries) assert.ok(updated.includes(entry.url));
  assert.equal(updateReleaseBody(updated, entries), updated);
});

test('rejects incomplete or duplicated generated blocks instead of corrupting human-written notes', t => {
  const { entries } = fixture(t);
  const start = '<!-- keepwork-cdn-downloads:start -->';
  const end = '<!-- keepwork-cdn-downloads:end -->';
  for (const body of [start + '\n人工说明', '人工说明\n' + end, end + '\n' + start,
    `${start}\n${end}\n${start}\n${end}`, `${start}\n${start}\n${end}`]) {
    assert.throws(() => updateReleaseBody(body, entries));
  }
});

test('preflights every immutable object and verifies all CDN downloads before editing GitHub notes', async t => {
  const { entries } = fixture(t);
  const run = publication(entries);
  await publishRelease(entries, run.config, run.dependencies);
  assert.deepEqual(run.events, [
    ...entries.map(entry => `preflight:${entry.name}`),
    ...preflightFeeds(),
    ...entries.map(entry => `upload:${entry.name}`),
    'refresh', 'verify', ...publishFeeds(), 'read-body', 'write-body',
  ]);
  assert.equal(run.writes.length, 1);
  for (const entry of entries) assert.ok(run.writes[0].includes(entry.url));
  assert.ok(run.writes[0].endsWith('原有发布说明\n\n- 保留原有验收记录。\n'));
});

test('accepts a rerun only when existing CDN objects have identical size and SHA-256', async t => {
  const { entries } = fixture(t);
  const run = publication(entries, { response: entry => new Response(fs.readFileSync(entry.filePath)) });
  await publishRelease(entries, run.config, run.dependencies);
  assert.equal(run.writes.length, 1);
  assert.equal(run.events.some(event => event.startsWith('upload:')), false);
  assert.equal(run.events.includes('refresh'), false);
  assert.deepEqual(run.events.filter(event => event.startsWith('upload-feed:')),
    updateTargets.map(target => `upload-feed:${target}`));
  assert.ok(run.events.indexOf('verify') < run.events.indexOf('write-body'));
});

test('a partial rerun uploads and refreshes only missing objects, then verifies all three links', async t => {
  const { entries } = fixture(t);
  const missing = entries[1];
  const run = publication(entries, {
    response: entry => entry === missing ? new Response('', { status: 404 }) : new Response(fs.readFileSync(entry.filePath)),
    refreshedUrls: [missing.url],
  });
  await publishRelease(entries, run.config, run.dependencies);
  assert.deepEqual(run.events.filter(event => event.startsWith('upload:')), [`upload:${missing.name}`]);
  assert.equal(run.writes.length, 1);
  assert.ok(run.events.indexOf('refresh') < run.events.indexOf('verify'));
});

test('a later conflicting CDN object prevents every upload and leaves GitHub untouched', async t => {
  const { entries } = fixture(t);
  // Keep the size identical, so accepting based on byte count alone would fail this test.
  const run = publication(entries, { response: entry => entry === entries[1]
    ? new Response(Buffer.alloc(entry.size, 'x')) : new Response('', { status: 404 }) });
  await assert.rejects(publishRelease(entries, run.config, run.dependencies));
  assert.ok(run.events.some(event => event === `preflight:${entries[1].name}`));
  assert.ok(run.events.every(event => event.startsWith('preflight:')));
  assert.equal(run.writes.length, 0);
});

test('a stale CDN 404 cannot overwrite a storage object or publish links when insert-only upload conflicts', async t => {
  const { entries } = fixture(t);
  const run = publication(entries);
  run.config.insertOnly = false;
  const original = Buffer.from('previously published installer');
  const objects = new Map([[entries[0].remoteKey, original]]);
  run.dependencies.transport.uploadEntry = async (actualConfig, entry) => {
    run.events.push(`upload:${entry.name}`);
    if (actualConfig.insertOnly === true && objects.has(entry.remoteKey)) {
      throw new Error('Qiniu upload failed: HTTP 614 file exists');
    }
    objects.set(entry.remoteKey, fs.readFileSync(entry.filePath));
  };
  await assert.rejects(publishRelease(entries, run.config, run.dependencies), /HTTP 614/);
  assert.deepEqual(run.events, [
    ...entries.map(entry => `preflight:${entry.name}`),
    ...preflightFeeds(),
    `upload:${entries[0].name}`,
  ]);
  assert.equal(objects.size, 1);
  assert.deepEqual(objects.get(entries[0].remoteKey), original);
  assert.equal(run.config.insertOnly, false, 'mandatory upload policy must not mutate the caller config');
  assert.equal(run.writes.length, 0);
});

test('an unavailable CDN must not be interpreted as a missing immutable object', async t => {
  const { entries } = fixture(t);
  const run = publication(entries, { response: () => new Response('', { status: 503 }) });
  await assert.rejects(publishRelease(entries, run.config, run.dependencies));
  assert.ok(run.events.every(event => event.startsWith('preflight:')));
  assert.equal(run.writes.length, 0);
});

const failureMessages = {
  preflight: 'fixture preflight unavailable',
  'preflight-feed': 'fixture feed preflight unavailable',
  upload: 'fixture upload failure',
  refresh: 'fixture refresh failure',
  verify: 'fixture CDN checksum mismatch',
  'upload-feed': 'fixture feed upload failure',
  'refresh-feeds': 'fixture feed refresh failure',
  'verify-feeds': 'fixture feed CDN checksum mismatch',
  'read-body': 'fixture GitHub read failure',
};
for (const [failAt, expectedMessage] of Object.entries(failureMessages)) {
  test(`${failAt} failure leaves the existing GitHub release body untouched`, async t => {
    const { entries } = fixture(t);
    const run = publication(entries, { failAt });
    await assert.rejects(publishRelease(entries, run.config, run.dependencies),
      { message: expectedMessage }, 'must reach the intended failure rather than fail earlier in an unrelated mock');
    assert.equal(run.writes.length, 0);
    assert.equal(run.events.includes('write-body'), false);
    if (failAt !== 'read-body') assert.equal(run.events.includes('read-body'), false);
  });
}

test('an unavailable update feed prevents every upload instead of replacing it as an absent feed', async t => {
  const { entries } = fixture(t);
  const run = publication(entries, { feedResponse: () => new Response('', { status: 503 }) });
  await assert.rejects(publishRelease(entries, run.config, run.dependencies), /Desktop feed preflight HTTP 503/);
  assert.equal(run.events.some(event => event.startsWith('upload')), false);
  assert.equal(run.events.includes('read-body'), false);
});

test('malformed live update JSON prevents installer or feed writes', async t => {
  const { entries } = fixture(t);
  const run = publication(entries, { feedResponse: () => new Response('{invalid json') });
  await assert.rejects(publishRelease(entries, run.config, run.dependencies), SyntaxError);
  assert.equal(run.events.some(event => event.startsWith('upload')), false);
  assert.equal(run.events.includes('read-body'), false);
});
