const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  collectReleaseFiles,
  createMultipartParts,
  createPartRanges,
  createQBoxAuthorization,
  createUploadToken,
  multipartBasePath,
  normalizePrefix,
  normalizeVersion,
} = require('./publish-qiniu-release.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-qiniu-release-'));
  const version = '0.1.15';
  const installer = `KP-Local-Helper-Setup-${version}-x64.exe`;
  fs.writeFileSync(path.join(dir, installer), 'installer');
  fs.writeFileSync(path.join(dir, `${installer}.blockmap`), 'blockmap');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\npath: ${installer}\n`);
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    version,
    fileName: installer,
    url: `https://cdn.keepwork.com/keepwork/releases/${installer}`,
    size: 9,
    sha256: crypto.createHash('sha256').update('installer').digest('hex'),
  }));
  return { dir, version, installer };
}

test('collects release files in publication order', () => {
  const { dir, version, installer } = fixture();
  try {
    const entries = collectReleaseFiles(dir, version, 'keepwork/releases/', 'https://cdn.keepwork.com');
    assert.deepEqual(entries.map((entry) => entry.name), [installer, `${installer}.blockmap`, 'latest.yml', 'latest.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe prefixes and mismatched manifests', () => {
  assert.throws(() => normalizePrefix('../release'), /Invalid CDN prefix/);
  assert.throws(() => normalizePrefix('/absolute/release'), /Invalid CDN prefix/);
  assert.throws(() => normalizePrefix('release\\other'), /Invalid CDN prefix/);
  assert.throws(() => normalizeVersion('../../release'), /stable X.Y.Z/);
  const { dir, version } = fixture();
  try {
    const manifestPath = path.join(dir, 'latest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => collectReleaseFiles(dir, version, 'keepwork/releases/', 'https://cdn.keepwork.com'), /SHA-256/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI dry-run validates files without requiring credentials', () => {
  const { dir, version, installer } = fixture();
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'publish-qiniu-release.cjs'),
      '--release-dir', dir,
      '--version', version,
      '--bucket', 'haqi',
      '--prefix', 'keepwork/releases/',
      '--domain', 'https://cdn.keepwork.com',
      '--upload-host', 'https://up-z2.qiniup.com',
      '--dry-run',
    ], { encoding: 'utf8', env: {} });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(installer.replaceAll('.', '\\.')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creates scoped upload and QBox path signatures', () => {
  const uploadToken = createUploadToken('access', 'secret', 'bucket', 'prefix/file.exe', 2_000_000_000);
  assert.match(uploadToken, /^access:[A-Za-z0-9_=-]+:[A-Za-z0-9_=-]+$/);

  const expectedSignature = crypto.createHmac('sha1', 'secret').update('/v2/tune/refresh\n').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(
    createQBoxAuthorization('access', 'secret', 'https://fusion.qiniuapi.com/v2/tune/refresh'),
    `QBox access:${expectedSignature}`,
  );
});

test('creates a bounded multipart form for streaming uploads', () => {
  const parts = createMultipartParts('upload-token', 'keepwork/releases/file.exe', 'file.exe');
  const header = parts.header.toString('utf8');
  const footer = parts.footer.toString('utf8');
  assert.match(parts.boundary, /^----kp-local-helper-[a-f0-9]{24}$/);
  assert.match(header, /name="token"\r\n\r\nupload-token\r\n/);
  assert.match(header, /name="key"\r\n\r\nkeepwork\/releases\/file\.exe\r\n/);
  assert.match(header, /name="file"; filename="file\.exe"/);
  assert.equal(footer, `\r\n--${parts.boundary}--\r\n`);
});

test('splits large files into ordered multipart v2 ranges', () => {
  assert.deepEqual(createPartRanges(9, 4), [
    { partNumber: 1, start: 0, end: 3, size: 4 },
    { partNumber: 2, start: 4, end: 7, size: 4 },
    { partNumber: 3, start: 8, end: 8, size: 1 },
  ]);
  assert.equal(
    multipartBasePath(
      { bucket: 'haqi' },
      { remoteKey: 'keepwork/releases/file.exe' },
    ),
    '/buckets/haqi/objects/a2VlcHdvcmsvcmVsZWFzZXMvZmlsZS5leGU=/uploads',
  );
});
