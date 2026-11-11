#!/usr/bin/env node
// Build a separately distributed, signed CEF host artifact. Never added to the installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const prefix = 'keepwork/aichat-cef/v1/';
const base = 'https://cdn.keepwork.com/' + prefix;
const maxArchive = 1024 ** 3;
const maxUnpacked = 3 * maxArchive;
const machines = { x86: 0x14c, x64: 0x8664, arm64: 0xaa64 };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function safePath(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0 && value.length < 180 && /^[\x20-\x7e]+$/.test(value) && !/[\\:<>"|?*]/.test(value), 'Invalid Windows archive path');
  for (const part of value.split('/')) {
    assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Unsafe archive component');
    assert.ok(!/^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part), 'Reserved Windows device');
  }
  return value;
}
function peMachine(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Invalid PE file: ' + file);
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset <= bytes.length - 6 && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', 'Invalid PE header');
  return bytes.readUInt16LE(offset + 4);
}
function walk(directory, relative = '') {
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Runtime root cannot be a symlink');
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = safePath(relative + entry.name), file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Runtime cannot contain symlinks');
    if (entry.isDirectory()) return walk(file, name + '/');
    assert.ok(entry.isFile(), 'Unsupported runtime file type');
    return [{ path: name, size: fs.statSync(file).size, sha256: sha256(file) }];
  });
}
function validateManifest(m) {
  assert.equal(m.schemaVersion, 1); assert.equal(m.product, 'keepwork-aichat-cef'); assert.equal(m.hostProtocol, 1);
  assert.ok(['legacy', 'modern'].includes(m.channel)); assert.ok(machines[m.arch]);
  assert.ok(m.channel !== 'legacy' || m.arch !== 'arm64');
  assert.equal(m.entry, 'keepwork-cef.exe'); assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isSafeInteger(m.chromiumMajor) && m.chromiumMajor <= 10000);
  assert.ok(m.channel === 'legacy' ? m.chromiumMajor === 109 : m.chromiumMajor >= 138, 'Unsupported sandboxed CEF generation');
  assert.match(m.cefVersion, /^\d+\.\d+\.\d+[A-Za-z0-9.+_-]*$/);
  assert.ok(m.cefVersion.length < 120 && m.cefVersion.startsWith(m.chromiumMajor + '.'));
  assert.ok(Array.isArray(m.minWindows) && m.minWindows.length === 3 && m.minWindows.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000));
  const minimum = m.channel === 'legacy' ? [6, 1, 7601] : [10, 0, 0];
  const comparison = m.minWindows.reduce((result, n, i) => result || Math.sign(n - minimum[i]), 0);
  assert.ok(comparison >= 0, 'Invalid minimum OS');
  assert.ok(Number.isSafeInteger(m.size) && m.size > 0 && m.size <= maxArchive);
  assert.ok(Number.isSafeInteger(m.unpackedSize) && m.unpackedSize > 0 && m.unpackedSize <= maxUnpacked);
  assert.match(m.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(m.files) && m.files.length >= 5 && m.files.length <= 10000);
  const names = new Set(); let total = 0;
  for (const file of m.files) {
    const name = safePath(file.path).toLowerCase();
    assert.ok(!names.has(name), 'Duplicate runtime path'); names.add(name);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= maxArchive);
    assert.match(file.sha256, /^[a-f0-9]{64}$/); total += file.size;
  }
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { assert.ok(!names.has(parts.join('/')), 'File/directory collision'); parts.pop(); }
  }
  for (const name of ['keepwork-cef.exe', 'libcef.dll', 'icudtl.dat', 'resources.pak', 'locales/en-us.pak']) assert.ok(names.has(name), 'Missing ' + name);
  if (m.chromiumMajor >= 138) assert.ok(names.has('keepwork-cef.dll'), 'Missing sandbox bootstrap application DLL');
  assert.equal(total, m.unpackedSize);
  return m;
}
function publicKey(key) {
  const result = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
  assert.equal(result.asymmetricKeyType, 'rsa'); assert.equal(result.asymmetricKeyDetails.modulusLength, 2048, 'Use an RSA-2048 release key');
  return result;
}
function signManifest(manifest, key) {
  validateManifest(manifest); publicKey(key);
  const payload = JSON.stringify(manifest);
  const signature = crypto.sign('sha256', Buffer.from(payload), { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('hex');
  return { algorithm: 'rsa-sha256', payload, signature };
}
function verifyEnvelope(envelope, key) {
  assert.equal(envelope.algorithm, 'rsa-sha256'); assert.equal(typeof envelope.payload, 'string');
  assert.ok(Buffer.byteLength(envelope.payload) <= 1024 ** 2); assert.match(envelope.signature, /^[a-f0-9]{512}$/);
  assert.ok(crypto.verify('sha256', Buffer.from(envelope.payload), { key: publicKey(key), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(envelope.signature, 'hex')), 'Invalid release signature');
  return validateManifest(JSON.parse(envelope.payload));
}
function keyHeader(key) {
  const jwk = publicKey(key).export({ format: 'jwk' });
  const exponent = Buffer.from(jwk.e, 'base64url'), modulus = Buffer.from(jwk.n, 'base64url');
  const header = Buffer.alloc(24); [0x31415352, modulus.length * 8, exponent.length, modulus.length, 0, 0].forEach((n, i) => header.writeUInt32LE(n, i * 4));
  const bytes = Buffer.concat([header, exponent, modulus]);
  return '#pragma once\n// Pinned public verification key; never include a private key in the launcher.\ninline constexpr unsigned char release_public_key[] = {' + [...bytes].map(b => '0x' + b.toString(16).padStart(2, '0')).join(',') + '};\n';
}
function canonicalOutput(value) {
  let ancestor = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
  // Resolve existing symlink/junction ancestors even when the final output
  // directory does not exist. Both sides of the containment check must use
  // the same filesystem identity (for example /var and /private/var on macOS).
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function packageCef({ directory, output, privateKey, minWindows }) {
  directory = fs.realpathSync(directory); output = canonicalOutput(output);
  const relativeOutput = path.relative(directory, output);
  assert.ok(relativeOutput && (relativeOutput === '..' || relativeOutput.startsWith('..' + path.sep) || path.isAbsolute(relativeOutput)), 'Output cannot be inside runtime payload');
  const host = JSON.parse(fs.readFileSync(path.join(directory, 'cef-host.json'), 'utf8'));
  assert.equal(host.schemaVersion, 1); assert.equal(host.product, 'keepwork-cef-host'); assert.equal(host.hostProtocol, 1); assert.equal(host.desktopBridge, false);
  const channel = host.cefMajor === 109 ? 'legacy' : 'modern';
  assert.equal(host.sandbox, channel === 'legacy' ? 'cef_sandbox' : 'bootstrap');
  const files = walk(directory);
  for (const file of files) if (/\.(exe|dll)$/i.test(file.path)) assert.equal(peMachine(path.join(directory, file.path)), machines[host.arch], 'Runtime binary architecture mismatch');
  assert.ok(files.some(file => file.path === 'CEF-LICENSE.txt'), 'CEF license is required');
  const manifest = { schemaVersion: 1, product: 'keepwork-aichat-cef', hostProtocol: 1, channel, arch: host.arch, version: host.hostVersion,
    cefVersion: host.cefVersion, chromiumMajor: host.cefMajor, minWindows: minWindows || (channel === 'legacy' ? [6, 1, 7601] : [10, 0, 19045]),
    entry: 'keepwork-cef.exe', files, unpackedSize: files.reduce((n, f) => n + f.size, 0), size: 1, sha256: '0'.repeat(64) };
  validateManifest(manifest); publicKey(privateKey);
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, 'candidate.zip');
  // Build-time Python only; installed users do not need Python, PowerShell or Node.
  execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [path.join(__dirname, 'cef-zip.py'), directory, archive], { stdio: 'pipe' });
  // Catch concurrent changes during packaging before signing the archive.
  assert.deepEqual(walk(directory), files, 'Runtime payload changed during packaging');
  manifest.size = fs.statSync(archive).size; manifest.sha256 = sha256(archive);
  const envelope = signManifest(manifest, privateKey);
  const objectKey = 'objects/' + manifest.sha256 + '.zip', manifestKey = `${channel}/windows-${host.arch}/stable.json`;
  fs.mkdirSync(path.join(output, 'objects'), { recursive: true });
  fs.renameSync(archive, path.join(output, objectKey));
  fs.mkdirSync(path.dirname(path.join(output, manifestKey)), { recursive: true });
  fs.writeFileSync(path.join(output, manifestKey), JSON.stringify(envelope) + '\n');
  const plan = { channel, arch: host.arch, manifest: manifestKey, uploads: [objectKey, manifestKey].map(name => ({ name, filePath: path.join(output, name), remoteKey: prefix + name, url: base + name, sha256: sha256(path.join(output, name)), size: fs.statSync(path.join(output, name)).size })) };
  fs.writeFileSync(path.join(output, `release-plan-${channel}-${host.arch}.json`), JSON.stringify(plan, null, 2) + '\n');
  return { manifest, envelope, plan };
}
if (require.main === module) {
  try {
    const [command, first, second, third, minimum] = process.argv.slice(2);
    if (command === 'key-header' && first && second) {
      fs.mkdirSync(path.dirname(path.resolve(second)), { recursive: true }); fs.writeFileSync(second, keyHeader(fs.readFileSync(first)));
    } else if (command === 'package' && first && second && third) {
      const result = packageCef({ directory: first, output: second, privateKey: fs.readFileSync(third), minWindows: minimum ? minimum.split('.').map(Number) : undefined });
      console.log(JSON.stringify({ version: result.manifest.version, channel: result.manifest.channel, arch: result.manifest.arch, size: result.manifest.size, sha256: result.manifest.sha256 }));
    } else throw Error('Usage: cef-release.cjs key-header PUBLIC.pem HEADER | package PAYLOAD OUTPUT PRIVATE.pem [MIN_WINDOWS]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageCef, signManifest, verifyEnvelope, validateManifest, keyHeader, safePath, peMachine };
