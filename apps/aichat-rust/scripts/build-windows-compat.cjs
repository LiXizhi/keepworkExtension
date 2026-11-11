#!/usr/bin/env node
// Opt-in first-release installer: bootstrap + existing desktop payload, never CEF.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { keyHeader, peMachine } = require('./cef-release.cjs');
const appRoot = path.resolve(__dirname, '..');
const machines = { x64: 0x8664, arm64: 0xaa64 };
function payloadFiles(directory) {
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Payload root must not be a symlink');
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Installer payload cannot contain symlinks');
    assert.ok(!/^(libcef\.dll|chrome_elf\.dll|keepwork-cef\.(exe|dll)|cef-host\.json|CEF-LICENSE\.txt)$/i.test(entry.name) && !/\.pak$/i.test(entry.name), 'CEF must not enter the installer');
    return entry.isDirectory() ? payloadFiles(file) : [file];
  });
}
function validateDesktopPayload(directory, arch) {
  assert.ok(machines[arch], 'Compatible installer currently supports x64 and ARM64');
  const files = payloadFiles(directory);
  assert.equal(peMachine(path.join(directory, 'aichat-rust.exe')), machines[arch], 'Desktop architecture mismatch');
  for (const file of files) if (/\.(exe|dll)$/i.test(file)) assert.equal(peMachine(file), machines[arch], 'Payload binary architecture mismatch');
  return files;
}
function main(options) {
  assert.equal(process.platform, 'win32', 'Build the compatible Windows installer on Windows');
  const payload = fs.realpathSync(options.payload), output = path.resolve(options.output), arch = options.arch || 'x64';
  validateDesktopPayload(payload, arch);
  assert.ok(!fs.existsSync(output), 'Use a new output directory');
  // Canonicalize the nearest existing parent before testing containment (junctions/aliases included).
  let ancestor = output; const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const canonicalOutput = path.join(fs.realpathSync(ancestor), ...suffix);
  const relativeOutput = path.relative(payload, canonicalOutput);
  assert.ok(relativeOutput && (relativeOutput === '..' || relativeOutput.startsWith('..' + path.sep) || path.isAbsolute(relativeOutput)), 'Output cannot be inside the payload');
  fs.mkdirSync(output, { recursive: true });
  const header = path.join(output, 'release-key.hpp');
  fs.writeFileSync(header, keyHeader(fs.readFileSync(options.key)));
  const build = path.join(output, 'bootstrap-build');
  execFileSync('cmake', ['-S', path.join(appRoot, 'windows'), '-B', build, '-A', arch === 'arm64' ? 'ARM64' : 'x64', '-DKEEPWORK_PUBLIC_KEY_HEADER=' + header], { stdio: 'inherit' });
  execFileSync('cmake', ['--build', build, '--config', 'Release'], { stdio: 'inherit' });
  if (arch === process.arch) execFileSync('ctest', ['--test-dir', build, '-C', 'Release', '--output-on-failure'], { stdio: 'inherit' });
  const native = path.join(build, 'Release');
  const stage = path.join(output, 'installer-payload');
  assert.ok(!fs.existsSync(stage), 'Installer staging directory must be new');
  fs.cpSync(payload, stage, { recursive: true });
  for (const name of ['Keepwork.exe', 'WebView2Loader.dll']) fs.copyFileSync(path.join(native, name), path.join(stage, name));
  fs.cpSync(path.join(native, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
  validateDesktopPayload(stage, arch);
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'))).version;
  const installer = path.join(output, `Keepwork-Compatible_${version}_${arch}-setup.exe`);
  const compiler = process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
  execFileSync(compiler, ['/INPUTCHARSET', 'UTF8', '/DPAYLOAD=' + stage, '/DOUTPUT=' + installer, '/DVERSION=' + version, '/DARCH=' + arch, path.join(appRoot, 'windows/installer.nsi')], { stdio: 'inherit' });
  const bytes = fs.readFileSync(installer);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(output, 'compatible-installer.json'), JSON.stringify({ schemaVersion: 1, product: 'aichat-desktop', version, platform: 'win32', arch, format: 'nsis', fileName: path.basename(installer), size: bytes.length, sha256,
    url: `https://cdn.keepwork.com/keepwork/aichat-cef/v1/client/windows-${arch}/${path.basename(installer)}`, includesCef: false }, null, 2) + '\n');
  console.log(installer);
}
if (require.main === module) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    assert.ok(options.payload && options.output && options.key, 'Usage: build-windows-compat.cjs --payload DIR --output DIR --key PUBLIC.pem [--arch x64|arm64]');
    main(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { payloadFiles, validateDesktopPayload };
