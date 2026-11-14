#!/usr/bin/env node
'use strict';

// Build-time guard for known Win7 loader incompatibilities. Dynamic API use and
// application behavior still require the native Win7 acceptance run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Microsoft explicitly supports app-local Win7 use of this SDK redistributable,
// although its informational OS header says 6.3. Only these exact unmodified
// bytes receive the exception; architecture, subsystem and imports still pass
// the normal checks. The newer Server SDK DLL is deliberately not accepted.
const sdk81D3dCompiler47 = 'e994847e01a6f1e4cbdc5a864616ac262f67ee4f14db194984661a8d927ab7f4';
const sdkSupportReference = 'https://walbourn.github.io/hlsl-fxc-and-d3dcompile/';

const incompatibleDlls = new Set([
  'bcryptprimitives.dll', 'combase.dll', 'dcomp.dll',
  'api-ms-win-core-synch-l1-2-0.dll', 'api-ms-win-core-path-l1-1-0.dll',
]);
const incompatibleApis = new Set([
  'ProcessPrng', 'WaitOnAddress', 'WakeByAddressAll', 'WakeByAddressSingle',
  'GetSystemTimePreciseAsFileTime', 'GetTempPath2W', 'GetTempPath2A',
  'CreatePseudoConsole', 'ResizePseudoConsole', 'ClosePseudoConsole',
  'GetOverlappedResultEx', 'CreateFile2', 'CopyFile2', 'DiscardVirtualMemory',
  'OfferVirtualMemory', 'ReclaimVirtualMemory', 'SetThreadDescription',
  'GetThreadDescription', 'SetProcessInformation', 'SetThreadInformation',
  'GetSystemCpuSetInformation', 'GetDpiForWindow', 'GetDpiForSystem',
  'SetThreadDpiAwarenessContext', 'SetProcessDpiAwarenessContext',
  'AreDpiAwarenessContextsEqual', 'GetPackageFamilyName', 'GetCurrentPackageFullName',
]);

function parsePe(bytes) {
  assert.ok(Buffer.isBuffer(bytes), 'PE input must be a Buffer');
  function range(offset, size) {
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0
      && offset <= bytes.length - size, 'Truncated or invalid PE range');
    return offset;
  }
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  const u64 = offset => bytes.readBigUInt64LE(range(offset, 8));
  const integer = value => {
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), 'PE address exceeds safe range');
    return Number(value);
  };
  assert.equal(bytes.toString('ascii', range(0, 2), 2), 'MZ', 'Invalid PE DOS signature');
  const header = u32(0x3c);
  assert.equal(bytes.toString('ascii', range(header, 24), header + 4), 'PE\0\0', 'Invalid PE signature');
  const machine = u16(header + 4), sectionCount = u16(header + 6);
  const optional = header + 24, optionalSize = u16(header + 20);
  range(optional, optionalSize);
  const magic = u16(optional), is64 = magic === 0x20b;
  assert.ok(is64 || magic === 0x10b, 'Unsupported PE optional header');
  const directoryOffset = is64 ? 112 : 96, countOffset = is64 ? 108 : 92;
  assert.ok(optionalSize >= directoryOffset, 'Truncated PE optional header');
  const directoryCount = u32(optional + countOffset);
  assert.ok(directoryCount <= 16 && directoryOffset + directoryCount * 8 <= optionalSize,
    'Invalid PE data directories');
  assert.ok(sectionCount > 0 && sectionCount <= 96, 'Invalid PE section count');
  const sections = [];
  range(optional + optionalSize, sectionCount * 40);
  for (let i = 0; i < sectionCount; i++) {
    const offset = optional + optionalSize + i * 40;
    const section = { virtualSize: u32(offset + 8), address: u32(offset + 12),
      size: u32(offset + 16), offset: u32(offset + 20) };
    range(section.offset, section.size);
    sections.push(section);
  }
  const headerSize = u32(optional + 60);
  function rva(address, size = 1) {
    assert.ok(Number.isSafeInteger(address) && address >= 0, 'Invalid PE RVA');
    if (address < headerSize) return range(address, size);
    const matches = sections.filter(section => address >= section.address
      && address - section.address < Math.max(section.size, section.virtualSize));
    assert.equal(matches.length, 1, 'Unmapped or ambiguous PE RVA');
    const section = matches[0], relative = address - section.address;
    assert.ok(relative <= section.size - size, 'PE RVA points outside on-disk section');
    return range(section.offset + relative, size);
  }
  function string(address) {
    const start = rva(address), end = bytes.indexOf(0, start);
    assert.ok(end >= start && end - start < 4096, 'Invalid PE import string');
    rva(address, end - start + 1);
    const value = bytes.toString('ascii', start, end);
    assert.ok(value && /^[\x21-\x7e]+$/.test(value), 'Invalid PE import name');
    return value;
  }
  const imageBase = is64 ? integer(u64(optional + 24)) : u32(optional + 28);
  const imports = [];
  function thunks(address) {
    const names = [], width = is64 ? 8 : 4, flag = is64 ? 1n << 63n : 1n << 31n;
    for (let index = 0; index < 65536; index++) {
      const offset = rva(address + index * width, width);
      const value = is64 ? u64(offset) : BigInt(u32(offset));
      if (value === 0n) return names;
      names.push(value & flag ? `ordinal:${Number(value & 0xffffn)}` : string(integer(value) + 2));
    }
    throw Error('Unterminated PE import thunk table');
  }
  function directory(index, delay) {
    if (directoryCount <= index) return;
    const entry = optional + directoryOffset + index * 8;
    const address = u32(entry), size = u32(entry + 4), width = delay ? 32 : 20;
    if (!address && !size) return;
    assert.ok(address && size >= width && size <= 4 * 1024 * 1024, 'Invalid PE import directory');
    for (let index = 0; (index + 1) * width <= size; index++) {
      const offset = rva(address + index * width, width);
      if (bytes.subarray(offset, offset + width).every(value => value === 0)) return;
      let name, table;
      if (delay) {
        const attributes = u32(offset);
        assert.ok(attributes === 0 || attributes === 1, 'Invalid delay-import attributes');
        const convert = value => attributes & 1 ? value : value - imageBase;
        name = convert(u32(offset + 4));
        table = convert(u32(offset + 16) || u32(offset + 12));
      } else {
        name = u32(offset + 12);
        table = u32(offset) || u32(offset + 16);
      }
      const dll = string(name);
      assert.match(dll, /^[a-zA-Z0-9_.-]+$/, 'Unsafe PE import DLL name');
      assert.ok(table > 0, 'Missing PE import thunk table');
      imports.push({ dll, functions: thunks(table), delay });
    }
    throw Error('Unterminated PE import descriptor table');
  }
  directory(1, false);
  directory(13, true);
  return { machine, format: is64 ? 'PE32+' : 'PE32',
    osVersion: [u16(optional + 40), u16(optional + 42)],
    subsystemVersion: [u16(optional + 48), u16(optional + 50)], imports };
}

function auditPe(bytes, { arch = 'x64' } = {}) {
  assert.equal(arch, 'x64', 'Win7 edition supports x64 only');
  const report = parsePe(bytes);
  assert.equal(report.machine, 0x8664, 'Win7 edition requires an x64 PE');
  assert.equal(report.format, 'PE32+', 'Win7 x64 requires the PE32+ optional header');
  const baseline = version => version[0] < 6 || version[0] === 6 && version[1] <= 1;
  assert.ok(baseline(report.subsystemVersion), 'PE minimum OS/subsystem exceeds Windows 7');
  if (!baseline(report.osVersion)) {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.ok(sha256 === sdk81D3dCompiler47 && report.osVersion[0] === 6 && report.osVersion[1] === 3
      && report.subsystemVersion[0] === 6 && report.subsystemVersion[1] === 0,
    'PE minimum OS/subsystem exceeds Windows 7');
    report.compatibilityNotes = [{ id: 'microsoft-sdk81-d3dcompiler47', sha256,
      scope: 'os-version-header-only', supportReference: sdkSupportReference }];
  }
  for (const { dll, functions } of report.imports) {
    const name = dll.toLowerCase();
    assert.ok(!incompatibleDlls.has(name) && !name.startsWith('api-ms-win-core-winrt-')
      && !name.startsWith('ext-ms-'), `Win7 incompatible DLL import: ${dll}`);
    for (const api of functions) assert.ok(!incompatibleApis.has(api), `Win7 incompatible API import: ${dll}!${api}`);
  }
  return report;
}

function auditDirectory(directory, options = {}) {
  const files = [], names = new Set();
  function visit(current, relative = '') {
    assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Win7 payload cannot contain symlinks');
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name), name = relative + entry.name;
      assert.ok(!entry.isSymbolicLink(), 'Win7 payload cannot contain symlinks');
      assert.ok(!names.has(name.toLowerCase()), 'Win7 payload has a Windows case collision');
      names.add(name.toLowerCase());
      if (entry.isDirectory()) visit(file, name + '/');
      else {
        assert.ok(entry.isFile(), 'Unsupported Win7 payload file type');
        if (/\.(exe|dll)$/i.test(name)) {
          try { files.push({ path: name, ...auditPe(fs.readFileSync(file), options) }); }
          catch (error) { throw Error(`${name}: ${error.message}`, { cause: error }); }
        }
      }
    }
  }
  visit(directory);
  assert.ok(files.length, 'Win7 payload contains no PE binaries');
  return { schemaVersion: 1, baseline: 'windows7-sp1-x64',
    scope: 'known-static-and-delay-imports', nativeWin7Verified: false, nativeLegacyVerified: false, files };
}

if (require.main === module) {
  try {
    const [directory, flag, output] = process.argv.slice(2);
    assert.ok(directory && (!flag || flag === '--output' && output),
      'Usage: windows7-pe.cjs DIRECTORY [--output REPORT.json]');
    const report = auditDirectory(directory);
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ baseline: report.baseline, files: report.files.length,
      nativeWin7Verified: false, ...(output ? { report: output } : {}) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parsePe, auditPe, auditDirectory };
