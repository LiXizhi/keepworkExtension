#!/usr/bin/env node
'use strict';
// Standalone legacy payload. No modern Tauri/Node/WebView2 executable enters it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const release = require('../../../scripts/lib/win7-release.cjs');
const { auditDirectory, auditPe } = require('../../../scripts/lib/windows7-pe.cjs');
const identity = require('../../../scripts/lib/rust-runtime-identity.cjs');
const root = path.resolve(__dirname, '..');
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function preparePayload({ bootstrap, mcpDirectory, output, privateKey, version, commit, licenses, cefDirectory, sourceDirty = true }) {
  assert.ok(release.stableVersion(version), 'Require the desktop version');
  assert.match(commit, /^[a-f0-9]{40}$/, 'Require the full desktop source commit');
  assert.ok(!fs.existsSync(output), 'Win7 package output must be a new directory');
  assert.ok(!fs.lstatSync(bootstrap).isSymbolicLink() && !fs.lstatSync(mcpDirectory).isSymbolicLink(), 'Win7 inputs cannot be symlinks');
  const launcher = fs.readFileSync(bootstrap);
  auditPe(launcher);
  assert.ok(launcher.includes(release.publicKeyBlob(privateKey)), 'Launcher release key does not match the package signing key');
  const manifest = release.validateMcpManifest(JSON.parse(fs.readFileSync(path.join(mcpDirectory, 'windows-x64.json'), 'utf8')));
  assert.equal(manifest.commit, commit, 'Desktop and bundled MCP must come from the same source commit');
  const archive = fs.readFileSync(path.join(mcpDirectory, 'windows-x64.zip'));
  const members = release.validateMcpArchive(archive, manifest);
  let cef;
  if (cefDirectory) {
    assert.ok(!fs.lstatSync(cefDirectory).isSymbolicLink(), 'CEF release directory cannot be linked');
    const envelope = JSON.parse(fs.readFileSync(path.join(cefDirectory, 'legacy/windows-x64/stable.json'), 'utf8'));
    const metadata = require('./cef-release.cjs').verifyEnvelope(envelope, privateKey);
    assert.equal(metadata.channel, 'legacy'); assert.equal(metadata.arch, 'x64');
    assert.equal(metadata.chromiumMajor, 109); assert.deepEqual(metadata.minWindows, [6, 1, 7601]);
    const bytes = fs.readFileSync(path.join(cefDirectory, 'objects', metadata.sha256 + '.zip'));
    assert.equal(bytes.length, metadata.size, 'Bundled CEF archive size mismatch');
    assert.equal(release.digest(bytes), metadata.sha256, 'Bundled CEF archive hash mismatch');
    cef = { envelope, metadata, bytes };
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-identity-'));
  try {
    const binary = path.join(temporary, 'keepwork-mcp.exe'); fs.writeFileSync(binary, members.get('bin/keepwork-mcp.exe'));
    const info = identity.validateBinary(binary, { triple: release.TARGET }, manifest);
    assert.equal(info.variant, 'win7-win8'); assert.deepEqual(info.minWindows, [6, 1, 7601]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const signedMcp = release.signEnvelope(manifest, privateKey), payload = path.join(path.resolve(output), 'installer-payload');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'Keepwork.exe'), launcher, { flag: 'wx' });
  const runtime = path.join(payload, 'resources', 'win7-mcp');
  for (const [name, bytes] of members) {
    if (name.endsWith('/')) continue;
    const file = path.join(runtime, release.safePath(name));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  writeJson(path.join(payload, 'resources', 'win7-mcp.signed.json'), signedMcp);
  if (cef) {
    writeJson(path.join(payload, 'resources', 'cef-bundled.signed.json'), cef.envelope);
    fs.writeFileSync(path.join(payload, 'resources', 'cef-bundled.zip'), cef.bytes, { flag: 'wx' });
    writeJson(path.join(output, 'cef', 'legacy/windows-x64/stable.json'), cef.envelope);
    const object = path.join(output, 'cef', 'objects', cef.metadata.sha256 + '.zip');
    fs.mkdirSync(path.dirname(object), { recursive: true }); fs.writeFileSync(object, cef.bytes);
  }
  writeJson(path.join(payload, 'win7-edition.json'), { schemaVersion: 1, product: 'aichat-desktop',
    variant: 'win7-win8', version, commit, sourceDirty: sourceDirty !== false, arch: 'x64', minWindows: [6, 1, 7601],
    cefChannel: 'legacy', bundledCef: !!cef, mcpVersion: manifest.version, desktopBridge: false });
  if (licenses) {
    assert.ok(!fs.lstatSync(licenses).isSymbolicLink(), 'License directory cannot be linked');
    const destination = path.join(payload, 'licenses'); fs.mkdirSync(destination);
    for (const name of fs.readdirSync(licenses).sort()) {
      const file = path.join(licenses, name), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && /^[a-zA-Z0-9_.-]+\.txt$/.test(name), 'Unexpected launcher license file');
      fs.copyFileSync(file, path.join(destination, name));
    }
  }
  const mcpArchive = path.join(output, 'mcp', manifest.version, 'windows-x64.zip');
  fs.mkdirSync(path.dirname(mcpArchive), { recursive: true }); fs.writeFileSync(mcpArchive, archive);
  writeJson(path.join(output, 'mcp', 'windows-x64.json'), signedMcp);
  fs.writeFileSync(path.join(output, 'release-public.pem'), release.publicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  const peReport = auditDirectory(payload);
  writeJson(path.join(output, 'static-pe-report.json'), peReport);
  writeJson(path.join(output, 'win7-validation.json'), { schemaVersion: 1, product: 'aichat-desktop', variant: 'win7-win8',
    version, mcpVersion: manifest.version, commit, nativeWin7Verified: false, nativeLegacyVerified: false,
    systems: { windows7: 'pending', windows8: 'pending', windows81: 'pending' },
    checks: { staticImports: 'passed', nativeMcp: 'pending', nativeCef: 'pending', installerUpgrade: 'pending' } });
  return { output: path.resolve(output), payload, manifest, version, commit, sourceDirty: sourceDirty !== false };
}
function finalizeInstaller(prepared, installer, privateKey) {
  const bytes = fs.readFileSync(installer);
  // NSIS is a 32-bit bootstrapper on 64-bit Windows; its payload has already
  // passed the stricter x64 PE audit. Do not confuse the outer stub's machine.
  assert.ok(bytes.length > 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Invalid NSIS output');
  const fileName = `Keepwork_Win7_Win8_${prepared.version}_x64-setup.exe`;
  assert.equal(path.basename(installer), fileName, 'Wrong Win7 installer name');
  const client = release.validateClientManifest({ schemaVersion: 1, product: 'aichat-desktop', variant: 'win7-win8',
    version: prepared.version, commit: prepared.commit, sourceDirty: prepared.sourceDirty,
    platform: 'windows', arch: 'x64', format: 'exe',
    minWindows: [6, 1, 7601], fileName, size: bytes.length, sha256: release.digest(bytes),
    url: `${release.CLIENT_BASE}/${prepared.version}/${fileName}` });
  writeJson(path.join(prepared.output, 'client', 'windows-x64', 'latest-client.json'), release.signEnvelope(client, privateKey));
  return { ...prepared, installer, client };
}
function packageWin7(options, { exec = execFileSync } = {}) {
  const prepared = preparePayload(options);
  const installer = path.join(prepared.output, `Keepwork_Win7_Win8_${options.version}_x64-setup.exe`);
  const compiler = options.makensis || process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
  const prefix = process.platform === 'win32' ? '/' : '-';
  exec(compiler, [`${prefix}INPUTCHARSET`, 'UTF8', `${prefix}DPAYLOAD=${prepared.payload}`,
    `${prefix}DOUTPUT=${installer}`, `${prefix}DVERSION=${options.version}`, path.join(root, 'windows', 'win7-installer.nsi')],
  { stdio: 'inherit' });
  return finalizeInstaller(prepared, installer, options.privateKey);
}
function readArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert.ok(['--bootstrap', '--mcp', '--out', '--key', '--makensis', '--cef', '--licenses'].includes(key) && args[index + 1]
      && !options[key.slice(2)], 'Use --bootstrap FILE --mcp DIRECTORY --out NEW_DIRECTORY --key PRIVATE.pem [--makensis FILE]');
    options[key.slice(2)] = args[index + 1];
  }
  return options;
}
if (require.main === module) {
  try {
    const args = readArgs(process.argv.slice(2));
    assert.ok(args.bootstrap && args.mcp && args.out && args.key, '--bootstrap, --mcp, --out and --key are required');
    const result = packageWin7({ bootstrap: args.bootstrap, mcpDirectory: args.mcp, output: args.out,
      privateKey: fs.readFileSync(args.key), makensis: args.makensis, cefDirectory: args.cef,
      licenses: args.licenses || path.join(path.dirname(path.resolve(args.bootstrap)), 'licenses'),
      sourceDirty: sourceIsDirty(),
      version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim() });
    console.log(JSON.stringify({ installer: result.installer, version: result.version,
      mcpVersion: result.manifest.version, nativeWin7Verified: false }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
function sourceIsDirty(exec = execFileSync) {
  // Generated build trees live outside these source paths. Untracked source
  // files count as dirty, while downloaded SDKs and build output do not.
  return exec('git', ['status', '--porcelain', '--untracked-files=all', '--',
    'apps/aichat-rust', 'apps/mcp-rust', 'scripts/lib', '.github/workflows', '.github/skills/rust-release'],
  { cwd: path.resolve(root, '../..'), encoding: 'utf8' }).trim() !== '';
}
module.exports = { preparePayload, finalizeInstaller, packageWin7, readArgs, sourceIsDirty };
