'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { auditPe, parsePe } = require('../../../scripts/lib/windows7-pe.cjs');
const remoteVoice = Object.freeze({ version: 1, entry: 'keepwork-remote-voice.exe', minWindows: [10, 0, 15063] });
function validateRemoteVoice(value) {
  assert.deepEqual(value, remoteVoice, 'Unsupported native remote voice component contract');
  return value;
}
// Audit all required legacy binaries exactly as before. The single native
// companion is a separately declared optional Windows 10 component; its PE is
// inspected and hashed, and never reported as Win7 loader-compatible.
function auditLegacyCef(directory) {
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'CEF payload cannot be linked');
  const hostFile = path.join(directory, 'cef-host.json');
  assert.ok(!fs.lstatSync(hostFile).isSymbolicLink(), 'CEF metadata cannot be linked');
  const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  assert.ok(host.cefMajor === 109 && host.arch === 'x64' && host.sandbox === 'cef_sandbox', 'Require the legacy CEF109 x64 host');
  if (host.remoteVoice !== undefined) validateRemoteVoice(host.remoteVoice);
  const files = [], optionalComponents = [], names = new Set();
  function visit(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, file = path.join(current, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'CEF payload cannot contain symlinks');
      assert.ok(!names.has(name.toLowerCase()), 'CEF payload has a Windows case collision'); names.add(name.toLowerCase());
      if (entry.isDirectory()) visit(file, name + '/');
      else {
        assert.ok(entry.isFile(), 'Unsupported CEF payload file type');
        if (!/\.(exe|dll)$/i.test(name)) continue;
        const bytes = fs.readFileSync(file);
        if (name === remoteVoice.entry && host.remoteVoice !== undefined) {
          const report = parsePe(bytes);
          assert.equal(report.machine, 0x8664, 'Native remote voice architecture mismatch');
          assert.equal(report.format, 'PE32+');
          optionalComponents.push({ path: name, minWindows: remoteVoice.minWindows, scope: 'optional-windows10-component',
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'), nativeWindows10Verified: false, ...report });
        } else files.push({ path: name, ...auditPe(bytes) });
      }
    }
  }
  visit(directory);
  assert.ok(files.length > 0, 'CEF payload contains no required PE binaries');
  if (host.remoteVoice !== undefined) assert.equal(optionalComponents.length, 1, 'Missing native remote voice component');
  return { schemaVersion: 1, baseline: 'windows7-sp1-x64', scope: 'required-legacy-binaries-static-and-delay-imports',
    nativeWin7Verified: false, nativeLegacyVerified: false, files, optionalComponents };
}
if (require.main === module) {
  try { console.log(JSON.stringify(auditLegacyCef(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { remoteVoice, validateRemoteVoice, auditLegacyCef };
