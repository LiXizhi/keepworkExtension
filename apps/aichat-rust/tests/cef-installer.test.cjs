const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateDesktopPayload } = require('../scripts/build-windows-compat.cjs');

const machines = { x64: 0x8664, arm64: 0xaa64 };
function pe(arch) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64, 'ascii'); bytes.writeUInt16LE(machines[arch], 68);
  return bytes;
}
function payload(t, arch = 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-compatible-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'resources', 'mcp-runtime', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aichat-rust.exe'), pe(arch));
  fs.writeFileSync(path.join(root, 'Keepwork.exe'), pe(arch));
  fs.writeFileSync(path.join(root, 'WebView2Loader.dll'), pe(arch));
  fs.writeFileSync(path.join(root, 'resources', 'mcp-runtime', 'bin', 'keepwork-mcp.exe'), pe(arch));
  fs.writeFileSync(path.join(root, 'resources', 'mcp-runtime', 'runtime.json'), '{}');
  return root;
}

for (const arch of ['x64', 'arm64']) test(`compatible installer accepts ${arch} native desktop payload without CEF`, t => {
  const root = payload(t, arch), files = validateDesktopPayload(root, arch);
  assert.equal(files.length, 5);
  assert.ok(files.includes(path.join(root, 'aichat-rust.exe')));
  assert.ok(files.includes(path.join(root, 'resources', 'mcp-runtime', 'bin', 'keepwork-mcp.exe')));
});

test('compatible installer refuses CEF engine and resources anywhere inside payload', t => {
  const root = payload(t), nested = path.join(root, 'resources', 'accidental-browser');
  fs.mkdirSync(nested);
  for (const name of ['libcef.dll', 'LIBCEF.DLL', 'chrome_elf.dll', 'keepwork-cef.exe', 'keepwork-cef.dll', 'cef-host.json', 'CEF-LICENSE.txt', 'resources.pak', 'en-US.pak']) {
    const file = path.join(nested, name); fs.writeFileSync(file, 'must be downloaded separately');
    assert.throws(() => validateDesktopPayload(root, 'x64'), /CEF must not enter the installer/, name);
    fs.rmSync(file);
  }
});

test('compatible installer refuses unsupported and mismatched executable architectures', t => {
  const root = payload(t);
  assert.throws(() => validateDesktopPayload(root, 'x86'), /x64 and ARM64/);
  assert.throws(() => validateDesktopPayload(root, 'arm64'), /Desktop architecture mismatch/);
  const runtime = path.join(root, 'resources', 'mcp-runtime', 'bin', 'keepwork-mcp.exe');
  fs.writeFileSync(runtime, pe('arm64'));
  assert.throws(() => validateDesktopPayload(root, 'x64'), /Payload binary architecture mismatch/);
  fs.writeFileSync(runtime, pe('x64')); fs.rmSync(path.join(root, 'aichat-rust.exe'));
  assert.throws(() => validateDesktopPayload(root, 'x64'), /ENOENT/);
});

test('compatible installer rejects linked payload directories', t => {
  const root = payload(t), link = path.join(root, 'linked');
  try { fs.symlinkSync(path.join(root, 'resources'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows link privilege unavailable');
    throw error;
  }
  assert.throws(() => validateDesktopPayload(root, 'x64'), /symlinks/);
});

const compiler = process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
test('Windows compatible NSIS installer compiles x64 and ARM64 guards without CEF files', {
  skip: process.platform !== 'win32' || !fs.existsSync(compiler), timeout: 120000,
}, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-compatible-nsis-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  for (const arch of ['x64', 'arm64']) {
    const root = payload(t, arch), installer = path.join(output, `compatible-${arch}.exe`);
    const result = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/DPAYLOAD=' + root, '/DOUTPUT=' + installer,
      '/DVERSION=0.2.41', '/DARCH=' + arch, path.resolve(__dirname, '../windows/installer.nsi')],
    { encoding: 'utf8', windowsHide: true, timeout: 55000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.statSync(installer).size > 0);
  }
});
