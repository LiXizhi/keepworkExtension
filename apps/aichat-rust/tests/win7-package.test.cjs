const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { preparePayload, packageWin7 } = require('../scripts/package-win7.cjs');
const release = require('../../../scripts/lib/win7-release.cjs');
const { packageWin7Runtime } = require('../../mcp-rust/scripts/package-win7-runtime.cjs');
const cefRelease = require('../scripts/cef-release.cjs');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const nsisCompiler = process.env.KEEPWORK_WIN7_MAKENSIS || process.env.MAKENSIS;

function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(0x400), optional = 0x98, section = 0x188;
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(machine, 0x84); bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94); bytes.writeUInt16LE(0x22, 0x96);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x1000, optional + 32); bytes.writeUInt32LE(0x200, optional + 36);
  for (const offset of [40, 48]) { bytes.writeUInt16LE(6, optional + offset); bytes.writeUInt16LE(1, optional + offset + 2); }
  bytes.writeUInt32LE(0x2000, optional + 56); bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt16LE(3, optional + 68); bytes.writeUInt32LE(16, optional + 108);
  bytes.write('.rdata', section, 'ascii');
  for (const [offset, value] of [[8, 0x200], [12, 0x1000], [16, 0x200], [20, 0x200], [36, 0x40000040]]) bytes.writeUInt32LE(value, section + offset);
  return bytes;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = { marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust',
    variant: 'win7-win8', minWindows: [6, 1, 7601], target: release.TARGET, version: '0.2.61',
    commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64),
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' },
    endMarker: 'keepwork-mcp-build-end' };
  const binary = path.join(root, 'keepwork-mcp.exe');
  fs.writeFileSync(binary, Buffer.concat([pe(), Buffer.from(JSON.stringify(info))]));
  const mcpDirectory = path.join(root, 'mcp-release');
  packageWin7Runtime({ binary, output: mcpDirectory, expected: info });
  const bootstrap = path.join(root, 'Keepwork.exe');
  fs.writeFileSync(bootstrap, Buffer.concat([pe(), release.publicKeyBlob(key.publicKey)]));
  return { root, info, options: { bootstrap, mcpDirectory, output: path.join(root, 'desktop-release'),
    privateKey: key.privateKey, version: '0.2.126', commit: info.commit } };
}

function walk(directory, relative = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(directory, entry.name), relative + entry.name + '/') : [relative + entry.name]);
}

function cefFixture(f, { major = 109, arch = 'x64', privateKey = key.privateKey, minWindows } = {}) {
  const directory = path.join(f.root, 'cef-host'), output = path.join(f.root, 'cef-release');
  fs.mkdirSync(path.join(directory, 'locales'), { recursive: true });
  for (const name of ['keepwork-cef.exe', 'libcef.dll', ...(major >= 138 ? ['keepwork-cef.dll'] : [])]) {
    fs.writeFileSync(path.join(directory, name), pe(arch === 'x64' ? 0x8664 : 0x14c));
  }
  for (const name of ['icudtl.dat', 'resources.pak', 'locales/en-US.pak', 'CEF-LICENSE.txt']) {
    fs.writeFileSync(path.join(directory, name), 'CEF package fixture resource: ' + name);
  }
  fs.writeFileSync(path.join(directory, 'cef-host.json'), JSON.stringify({
    schemaVersion: 1, product: 'keepwork-cef-host', hostProtocol: 1, desktopBridge: false,
    cefMajor: major, cefVersion: `${major}.1.2`, hostVersion: '0.2.44', arch,
    sandbox: major === 109 ? 'cef_sandbox' : 'bootstrap',
  }));
  const result = cefRelease.packageCef({ directory, output, privateKey, minWindows });
  const manifestFile = path.join(output, 'legacy/windows-x64/stable.json');
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  // Present a signed but incompatible candidate under the requested feed name
  // in negative cases; validation must inspect signed identity, not its path.
  fs.writeFileSync(manifestFile, JSON.stringify(result.envelope));
  f.options.cefDirectory = output;
  return { ...result, manifestFile, archive: path.join(output, 'objects', result.manifest.sha256 + '.zip') };
}

if (require.main === module) {
test('Win7 payload retains independent MCP version, signed identity and bounded validation evidence', t => {
  const f = fixture(t), prepared = preparePayload(f.options);
  const files = walk(prepared.payload);
  assert.ok(files.includes('Keepwork.exe'));
  assert.ok(files.includes('resources/win7-mcp/bin/keepwork-mcp.exe'));
  assert.equal(files.some(name => /aichat-rust\.exe|node\.exe|WebView2Loader\.dll|libcef\.dll/i.test(name)), false);
  const envelope = JSON.parse(fs.readFileSync(path.join(prepared.payload, 'resources/win7-mcp.signed.json')));
  const manifest = release.verifyEnvelope(envelope, key.publicKey);
  assert.equal(manifest.variant, 'win7-win8'); assert.equal(manifest.buildTarget, release.TARGET);
  assert.equal(manifest.version, '0.2.61'); assert.equal(prepared.version, '0.2.126');
  assert.equal(manifest.terminalApi, undefined);
  const validation = JSON.parse(fs.readFileSync(path.join(prepared.output, 'win7-validation.json')));
  assert.equal(validation.nativeWin7Verified, false);
  assert.equal(validation.checks.nativeCef, 'pending');
  assert.equal(validation.checks.nativeMcp, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.output, 'static-pe-report.json'))).files.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.payload, 'win7-edition.json'))).bundledCef, false);
  assert.equal(fs.existsSync(path.join(prepared.payload, 'resources/cef-bundled.zip')), false);
});

test('complete preview bundles the exact signed legacy CEF archive without claiming native rendering', t => {
  const f = fixture(t), cef = cefFixture(f), prepared = preparePayload(f.options);
  const resources = path.join(prepared.payload, 'resources');
  assert.deepEqual(fs.readFileSync(path.join(resources, 'cef-bundled.zip')), fs.readFileSync(cef.archive));
  const envelope = JSON.parse(fs.readFileSync(path.join(resources, 'cef-bundled.signed.json')));
  const metadata = cefRelease.verifyEnvelope(envelope, key.publicKey);
  assert.equal(metadata.channel, 'legacy'); assert.equal(metadata.chromiumMajor, 109); assert.equal(metadata.arch, 'x64');
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.payload, 'win7-edition.json'))).bundledCef, true);
  assert.deepEqual(fs.readFileSync(path.join(prepared.output, 'cef/objects', metadata.sha256 + '.zip')), fs.readFileSync(cef.archive));
  const validation = JSON.parse(fs.readFileSync(path.join(prepared.output, 'win7-validation.json')));
  assert.equal(validation.nativeLegacyVerified, false);
  assert.equal(validation.checks.nativeCef, 'pending');
});

for (const [label, options] of [
  ['another signing key', { privateKey: otherKey.privateKey }],
  ['a modern Chromium generation', { major: 143 }],
  ['a different architecture', { arch: 'x86' }],
  ['a higher minimum OS', { minWindows: [6, 1, 7602] }],
]) test(`complete preview rejects CEF with ${label}`, t => {
  const f = fixture(t); cefFixture(f, options);
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('complete preview refuses CEF ZIP and signed metadata tampering before staging', t => {
  const f = fixture(t), cef = cefFixture(f), original = fs.readFileSync(cef.archive);
  const corrupted = Buffer.from(original); corrupted[corrupted.length - 1] ^= 1;
  fs.writeFileSync(cef.archive, corrupted);
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
  fs.writeFileSync(cef.archive, original);
  const modified = { ...cef.envelope, payload: cef.envelope.payload.replace('"chromiumMajor":109', '"chromiumMajor":110') };
  fs.writeFileSync(cef.manifestFile, JSON.stringify(modified));
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('Win7 packaging refuses a different release key before creating output', t => {
  const f = fixture(t);
  assert.throws(() => preparePayload({ ...f.options, privateKey: otherKey.privateKey }));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('Win7 packaging rejects changed archive bytes instead of signing a damaged candidate', t => {
  const f = fixture(t), archive = path.join(f.options.mcpDirectory, 'windows-x64.zip');
  const bytes = fs.readFileSync(archive); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(archive, bytes);
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
});

for (const [field, value] of [
  ['variant', 'modern'], ['buildTarget', 'x86_64-pc-windows-msvc'], ['platform', 'macos'], ['arch', 'arm64'],
  ['terminalApi', 'pty-session-v1'], ['url', 'https://cdn.keepwork.com/keepwork/mcp-stable-rs/0.2.61/windows-x64.zip'],
]) test(`Win7 packaging cannot mistake an incompatible ${field} for a legacy artifact`, t => {
  const f = fixture(t), file = path.join(f.options.mcpDirectory, 'windows-x64.json');
  const manifest = JSON.parse(fs.readFileSync(file)); manifest[field] = value; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('Win7 packaging rejects a different bootstrap architecture and a different source commit', t => {
  const f = fixture(t);
  assert.throws(() => preparePayload({ ...f.options, commit: 'c'.repeat(40) }));
  fs.writeFileSync(f.options.bootstrap, Buffer.concat([pe(0xaa64), release.publicKeyBlob(key.publicKey)]));
  assert.throws(() => preparePayload(f.options));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('Win7 packaging refuses existing output without changing its contents', t => {
  const f = fixture(t); fs.mkdirSync(f.options.output);
  const sentinel = path.join(f.options.output, 'reviewed-artifact.txt'); fs.writeFileSync(sentinel, 'preserve');
  assert.throws(() => preparePayload(f.options));
  assert.deepEqual(fs.readdirSync(f.options.output), ['reviewed-artifact.txt']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});

test('Win7 packaging refuses linked input roots', t => {
  const f = fixture(t), linked = path.join(f.root, 'mcp-linked');
  try { fs.symlinkSync(f.options.mcpDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => preparePayload({ ...f.options, mcpDirectory: linked }));
  assert.equal(fs.existsSync(f.options.output), false);
});

test('Win7 NSIS compile produces only the separate signed client update channel', {
  skip: !nsisCompiler, timeout: 60000,
}, t => {
  const f = fixture(t); cefFixture(f);
  const result = packageWin7({ ...f.options, makensis: nsisCompiler }, {
    exec(command, args, options) {
      const output = execFileSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' });
      assert.doesNotMatch(output, /warning 6000:/i, 'NSIS rejected a variable or quoted command in the installer');
      return output;
    },
  });
  assert.ok(fs.statSync(result.installer).size > 65536);
  const envelope = JSON.parse(fs.readFileSync(path.join(result.output, 'client/windows-x64/latest-client.json')));
  const client = release.validateClientManifest(release.verifyEnvelope(envelope, key.publicKey));
  assert.equal(client.variant, 'win7-win8'); assert.equal(client.version, f.options.version);
  assert.equal(client.url, release.CLIENT_BASE + '/' + client.version + '/' + client.fileName);
  assert.equal(client.sha256, release.digest(fs.readFileSync(result.installer)));
  const tampered = { ...envelope, payload: envelope.payload.replace('win7-win8', 'modern') };
  assert.throws(() => release.verifyEnvelope(tampered, key.publicKey));
  assert.throws(() => release.verifyEnvelope(envelope, otherKey.publicKey));
});
}

module.exports = { fixture, cefFixture, key };
