const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { auditPe, auditDirectory } = require('./lib/windows7-pe.cjs');

// A complete PE32+ layout with section-backed RVA tables. This fixture is
// deliberately not executable; these cases exercise the release audit only.
function pe({ arch = 'x64', subsystem = [6, 1], imports = [], delayed = [] } = {}) {
  const bytes = Buffer.alloc(0x1200);
  const coff = 0x84, optional = coff + 20, section = optional + 0xf0;
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE({ x64: 0x8664, arm64: 0xaa64, x86: 0x14c }[arch], coff);
  bytes.writeUInt16LE(1, coff + 2);
  bytes.writeUInt16LE(0xf0, coff + 16);
  bytes.writeUInt16LE(0x22, coff + 18);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x1000, optional + 32);
  bytes.writeUInt32LE(0x200, optional + 36);
  bytes.writeUInt16LE(6, optional + 40);
  bytes.writeUInt16LE(1, optional + 42);
  bytes.writeUInt16LE(subsystem[0], optional + 48);
  bytes.writeUInt16LE(subsystem[1], optional + 50);
  bytes.writeUInt32LE(0x2000, optional + 56);
  bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.write('.rdata', section, 'ascii');
  bytes.writeUInt32LE(0x1000, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x40000040, section + 36);
  let cursor = 0x200;
  const rva = offset => offset - 0x200 + 0x1000;
  const alloc = (size, alignment = 1) => {
    cursor = Math.ceil(cursor / alignment) * alignment;
    const result = cursor; cursor += size;
    assert.ok(cursor < bytes.length, 'fixture exceeds its section');
    return result;
  };
  const text = value => {
    const offset = alloc(Buffer.byteLength(value) + 1);
    bytes.write(value, offset, 'ascii');
    return rva(offset);
  };
  const thunks = symbols => {
    const offset = alloc((symbols.length + 1) * 8, 8);
    for (const [index, symbol] of symbols.entries()) {
      if (typeof symbol === 'number') {
        bytes.writeBigUInt64LE((1n << 63n) | BigInt(symbol), offset + index * 8);
      } else {
        const hint = alloc(Buffer.byteLength(symbol) + 3, 2);
        bytes.write(symbol, hint + 2, 'ascii');
        bytes.writeBigUInt64LE(BigInt(rva(hint)), offset + index * 8);
      }
    }
    return rva(offset);
  };
  for (const [table, directory, stride] of [[imports, 1, 20], [delayed, 13, 32]]) {
    if (!table.length) continue;
    const descriptors = alloc((table.length + 1) * stride, 8);
    bytes.writeUInt32LE(rva(descriptors), optional + 112 + directory * 8);
    bytes.writeUInt32LE((table.length + 1) * stride, optional + 116 + directory * 8);
    for (const [index, entry] of table.entries()) {
      const at = descriptors + index * stride;
      const dll = text(entry.dll), lookup = thunks(entry.symbols);
      if (directory === 1) {
        bytes.writeUInt32LE(lookup, at);
        bytes.writeUInt32LE(dll, at + 12);
        bytes.writeUInt32LE(lookup, at + 16);
      } else {
        bytes.writeUInt32LE(1, at); // delay descriptor uses RVAs, not VAs
        bytes.writeUInt32LE(dll, at + 4);
        bytes.writeUInt32LE(lookup, at + 12);
        bytes.writeUInt32LE(lookup, at + 16);
      }
    }
  }
  return bytes;
}

const safe = () => pe({ imports: [
  { dll: 'KERNEL32.dll', symbols: ['CreateProcessW', 'GetTickCount64', 'CloseHandle'] },
  { dll: 'bcrypt.dll', symbols: ['BCryptOpenAlgorithmProvider'] },
] });

test('Win7 audit reads named imports from a complete x64 PE section', () => {
  const report = auditPe(safe(), { arch: 'x64' });
  assert.equal(report.machine, 0x8664);
  assert.deepEqual(report.subsystemVersion, [6, 1]);
  assert.ok(report.imports);
  const recorded = JSON.stringify(report.imports).toLowerCase();
  for (const expected of ['kernel32.dll', 'gettickcount64', 'bcrypt.dll']) {
    assert.ok(recorded.includes(expected), `audit must record ${expected}`);
  }
});

test('an otherwise valid empty import table is not confused with a truncated PE', () => {
  assert.doesNotThrow(() => auditPe(pe(), { arch: 'x64' }));
});

for (const symbol of [
  'GetSystemTimePreciseAsFileTime', 'WaitOnAddress', 'WakeByAddressAll', 'WakeByAddressSingle',
  'CreatePseudoConsole', 'ResizePseudoConsole', 'ClosePseudoConsole', 'SetThreadDescription',
  'GetTempPath2W', 'DiscardVirtualMemory', 'CreateFile2', 'CopyFile2',
]) test(`Win7 audit rejects the post-Win7 import ${symbol}`, () => {
  assert.throws(() => auditPe(pe({ imports: [{ dll: 'KERNEL32.dll', symbols: [symbol] }] }), { arch: 'x64' }));
});

for (const dll of [
  'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll', 'combase.dll',
  'ext-ms-win-ntuser-window-l1-1-0.dll', 'api-ms-win-core-winrt-l1-1-0.dll', 'BCRYPTPRIMITIVES.DLL',
]) {
  test(`Win7 audit rejects the unsupported loader dependency ${dll}`, () => {
    assert.throws(() => auditPe(pe({ imports: [{ dll, symbols: ['UnsupportedFixtureSymbol'] }] }), { arch: 'x64' }));
  });
}

test('Win7 audit checks delay-loaded imports as well as ordinary imports', () => {
  assert.throws(() => auditPe(pe({ delayed: [{ dll: 'KERNEL32.dll', symbols: ['CreatePseudoConsole'] }] }), { arch: 'x64' }));
  assert.doesNotThrow(() => auditPe(pe({ delayed: [{ dll: 'KERNEL32.dll', symbols: ['GetTickCount64'] }] }), { arch: 'x64' }));
});

for (const symbol of ['CreateFile2', 'CopyFile2']) {
  test(`Win7 audit rejects the delay-loaded post-Win7 import ${symbol}`, () => {
    assert.throws(() => auditPe(pe({ delayed: [{ dll: 'KERNEL32.dll', symbols: [symbol] }] }), { arch: 'x64' }),
      new RegExp(`KERNEL32\\.dll!${symbol}`, 'i'));
  });
}

test('Win7 audit records valid ordinal thunks without treating them as out-of-range RVAs', () => {
  const report = auditPe(pe({ imports: [{ dll: 'WS2_32.dll', symbols: [23] }] }), { arch: 'x64' });
  assert.equal(report.imports[0].functions[0], 'ordinal:23');
});

test('Win7 audit rejects later subsystem versions and a different architecture', () => {
  for (const version of [[6, 2], [10, 0]]) {
    assert.throws(() => auditPe(pe({ subsystem: version }), { arch: 'x64' }));
  }
  for (const arch of ['arm64', 'x86']) {
    assert.throws(() => auditPe(pe({ arch }), { arch: 'x64' }));
  }
  const newerOs = safe(); newerOs.writeUInt16LE(10, 0x98 + 40);
  assert.throws(() => auditPe(newerOs, { arch: 'x64' }));
});

test('Win7 audit rejects truncated headers, truncated sections and invalid RVA tables', () => {
  for (const size of [0, 1, 63, 127, 0x90, 0x120, 0x1a0, 0x11ff]) {
    assert.throws(() => auditPe(safe().subarray(0, size), { arch: 'x64' }), `size ${size}`);
  }
  const badPeOffset = safe(); badPeOffset.writeUInt32LE(0xfffffff0, 0x3c);
  assert.throws(() => auditPe(badPeOffset, { arch: 'x64' }));
  const badImportRva = safe(); badImportRva.writeUInt32LE(0x7ffff000, 0x98 + 120);
  assert.throws(() => auditPe(badImportRva, { arch: 'x64' }));
  const wrongOptionalMagic = safe(); wrongOptionalMagic.writeUInt16LE(0x10b, 0x98);
  assert.throws(() => auditPe(wrongOptionalMagic, { arch: 'x64' }));
});

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-pe-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'resources', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Keepwork.exe'), safe());
  fs.writeFileSync(path.join(root, 'resources', 'nested', 'helper.DLL'), safe());
  fs.writeFileSync(path.join(root, 'README.txt'), 'This is a release-audit fixture.');
  return root;
}

test('Win7 directory audit checks nested DLLs and every executable', t => {
  const root = directory(t);
  assert.doesNotThrow(() => auditDirectory(root, { arch: 'x64' }));
  const nested = path.join(root, 'resources', 'nested', 'helper.DLL');
  fs.writeFileSync(nested, pe({ imports: [{ dll: 'KERNEL32.dll', symbols: ['WaitOnAddress'] }] }));
  assert.throws(() => auditDirectory(root, { arch: 'x64' }));
  fs.writeFileSync(nested, pe({ arch: 'arm64' }));
  assert.throws(() => auditDirectory(root, { arch: 'x64' }));
});

test('Win7 directory report bounds its evidence to the checked binaries and import scope', t => {
  const root = directory(t), report = auditDirectory(root, { arch: 'x64' });
  assert.equal(report.nativeWin7Verified, false);
  assert.equal(report.scope, 'known-static-and-delay-imports');
  assert.equal(report.files.length, 2);
});

test('Win7 directory audit refuses case-colliding Windows paths', t => {
  const root = directory(t);
  const original = path.join(root, 'Keepwork.exe'), collision = path.join(root, 'KEEPWORK.EXE');
  fs.writeFileSync(collision, safe());
  if (fs.readdirSync(root).filter(name => name.toLowerCase() === 'keepwork.exe').length < 2) {
    return t.skip('Filesystem is case-insensitive; duplicate-path check requires a case-sensitive volume.');
  }
  assert.notEqual(fs.statSync(original).ino, fs.statSync(collision).ino);
  assert.throws(() => auditDirectory(root, { arch: 'x64' }));
});

test('Win7 audit rejects a supplied real modern Windows MCP binary', t => {
  const executable = process.env.KEEPWORK_WIN7_INCOMPATIBLE_PE;
  if (!executable) return t.skip('Set KEEPWORK_WIN7_INCOMPATIBLE_PE to a real modern Windows MCP executable.');
  const bytes = fs.readFileSync(executable);
  assert.ok(bytes.length > 65536, 'Use a real compiled PE binary for this integration check.');
  assert.throws(() => auditPe(bytes, { arch: 'x64' }), /Win7 incompatible/);
});

test('Win7 directory audit rejects symlinked members and a symlinked root', t => {
  const root = directory(t), linked = root + '-link';
  t.after(() => fs.rmSync(linked, { force: true }));
  try {
    fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => auditDirectory(linked, { arch: 'x64' }));
  fs.symlinkSync(path.join(root, 'Keepwork.exe'), path.join(root, 'linked.exe'));
  assert.throws(() => auditDirectory(root, { arch: 'x64' }));
});

test('Win7 release audit CLI emits a bounded report only after the entire payload passes', t => {
  const root = directory(t), report = path.join(root, 'pe-audit.json');
  const executable = path.resolve(__dirname, 'lib/windows7-pe.cjs');
  const run = () => spawnSync(process.execPath, [executable, root, '--output', report], { encoding: 'utf8' });
  const accepted = run();
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).nativeWin7Verified, false);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).files.length, 2);
  fs.rmSync(report);
  fs.writeFileSync(path.join(root, 'resources', 'nested', 'helper.DLL'),
    pe({ imports: [{ dll: 'KERNEL32.dll', symbols: ['WaitOnAddress'] }] }));
  const refused = run();
  assert.ifError(refused.error);
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(report), false);
});

test('a D3DCompiler filename cannot exempt different PE bytes from the Win7 OS baseline', t => {
  const root = directory(t), bytes = pe({ subsystem: [6, 0] });
  bytes.writeUInt16LE(6, 0x98 + 40); bytes.writeUInt16LE(3, 0x98 + 42);
  fs.writeFileSync(path.join(root, 'd3dcompiler_47.dll'), bytes);
  assert.throws(() => auditDirectory(root, { arch: 'x64' }), /minimum OS\/subsystem/);
});

test('only the exact vendor SDK 8.1 D3DCompiler bytes receive the documented OS-header exception', t => {
  const file = process.env.KEEPWORK_WIN7_SDK81_D3D_DLL;
  if (!file) return t.skip('Set KEEPWORK_WIN7_SDK81_D3D_DLL to the unchanged Microsoft SDK 8.1 x64 redistributable.');
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, 'e994847e01a6f1e4cbdc5a864616ac262f67ee4f14db194984661a8d927ab7f4');
  const report = auditPe(bytes, { arch: 'x64' });
  assert.deepEqual(report.osVersion, [6, 3]);
  assert.deepEqual(report.subsystemVersion, [6, 0]);
  assert.deepEqual(report.compatibilityNotes, [{ id: 'microsoft-sdk81-d3dcompiler47', sha256,
    scope: 'os-version-header-only', supportReference: 'https://walbourn.github.io/hlsl-fxc-and-d3dcompile/' }]);
  const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => auditPe(corrupted, { arch: 'x64' }), /minimum OS\/subsystem/);
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'd3dcompiler_47.dll'), bytes);
  const complete = auditDirectory(root, { arch: 'x64' });
  assert.equal(complete.nativeWin7Verified, false);
  assert.equal(complete.nativeLegacyVerified, false);
  assert.equal(complete.files.find(entry => entry.path === 'd3dcompiler_47.dll').compatibilityNotes[0].sha256, sha256);
  fs.writeFileSync(path.join(root, 'd3dcompiler_47.dll'), corrupted);
  assert.throws(() => auditDirectory(root, { arch: 'x64' }), /minimum OS\/subsystem/);
});

test('a supplied newer SDK D3DCompiler is not mistaken for the pinned legacy redistributable', t => {
  const file = process.env.KEEPWORK_WIN7_MODERN_D3D_DLL;
  if (!file) return t.skip('Set KEEPWORK_WIN7_MODERN_D3D_DLL to the newer SDK D3DCompiler negative fixture.');
  const bytes = fs.readFileSync(file);
  assert.notEqual(crypto.createHash('sha256').update(bytes).digest('hex'),
    'e994847e01a6f1e4cbdc5a864616ac262f67ee4f14db194984661a8d927ab7f4');
  assert.throws(() => auditPe(bytes, { arch: 'x64' }));
});

module.exports = { pe };
