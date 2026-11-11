const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { packageCef, signManifest, verifyEnvelope, validateManifest, keyHeader, safePath, peMachine } = require('../scripts/cef-release.cjs');
const { publication } = require('../scripts/publish-cef.cjs');

const testPrivateKey = process.env.KEEPWORK_CEF_TEST_PRIVATE_KEY;
const key = testPrivateKey ? (() => {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(testPrivateKey));
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
})() : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const machines = { x86: 0x14c, x64: 0x8664, arm64: 0xaa64 };
function pe(arch) {
  const buffer = Buffer.alloc(128);
  buffer.write('MZ'); buffer.writeUInt32LE(64, 0x3c); buffer.write('PE\0\0', 64, 'ascii'); buffer.writeUInt16LE(machines[arch], 68);
  return buffer;
}
function fixture(t, major = 109, arch = 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-cef-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'runtime'), output = path.join(root, 'output');
  fs.mkdirSync(path.join(directory, 'locales'), { recursive: true });
  for (const name of ['keepwork-cef.exe', 'libcef.dll', ...(major >= 138 ? ['keepwork-cef.dll'] : [])]) fs.writeFileSync(path.join(directory, name), pe(arch));
  for (const name of ['icudtl.dat', 'resources.pak', 'locales/en-US.pak', 'CEF-LICENSE.txt']) fs.writeFileSync(path.join(directory, name), 'fixture: ' + name);
  const host = { schemaVersion: 1, product: 'keepwork-cef-host', hostProtocol: 1, desktopBridge: false,
    cefMajor: major, cefVersion: `${major}.1.2+gabcdef0+chromium-${major}.0.0.0`, hostVersion: '0.2.41', arch,
    sandbox: major === 109 ? 'cef_sandbox' : 'bootstrap' };
  const hostFile = path.join(directory, 'cef-host.json');
  fs.writeFileSync(hostFile, JSON.stringify(host));
  return { root, directory, output, host, hostFile, options: { directory, output, privateKey: key.privateKey } };
}
function minimalManifest() {
  const files = ['keepwork-cef.exe', 'libcef.dll', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak'].map(name => ({ path: name, size: 1, sha256: 'b'.repeat(64) }));
  return { schemaVersion: 1, product: 'keepwork-aichat-cef', hostProtocol: 1, channel: 'legacy', arch: 'x64', entry: 'keepwork-cef.exe',
    version: '0.2.41', cefVersion: '109.1.2', chromiumMajor: 109, minWindows: [6, 1, 7601], size: 100, unpackedSize: 5, sha256: 'a'.repeat(64), files };
}

test('release signatures authenticate exact payload bytes and reject tampering and other keys', () => {
  const manifest = minimalManifest(), envelope = signManifest(manifest, key.privateKey);
  assert.deepEqual(verifyEnvelope(envelope, key.publicKey), manifest);
  assert.equal(crypto.verify('sha256', Buffer.from(envelope.payload), { key: key.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(envelope.signature, 'hex')), true);
  for (const field of ['version', 'channel', 'arch', 'entry', 'sha256', 'product']) {
    const changed = { ...manifest, [field]: 'tampered' };
    assert.throws(() => verifyEnvelope({ ...envelope, payload: JSON.stringify(changed) }, key.publicKey), /signature/);
  }
  assert.throws(() => verifyEnvelope({ ...envelope, payload: envelope.payload + '\n' }, key.publicKey), /signature/);
  assert.throws(() => verifyEnvelope(envelope, otherKey.publicKey), /signature/);
  assert.throws(() => verifyEnvelope({ ...envelope, signature: '0'.repeat(512) }, key.publicKey), /signature/);
  assert.throws(() => verifyEnvelope({ ...envelope, signature: envelope.signature.toUpperCase() }, key.publicKey));
  assert.throws(() => verifyEnvelope({ ...envelope, algorithm: 'none' }, key.publicKey));
  assert.throws(() => verifyEnvelope({ ...envelope, signature: '00' }, key.publicKey));
  assert.throws(() => verifyEnvelope({ ...envelope, payload: ' '.repeat(1024 ** 2 + 1) }, key.publicKey));
});

test('pinned BCrypt public blob preserves RSA modulus/exponent and excludes private key material', () => {
  const header = keyHeader(key.publicKey);
  const bytes = Buffer.from([...header.matchAll(/0x([0-9a-f]{2})/g)].map(match => parseInt(match[1], 16)));
  const jwk = key.publicKey.export({ format: 'jwk' });
  const exponent = Buffer.from(jwk.e, 'base64url'), modulus = Buffer.from(jwk.n, 'base64url');
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => bytes.readUInt32LE(index * 4)), [0x31415352, 2048, exponent.length, modulus.length, 0, 0]);
  assert.deepEqual(bytes.subarray(24, 24 + exponent.length), exponent);
  assert.deepEqual(bytes.subarray(24 + exponent.length), modulus);
  const reconstructed = crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: bytes.subarray(24 + exponent.length).toString('base64url'), e: bytes.subarray(24, 24 + exponent.length).toString('base64url') } });
  assert.deepEqual(verifyEnvelope(signManifest(minimalManifest(), key.privateKey), reconstructed), minimalManifest());
  assert.doesNotMatch(header, /PRIVATE KEY|privateExponent|\bd\s*:/);
  assert.equal(keyHeader(key.privateKey), header);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => keyHeader(weak.publicKey), /RSA-2048/);
  assert.throws(() => signManifest(minimalManifest(), weak.privateKey), /RSA-2048/);
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => keyHeader(ec.publicKey));
});

test('Windows artifact paths reject traversal, ADS, devices, and case-colliding metadata', () => {
  for (const name of ['libcef.dll', 'locales/en-US.pak', 'swiftshader/vk_swiftshader.dll']) assert.equal(safePath(name), name);
  for (const name of ['', '/absolute', '../outside', 'a/../outside', 'a//file', 'a\\file', 'C:/file', 'a:stream', 'file.', 'file ', 'NUL', 'con.dll', 'a/LPT9.txt', 'a/CONOUT$', 'a\nb', 'é.pak']) assert.throws(() => safePath(name), name);
  const manifest = minimalManifest();
  manifest.files.push({ ...manifest.files[0], path: 'KEEPWORK-CEF.EXE' }); manifest.unpackedSize++;
  assert.throws(() => validateManifest(manifest), /Duplicate/);
  manifest.files[5].path = 'locales';
  assert.throws(() => validateManifest(manifest), /collision/);
});

for (const [major, arch] of [[109, 'x86'], [109, 'x64'], [143, 'x64'], [143, 'arm64']]) {
  test(`packages actual signed ZIP: Chromium ${major}, ${arch}`, t => {
    const f = fixture(t, major, arch), result = packageCef(f.options);
    assert.deepEqual(verifyEnvelope(result.envelope, key.publicKey), result.manifest);
    assert.equal(result.manifest.channel, major === 109 ? 'legacy' : 'modern');
    assert.deepEqual(result.manifest.minWindows, major === 109 ? [6, 1, 7601] : [10, 0, 19045]);
    assert.equal(result.plan.uploads.length, 2);
    const archive = result.plan.uploads[0].filePath;
    assert.equal(digest(fs.readFileSync(archive)), result.manifest.sha256);
    assert.equal(fs.statSync(archive).size, result.manifest.size);
    assert.equal(result.plan.uploads[0].url, `https://cdn.keepwork.com/keepwork/aichat-cef/v1/objects/${result.manifest.sha256}.zip`);
    assert.match(result.plan.uploads[1].remoteKey, new RegExp(`${result.manifest.channel}/windows-${arch}/stable\\.json$`));
    const inspect = 'import sys,zipfile,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([{\"path\":i.filename,\"size\":i.file_size,\"sha256\":hashlib.sha256(z.read(i)).hexdigest(),\"mode\":i.external_attr>>16} for i in z.infolist()]))';
    const members = JSON.parse(execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', inspect, archive], { encoding: 'utf8' }));
    assert.deepEqual(members.map(({ mode, ...record }) => record).sort((a, b) => a.path.localeCompare(b.path)), [...result.manifest.files].sort((a, b) => a.path.localeCompare(b.path)));
    assert.ok(members.every(member => (member.mode & 0o170000) === 0o100000), 'Only regular files in distribution');
    assert.ok(members.some(member => member.path === 'CEF-LICENSE.txt'));
    const second = packageCef({ ...f.options, output: path.join(f.root, 'second') });
    assert.equal(second.manifest.sha256, result.manifest.sha256, 'Repackaging identical input is deterministic');
    assert.equal(second.envelope.signature, result.envelope.signature);
  });
}

test('packaging rejects architecture mismatches, missing assets, unknown host contracts, and unsigned sandbox claims', t => {
  const f = fixture(t, 143);
  const hostExe = path.join(f.directory, 'keepwork-cef.exe');
  fs.writeFileSync(hostExe, pe('x86'));
  assert.throws(() => packageCef(f.options), /architecture mismatch/);
  fs.writeFileSync(hostExe, pe('x64'));
  fs.rmSync(path.join(f.directory, 'keepwork-cef.dll'));
  assert.throws(() => packageCef(f.options), /sandbox bootstrap application DLL/);
  fs.writeFileSync(path.join(f.directory, 'keepwork-cef.dll'), pe('x64'));
  fs.rmSync(path.join(f.directory, 'CEF-LICENSE.txt'));
  assert.throws(() => packageCef(f.options), /license/);
  fs.writeFileSync(path.join(f.directory, 'CEF-LICENSE.txt'), 'fixture license');
  for (const [field, value] of [['desktopBridge', true], ['hostProtocol', 2], ['sandbox', 'disabled'], ['product', 'other-product']]) {
    fs.writeFileSync(f.hostFile, JSON.stringify({ ...f.host, [field]: value }));
    assert.throws(() => packageCef(f.options), `Host ${field}`);
  }
  fs.writeFileSync(f.hostFile, JSON.stringify(f.host));
  assert.throws(() => packageCef({ ...f.options, minWindows: [6, 1, 7601] }), /minimum OS/);
  assert.throws(() => packageCef({ ...f.options, output: path.join(f.directory, 'output') }), /inside runtime/);
  assert.equal(fs.existsSync(path.join(f.directory, 'output')), false, 'Reject contained output before writing');
  assert.throws(() => packageCef({ ...f.options, output: f.directory }), /inside runtime/);
  fs.writeFileSync(hostExe, Buffer.from('not an executable'));
  assert.throws(() => peMachine(hostExe), /Invalid PE/);
});

test('package output containment resolves directory aliases before creating files', t => {
  const f = fixture(t), alias = path.join(f.root, 'alias');
  try { fs.symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => packageCef({ ...f.options, output: path.join(alias, 'nested', 'output') }), /inside runtime/);
  assert.equal(fs.existsSync(path.join(f.directory, 'nested')), false);
});

test('sandbox release contracts reject mismatched bootstrap generations and absent claims', t => {
  for (const [major, arch, sandbox] of [[109, 'x64', 'bootstrap'], [109, 'x64', ''], [143, 'x64', 'cef_sandbox'], [143, 'x64', null]]) {
    const f = fixture(t, major, arch);
    fs.writeFileSync(f.hostFile, JSON.stringify({ ...f.host, sandbox }));
    assert.throws(() => packageCef(f.options));
    assert.equal(fs.existsSync(f.output), false);
  }
  const missing = fixture(t);
  delete missing.host.sandbox; fs.writeFileSync(missing.hostFile, JSON.stringify(missing.host));
  assert.throws(() => packageCef(missing.options));
  const unsupported = fixture(t, 137);
  assert.throws(() => packageCef(unsupported.options), /generation/);
  const legacyArm = fixture(t, 109, 'arm64');
  assert.throws(() => packageCef(legacyArm.options));
});

test('packaging rejects symlink payload members before creating a signed release', t => {
  const f = fixture(t), link = path.join(f.directory, 'linked-license');
  try { fs.symlinkSync(path.join(f.directory, 'CEF-LICENSE.txt'), link); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => packageCef(f.options), /symlinks/);
  assert.equal(fs.existsSync(f.output), false);
});

test('only signed supported manifests can be released', () => {
  for (const change of [
    { chromiumMajor: 4294967405 }, { minWindows: [6, 1, 7600] }, { minWindows: [6, -1, 7601] },
    { arch: 'arm64' }, { size: 0 }, { size: 1024 ** 3 + 1 }, { unpackedSize: 3 * 1024 ** 3 + 1 },
    { hostProtocol: 2 }, { entry: 'arbitrary.exe' }, { cefVersion: '143.1.2' },
  ]) assert.throws(() => signManifest({ ...minimalManifest(), ...change }, key.privateKey));
  const unsupported = minimalManifest(); unsupported.channel = 'modern'; unsupported.chromiumMajor = 137; unsupported.cefVersion = '137.1.2'; unsupported.minWindows = [10, 0, 0];
  assert.throws(() => validateManifest(unsupported), /generation/);
});

test('publication dry-run derives exact CDN targets from verified signed metadata without credentials', t => {
  const f = fixture(t), result = packageCef(f.options);
  const publicFile = path.join(f.root, 'public.pem');
  fs.writeFileSync(publicFile, key.publicKey.export({ type: 'spki', format: 'pem' }));
  const env = { ...process.env };
  delete env.KP_QINIU_ACCESS_KEY; delete env.KP_QINIU_SECRET_KEY;
  const script = path.resolve(__dirname, '../scripts/publish-cef.cjs');
  const dryRun = JSON.parse(execFileSync(process.execPath, [script, f.output, 'legacy', 'x64', publicFile], { encoding: 'utf8', env }));
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.entries.map(entry => entry.remoteKey), [
    `keepwork/aichat-cef/v1/objects/${result.manifest.sha256}.zip`,
    'keepwork/aichat-cef/v1/legacy/windows-x64/stable.json',
  ]);
  assert.deepEqual(dryRun.entries, publication(f.output, 'legacy', 'x64', key.publicKey));
  for (const entry of dryRun.entries) {
    assert.equal(entry.size, fs.statSync(entry.filePath).size);
    assert.equal(entry.sha256, digest(fs.readFileSync(entry.filePath)));
    assert.equal(entry.url, 'https://cdn.keepwork.com/' + entry.remoteKey);
  }
  // An edited upload-plan file cannot redirect publication outside the signed channel.
  fs.writeFileSync(path.join(f.output, 'release-plan-legacy-x64.json'), JSON.stringify({ uploads: [{ remoteKey: 'other/product/stable.json' }] }));
  assert.deepEqual(publication(f.output, 'legacy', 'x64', key.publicKey), dryRun.entries);
});

test('publication refuses wrong signing keys, modified manifests, and modified content-addressed objects', t => {
  const f = fixture(t), result = packageCef(f.options);
  const signedFile = result.plan.uploads[1].filePath, objectFile = result.plan.uploads[0].filePath;
  const signedBytes = fs.readFileSync(signedFile), objectBytes = fs.readFileSync(objectFile);
  assert.throws(() => publication(f.output, 'legacy', 'x64', otherKey.publicKey), /signature/);
  fs.writeFileSync(signedFile, JSON.stringify({ ...result.envelope, payload: result.envelope.payload.replace('"x64"', '"x86"') }));
  assert.throws(() => publication(f.output, 'legacy', 'x64', key.publicKey), /signature/);
  fs.writeFileSync(signedFile, signedBytes);
  const sameSizeTampering = Buffer.from(objectBytes); sameSizeTampering[sameSizeTampering.length - 1] ^= 1;
  fs.writeFileSync(objectFile, sameSizeTampering);
  assert.throws(() => publication(f.output, 'legacy', 'x64', key.publicKey));
  fs.writeFileSync(objectFile, objectBytes.subarray(0, -1));
  assert.throws(() => publication(f.output, 'legacy', 'x64', key.publicKey));
  fs.writeFileSync(objectFile, objectBytes);
  assert.throws(() => publication(f.output, '../other', 'x64', key.publicKey));
  assert.throws(() => publication(f.output, 'legacy', 'arm', key.publicKey));
  const otherTarget = path.join(f.output, 'legacy', 'windows-x86', 'stable.json');
  fs.mkdirSync(path.dirname(otherTarget), { recursive: true }); fs.writeFileSync(otherTarget, signedBytes);
  assert.throws(() => publication(f.output, 'legacy', 'x86', key.publicKey), 'Signed artifact target must match requested publication channel');
});

test('Windows native verifier accepts publisher output and rejects signature/archive tampering', {
  skip: process.platform !== 'win32' || !process.env.KEEPWORK_CEF_VERIFY_EXE,
}, t => {
  assert.ok(testPrivateKey, 'KEEPWORK_CEF_TEST_PRIVATE_KEY must match the public key compiled into the verifier');
  const f = fixture(t), result = packageCef(f.options);
  const executable = process.env.KEEPWORK_CEF_VERIFY_EXE;
  const signed = result.plan.uploads[1].filePath, archive = result.plan.uploads[0].filePath;
  assert.equal(execFileSync(executable, ['envelope', signed], { encoding: 'utf8' }), result.envelope.payload);
  const out = path.join(f.root, 'native-extracted');
  assert.match(execFileSync(executable, ['package', signed, archive, out, 'legacy', 'x64', '6.1.7601'], { encoding: 'utf8' }), /verification passed/);
  for (const file of result.manifest.files) assert.equal(digest(fs.readFileSync(path.join(out, file.path))), file.sha256);
  const rejectsNative = args => {
    const failure = spawnSync(executable, args, { encoding: 'utf8' });
    assert.ifError(failure.error); assert.equal(failure.status, 2, failure.stdout + failure.stderr);
  };
  const tampered = path.join(f.root, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...result.envelope, payload: result.envelope.payload + '\n' }));
  rejectsNative(['envelope', tampered]);
  fs.writeFileSync(tampered, JSON.stringify(signManifest(result.manifest, otherKey.privateKey)));
  rejectsNative(['envelope', tampered]);
  const badArchive = path.join(f.root, 'tampered.zip'), bytes = fs.readFileSync(archive);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(badArchive, bytes);
  rejectsNative(['package', signed, badArchive, path.join(f.root, 'bad-output'), 'legacy', 'x64', '6.1.7601']);
  assert.equal(fs.existsSync(path.join(f.root, 'bad-output')), false, 'Digest failure precedes extraction');
  rejectsNative(['package', signed, archive, path.join(f.root, 'wrong-arch'), 'legacy', 'x86', '6.1.7601']);
});
