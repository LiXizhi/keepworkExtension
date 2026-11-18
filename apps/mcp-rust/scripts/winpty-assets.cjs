// Pinned, unmodified official WinPTY 0.4.3 x64 assets. Used only by the legacy
// runtime; modern packages continue using their existing native PTY backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { auditPe } = require('../../../scripts/lib/windows7-pe.cjs');
const directory = path.resolve(__dirname, '../vendor/winpty-0.4.3');
const hashes = Object.freeze({
  'x64/winpty.dll': '936f611c2129600d35ab7aad45546a837f4f3a9ca7f673e5d66b48c313b9cd75',
  'x64/winpty-agent.exe': '9add1a61155ec47cf6f347faf776b746eebbde1dc9360d81b8a909da34650642',
  LICENSE: 'c39e428064b4f3e4fe81a975bf0fd3b845922b431bc4d9a7ffc8bfb091981836',
});
const archiveHash = '35a48ece2ff4acdcbc8299d4920de53eb86b1fb41e64d2fe5ae7898931bcee89';
function readAssets(source = directory) {
  const provenance = fs.readFileSync(path.join(source, 'provenance.json'));
  const info = JSON.parse(provenance);
  assert.equal(info.product, 'winpty'); assert.equal(info.version, '0.4.3');
  assert.equal(info.source, 'https://github.com/rprichard/winpty/releases/download/0.4.3/winpty-0.4.3-msvc2015.zip');
  assert.equal(info.sourceSha256, archiveHash); assert.equal(info.license, 'MIT');
  assert.deepEqual(Object.keys(info.files).sort(), Object.keys(hashes).sort());
  const files = new Map();
  for (const [file, expected] of Object.entries(hashes)) {
    const bytes = fs.readFileSync(path.join(source, file));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, expected, `Bundled WinPTY digest mismatch: ${file}`);
    assert.equal(info.files[file].sha256, expected); assert.equal(info.files[file].size, bytes.length);
    if (/\.(dll|exe)$/.test(file)) {
      const pe = auditPe(bytes);
      assert.ok(pe.imports.every(row => /^(KERNEL32|ADVAPI32|USER32|SHELL32)\.dll$/i.test(row.dll)),
        'WinPTY may only import its pinned Win7 system DLL dependencies');
    }
    files.set(file === 'LICENSE' ? 'licenses/winpty/LICENSE' : 'bin/' + path.basename(file), bytes);
  }
  files.set('licenses/winpty/provenance.json', provenance);
  return files;
}
function stageAssets(target, source = directory) {
  const files = readAssets(source);
  for (const [file, bytes] of files) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.writeFileSync(path.join(target, file), bytes);
  }
  return [...files.keys()];
}
module.exports = { readAssets, stageAssets, directory, hashes, archiveHash };
