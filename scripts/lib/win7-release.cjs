'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readRuntimeArchive } = require('./runtime-archive.cjs');
const { auditPe } = require('./windows7-pe.cjs');

const MCP_BASE = 'https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs';
const CLIENT_BASE = 'https://cdn.keepwork.com/keepwork/aichat-rust-win7-win8';
const TARGET = 'x86_64-win7-windows-msvc';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);

function publicKey(key) {
  const result = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
  assert.equal(result.asymmetricKeyType, 'rsa', 'Win7 releases require an RSA key');
  assert.equal(result.asymmetricKeyDetails.modulusLength, 2048, 'Win7 releases require RSA-2048');
  return result;
}
function publicKeyBlob(key) {
  const jwk = publicKey(key).export({ format: 'jwk' });
  const exponent = Buffer.from(jwk.e, 'base64url'), modulus = Buffer.from(jwk.n, 'base64url');
  const header = Buffer.alloc(24);
  [0x31415352, modulus.length * 8, exponent.length, modulus.length, 0, 0].forEach((value, i) => header.writeUInt32LE(value, i * 4));
  return Buffer.concat([header, exponent, modulus]);
}
function signEnvelope(value, key) {
  publicKey(key);
  const payload = JSON.stringify(value);
  assert.ok(Buffer.byteLength(payload) <= 1024 * 1024, 'Win7 manifest exceeds size limit');
  return { algorithm: 'rsa-sha256', payload, signature: crypto.sign('sha256', Buffer.from(payload),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('hex') };
}
function verifyEnvelope(envelope, key) {
  assert.equal(envelope.algorithm, 'rsa-sha256');
  assert.equal(typeof envelope.payload, 'string');
  assert.ok(Buffer.byteLength(envelope.payload) <= 1024 * 1024, 'Win7 manifest exceeds size limit');
  assert.match(envelope.signature, /^[a-f0-9]{512}$/);
  assert.ok(crypto.verify('sha256', Buffer.from(envelope.payload), { key: publicKey(key),
    padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(envelope.signature, 'hex')), 'Invalid Win7 release signature');
  return JSON.parse(envelope.payload);
}
function safePath(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length < 180
    && /^[\x20-\x7e]+$/.test(value) && !/[\\:<>"|?*]/.test(value), 'Invalid Win7 package path');
  for (const part of value.split('/')) {
    assert.ok(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), 'Unsafe Win7 package path');
    assert.ok(!/^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part), 'Reserved Windows package path');
  }
  return value;
}
function validateMcpManifest(value) {
  assert.equal(value.schemaVersion, 2); assert.equal(value.product, 'keepwork-mcp-runtime');
  assert.equal(value.engine, 'rust'); assert.equal(value.variant, 'win7-win8');
  assert.equal(value.platform, 'windows'); assert.equal(value.arch, 'x64'); assert.equal(value.buildTarget, TARGET);
  assert.deepEqual(value.minWindows, [6, 1, 7601]);
  assert.equal(value.entry, 'bin/keepwork-mcp.exe'); assert.equal(value.fileName, 'windows-x64.zip');
  assert.ok(stableVersion(value.version), 'Invalid Win7 MCP version');
  assert.equal(value.url, `${MCP_BASE}/${value.version}/windows-x64.zip`, 'Wrong Win7 MCP update channel');
  assert.match(value.commit, /^[a-f0-9]{40}$/); assert.match(value.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
  assert.ok(value.terminalApi == null, 'Win7 MCP cannot advertise PTY');
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 128 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(value.unpackedSize) && value.unpackedSize > 0 && value.unpackedSize <= 64 * 1024 * 1024);
  assert.ok(Array.isArray(value.files) && value.files.length >= 3 && value.files.length <= 256);
  const names = new Set(); let total = 0;
  for (const file of value.files) {
    const name = safePath(file.path).toLowerCase();
    assert.ok(!names.has(name), 'Duplicate Win7 package path'); names.add(name);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 32 * 1024 * 1024);
    assert.match(file.sha256, /^[a-f0-9]{64}$/); total += file.size;
  }
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { assert.ok(!names.has(parts.join('/')), 'Win7 package file/directory collision'); parts.pop(); }
  }
  for (const name of ['runtime.json', 'bin/keepwork-mcp.exe', 'license']) assert.ok(names.has(name), 'Missing Win7 runtime file: ' + name);
  assert.equal(total, value.unpackedSize, 'Win7 unpacked size mismatch');
  return value;
}
function validateMcpArchive(bytes, manifest) {
  validateMcpManifest(manifest);
  assert.equal(bytes.length, manifest.size, 'Win7 archive size mismatch');
  assert.equal(digest(bytes), manifest.sha256, 'Win7 archive SHA-256 mismatch');
  const members = readRuntimeArchive(bytes), expected = new Map(manifest.files.map(file => [file.path, file]));
  const allNames = [...expected.keys()];
  for (const [name, content] of members) {
    if (name.endsWith('/')) {
      safePath(name.slice(0, -1));
      assert.ok(allNames.some(file => file.startsWith(name)), 'Unexpected Win7 archive directory');
      continue;
    }
    safePath(name);
    const file = expected.get(name);
    assert.ok(file && file.size === content.length && file.sha256 === digest(content), 'Win7 archive differs from manifest: ' + name);
    expected.delete(name);
    if (/\.(exe|dll)$/i.test(name)) auditPe(content);
  }
  assert.equal(expected.size, 0, 'Missing Win7 archive member');
  const runtime = JSON.parse(members.get('runtime.json').toString('utf8'));
  for (const key of ['schemaVersion', 'product', 'engine', 'variant', 'version', 'platform', 'arch',
    'buildTarget', 'minWindows', 'entry', 'commit', 'sourceHash']) assert.deepEqual(runtime[key], manifest[key], 'Win7 archive runtime identity mismatch: ' + key);
  assert.ok(runtime.terminalApi == null && runtime.capabilities?.terminalApi == null, 'Win7 runtime cannot advertise PTY');
  return members;
}
function validateClientManifest(value) {
  assert.equal(value.schemaVersion, 1); assert.equal(value.product, 'aichat-desktop');
  assert.equal(value.variant, 'win7-win8'); assert.equal(value.platform, 'windows'); assert.equal(value.arch, 'x64');
  assert.equal(value.format, 'exe'); assert.deepEqual(value.minWindows, [6, 1, 7601]);
  assert.ok(stableVersion(value.version), 'Invalid Win7 client version');
  assert.match(value.commit, /^[a-f0-9]{40}$/); assert.match(value.sha256, /^[a-f0-9]{64}$/);
  assert.equal(value.fileName, `Keepwork_Win7_Win8_${value.version}_x64-setup.exe`);
  assert.equal(value.url, `${CLIENT_BASE}/${value.version}/${value.fileName}`, 'Wrong Win7 client update channel');
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 1024 ** 3);
  return value;
}
module.exports = { MCP_BASE, CLIENT_BASE, TARGET, digest, stableVersion, publicKey, publicKeyBlob,
  signEnvelope, verifyEnvelope, safePath, validateMcpManifest, validateMcpArchive, validateClientManifest };
