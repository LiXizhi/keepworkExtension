const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectReleaseFiles,
  createMultipartParts,
  normalizePrefix,
  runtimeArchiveName,
} = require('./publish-qiniu-release.cjs');

test('collects runtime release files in publication order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mcp-qiniu-'));
  try {
    const version = '0.1.0';
    const platform = 'windows';
    const arch = 'x64';
    const archive = runtimeArchiveName(version, platform, arch);
    fs.writeFileSync(path.join(dir, archive), 'archive');
    fs.writeFileSync(path.join(dir, `latest-${platform}-${arch}.json`), JSON.stringify({
      version,
      platform,
      arch,
      fileName: archive,
      url: `https://cdn.keepwork.com/keepwork/node-runtimes/keepwork-mcp/${archive}`,
      size: Buffer.byteLength('archive'),
      sha256: crypto.createHash('sha256').update('archive').digest('hex'),
    }));
    const entries = collectReleaseFiles(
      dir,
      version,
      platform,
      arch,
      'keepwork/node-runtimes/keepwork-mcp/',
      'https://cdn.keepwork.com',
    );
    assert.deepEqual(entries.map((entry) => entry.name), [archive, `latest-${platform}-${arch}.json`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe CDN prefixes', () => {
  assert.throws(() => normalizePrefix('../release'), /Invalid CDN prefix/);
  assert.throws(() => normalizePrefix('/absolute/release'), /Invalid CDN prefix/);
  assert.throws(() => normalizePrefix('release\\other'), /Invalid CDN prefix/);
});

test('multipart upload includes the remote key', () => {
  const { header } = createMultipartParts('token', 'keepwork/node-runtimes/file.zip', 'file.zip');
  assert.match(header.toString('utf8'), /name="key"\r\n\r\nkeepwork\/node-runtimes\/file\.zip\r\n/);
});
