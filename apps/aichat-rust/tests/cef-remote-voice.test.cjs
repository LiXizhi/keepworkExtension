const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { remoteVoice, auditLegacyCef } = require('../scripts/cef-remote-voice.cjs');
const { packageCef, verifyEnvelope } = require('../scripts/cef-release.cjs');

// Complete section-backed PE fixture, not a runnable Windows executable.
function pe(major = 6, minor = 1, machine = 0x8664) {
  const value = Buffer.alloc(0x400), optional = 0x98, section = optional + 0xf0;
  value.write('MZ'); value.writeUInt32LE(0x80, 0x3c); value.write('PE\0\0', 0x80);
  value.writeUInt16LE(machine, 0x84); value.writeUInt16LE(1, 0x86); value.writeUInt16LE(0xf0, 0x94);
  value.writeUInt16LE(0x20b, optional); value.writeBigUInt64LE(0x140000000n, optional + 24);
  value.writeUInt16LE(major, optional + 40); value.writeUInt16LE(minor, optional + 42);
  value.writeUInt16LE(major, optional + 48); value.writeUInt16LE(minor, optional + 50);
  value.writeUInt32LE(0x200, optional + 60); value.writeUInt32LE(16, optional + 108);
  value.writeUInt32LE(0x200, section + 8); value.writeUInt32LE(0x1000, section + 12);
  value.writeUInt32LE(0x200, section + 16); value.writeUInt32LE(0x200, section + 20);
  return value;
}
function fixture(t, component = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-cef-voice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'payload'); fs.mkdirSync(path.join(directory, 'locales'), { recursive: true });
  const host = { schemaVersion: 1, product: 'keepwork-cef-host', hostProtocol: 1, desktopBridge: false,
    cefMajor: 109, cefVersion: '109.1.18+fixture', hostVersion: '0.2.153', arch: 'x64', sandbox: 'cef_sandbox',
    ...(component ? { remoteVoice } : {}) };
  const writeHost = () => fs.writeFileSync(path.join(directory, 'cef-host.json'), JSON.stringify(host)); writeHost();
  for (const name of ['keepwork-cef.exe', 'libcef.dll']) fs.writeFileSync(path.join(directory, name), pe());
  for (const name of ['icudtl.dat', 'resources.pak', 'locales/en-US.pak', 'CEF-LICENSE.txt']) fs.writeFileSync(path.join(directory, name), 'fixture');
  if (component) fs.writeFileSync(path.join(directory, remoteVoice.entry), pe(10, 0));
  return { root, directory, host, writeHost };
}
test('CEF Win7 audit separates the fixed optional Windows10 component without claiming loader compatibility', t => {
  const f = fixture(t), report = auditLegacyCef(f.directory);
  assert.equal(report.baseline, 'windows7-sp1-x64');
  assert.deepEqual(report.files.map(file => file.path).sort(), ['keepwork-cef.exe', 'libcef.dll']);
  assert.equal(report.optionalComponents.length, 1);
  const component = report.optionalComponents[0];
  assert.equal(component.path, remoteVoice.entry); assert.deepEqual(component.minWindows, [10, 0, 15063]);
  assert.equal(component.nativeWindows10Verified, false); assert.equal(report.nativeWin7Verified, false);
  assert.equal(component.sha256, crypto.createHash('sha256').update(pe(10, 0)).digest('hex'));
  const old = fixture(t, false); assert.deepEqual(auditLegacyCef(old.directory).optionalComponents, []);
});
test('optional component audit never exempts the main host, other paths, missing helpers or wrong architectures', t => {
  for (const name of ['keepwork-cef.exe', 'libcef.dll', 'unexpected.exe', 'nested/keepwork-remote-voice.exe']) {
    const f = fixture(t); fs.mkdirSync(path.dirname(path.join(f.directory, name)), { recursive: true });
    fs.writeFileSync(path.join(f.directory, name), pe(10, 0));
    assert.throws(() => auditLegacyCef(f.directory), /minimum OS\/subsystem/);
  }
  const missing = fixture(t); fs.rmSync(path.join(missing.directory, remoteVoice.entry));
  assert.throws(() => auditLegacyCef(missing.directory), /Missing native/);
  const wrong = fixture(t); fs.writeFileSync(path.join(wrong.directory, remoteVoice.entry), pe(10, 0, 0xaa64));
  assert.throws(() => auditLegacyCef(wrong.directory), /architecture/);
  const undeclared = fixture(t, false); fs.writeFileSync(path.join(undeclared.directory, remoteVoice.entry), pe(10, 0));
  assert.throws(() => auditLegacyCef(undeclared.directory), /minimum OS\/subsystem/);
  for (const change of [{ entry: 'keepwork-cef.exe' }, { version: 2 }, { minWindows: [6, 1, 7601] }]) {
    const f = fixture(t); f.host.remoteVoice = { ...remoteVoice, ...change }; f.writeHost();
    assert.throws(() => auditLegacyCef(f.directory), /Unsupported native/);
  }
});
test('signed CEF archive binds the native companion contract and exact helper bytes', t => {
  const f = fixture(t), key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const result = packageCef({ directory: f.directory, output: path.join(f.root, 'release'), privateKey: key.privateKey });
  const signed = verifyEnvelope(result.envelope, key.publicKey);
  assert.deepEqual(signed.remoteVoice, remoteVoice);
  const component = signed.files.find(file => file.path === remoteVoice.entry);
  assert.equal(component.sha256, crypto.createHash('sha256').update(pe(10, 0)).digest('hex'));
  assert.deepEqual(signed.minWindows, [6, 1, 7601], 'base application retains the Win7 baseline');
  const changed = { ...result.envelope, payload: result.envelope.payload.replace('"version":1,"entry":"keepwork-remote-voice.exe"', '"version":2,"entry":"keepwork-remote-voice.exe"') };
  assert.throws(() => verifyEnvelope(changed, key.publicKey), /signature/);
  fs.rmSync(path.join(f.directory, remoteVoice.entry));
  assert.throws(() => packageCef({ directory: f.directory, output: path.join(f.root, 'missing'), privateKey: key.privateKey }), /Missing native/);
});
