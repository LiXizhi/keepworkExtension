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
function payload(t, arch = 'x64', layout = 'flat') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-compatible-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'resources', 'mcp-runtime', ...(layout === 'nested' ? [arch] : []));
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aichat-rust.exe'), pe(arch));
  fs.writeFileSync(path.join(root, 'Keepwork.exe'), pe(arch));
  fs.writeFileSync(path.join(root, 'WebView2Loader.dll'), pe(arch));
  fs.writeFileSync(path.join(runtime, 'bin', 'keepwork-mcp.exe'), pe(arch));
  fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({
    schemaVersion: 2, product: 'keepwork-mcp-runtime', engine: 'rust', platform: 'windows',
    arch, entry: 'bin/keepwork-mcp.exe', version: '0.2.61',
  }));
  return root;
}

for (const arch of ['x64', 'arm64']) for (const layout of ['flat', 'nested']) test(`compatible installer accepts ${arch} ${layout} native desktop payload without CEF`, t => {
  const root = payload(t, arch, layout), files = validateDesktopPayload(root, arch);
  assert.equal(files.length, 5);
  assert.ok(files.includes(path.join(root, 'aichat-rust.exe')));
  assert.ok(files.includes(path.join(root, 'resources', 'mcp-runtime', ...(layout === 'nested' ? [arch] : []), 'bin', 'keepwork-mcp.exe')));
});

test('compatible installer requires bundled MCP metadata and executable', t => {
  for (const name of ['runtime.json', path.join('bin', 'keepwork-mcp.exe')]) {
    const root = payload(t);
    fs.rmSync(path.join(root, 'resources', 'mcp-runtime', name));
    assert.throws(() => validateDesktopPayload(root, 'x64'), /ENOENT/, name);
  }
});

test('compatible installer rejects invalid or mismatched bundled MCP metadata', t => {
  const root = payload(t), file = path.join(root, 'resources', 'mcp-runtime', 'runtime.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [field, value] of [
    ['schemaVersion', 1], ['product', 'keepwork-mcp-node-runtime'], ['engine', 'node'],
    ['platform', 'macos'], ['arch', 'arm64'], ['entry', '../keepwork-mcp.exe'],
    ['version', undefined], ['version', null], ['version', ''], ['version', '   '],
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, [field]: value }));
    assert.throws(() => validateDesktopPayload(root, 'x64'), /matching bundled Rust MCP/, field);
  }
  fs.writeFileSync(file, '{');
  assert.throws(() => validateDesktopPayload(root, 'x64'), SyntaxError);
  fs.writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => validateDesktopPayload(root, 'x64'), /metadata exceeds size limit/);
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

test('CEF window uses the Keepwork product title', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../windows/cef-host/main.cpp'), 'utf8');
  assert.equal(source.match(/constexpr wchar_t kTitle\[\] = L"([^"]+)";/)?.[1], 'Keepwork');
  assert.doesNotMatch(source, /Keepwork\s*[—-]\s*兼容模式/);
});

for (const [installer, link, otherLink] of [
  ['installer.nsi', 'Keepwork 兼容版.lnk', 'Keepwork Windows 7 and 8.lnk'],
  ['win7-installer.nsi', 'Keepwork Windows 7 and 8.lnk', 'Keepwork 兼容版.lnk'],
]) test(`${installer} creates and removes only its own current-user desktop shortcut`, () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../windows', installer), 'utf8');
  const [install, uninstall] = source.split('Section "Uninstall"');
  assert.ok(uninstall, 'uninstall section must exist');
  assert.ok(install.includes('SetShellVarContext current'));
  assert.ok(uninstall.includes('SetShellVarContext current'));
  assert.ok(install.includes(`CreateShortcut "$DESKTOP\\${link}" "$INSTDIR\\Keepwork.exe"`),
    'desktop entry must launch the bootstrap, which starts the matching MCP and selects the browser');
  assert.ok(uninstall.includes(`Delete "$DESKTOP\\${link}"`));
  assert.ok(!source.includes(`$DESKTOP\\${otherLink}`), 'one edition must preserve the other edition desktop entry');
  assert.ok(!source.includes('$DESKTOP\\Keepwork.lnk'), 'do not overwrite the standard desktop client entry');
});

for (const installer of ['installer.nsi', 'win7-installer.nsi']) test(`${installer} gives every shortcut and the installed application an explicit product icon`, () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../windows', installer), 'utf8');
  const shortcuts = source.split('\n').filter(line => /^\s*CreateShortcut\s/.test(line));
  assert.ok(shortcuts.length >= 2, 'desktop and Start menu shortcuts must both exist');
  for (const line of shortcuts) {
    const args = [...line.matchAll(/"([^"]*)"/g)].map(match => match[1]);
    assert.equal(args[1], '$INSTDIR\\Keepwork.exe', 'shortcuts must retain the bootstrap target');
    assert.equal(args[3], '$INSTDIR\\Keepwork.exe', `shortcut must use the embedded icon: ${line}`);
    assert.match(line, /"\$INSTDIR\\Keepwork\.exe"\s+0(?:\s|$)/, 'select the first embedded icon');
  }
  assert.match(source, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^"\n]+" "DisplayIcon" [^\n]*\$INSTDIR\\Keepwork\.exe/,
    'Windows installed-apps entry must use the same product icon');
});

const compiler = process.env.MAKENSIS || [
  'C:/Program Files (x86)/NSIS/makensis.exe', '/opt/homebrew/bin/makensis', '/usr/local/bin/makensis', '/usr/bin/makensis',
].find(file => fs.existsSync(file));
test('Windows compatible NSIS installer compiles x64 and ARM64 guards without CEF files', {
  skip: !compiler || !fs.existsSync(compiler), timeout: 120000,
}, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-compatible-nsis-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  for (const arch of ['x64', 'arm64']) {
    const root = payload(t, arch), installer = path.join(output, `compatible-${arch}.exe`);
    const prefix = process.platform === 'win32' ? '/' : '-';
    const result = spawnSync(compiler, [prefix + 'INPUTCHARSET', 'UTF8', prefix + 'DPAYLOAD=' + root, prefix + 'DOUTPUT=' + installer,
      prefix + 'DVERSION=0.2.41', prefix + 'DARCH=' + arch, path.resolve(__dirname, '../windows/installer.nsi')],
    { encoding: 'utf8', windowsHide: true, timeout: 55000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /warning 6000:/i,
      'installer commands must not contain rejected variables or quoting');
    assert.ok(fs.statSync(installer).size > 0);
  }
});
