const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packageWin7Runtime } = require('../apps/mcp-rust/scripts/package-win7-runtime.cjs');

function compiledIdentityFixture(info) {
  // Structurally valid x64 PE with a section and no imports, followed by the
  // same embedded identity format the Rust packager consumes. Never executed.
  const bytes = Buffer.alloc(0x400), coff = 0x84, optional = 0x98, section = 0x188;
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x8664, coff); bytes.writeUInt16LE(1, coff + 2);
  bytes.writeUInt16LE(0xf0, coff + 16); bytes.writeUInt16LE(0x22, coff + 18);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x1000, optional + 32); bytes.writeUInt32LE(0x200, optional + 36);
  for (const offset of [40, 48]) {
    bytes.writeUInt16LE(6, optional + offset); bytes.writeUInt16LE(1, optional + offset + 2);
  }
  bytes.writeUInt32LE(0x2000, optional + 56); bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt16LE(3, optional + 68); bytes.writeUInt32LE(16, optional + 108);
  bytes.write('.rdata', section, 'ascii');
  for (const [offset, value] of [[8, 0x200], [12, 0x1000], [16, 0x200], [20, 0x200], [36, 0x40000040]]) {
    bytes.writeUInt32LE(value, section + offset);
  }
  return Buffer.concat([bytes, Buffer.from(JSON.stringify(info))]);
}

test('Win7 Rust package manifests pass the actual launcher C++ policy without a legacy adapter', t => {
  const checker = process.env.KEEPWORK_WIN7_POLICY_TEST_BIN;
  if (!checker) return t.skip('Set KEEPWORK_WIN7_POLICY_TEST_BIN to the compiled portable policy test.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = {
    marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust',
    variant: 'win7-win8', minWindows: [6, 1, 7601], target: 'x86_64-win7-windows-msvc',
    version: '0.2.61', commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64),
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' },
    endMarker: 'keepwork-mcp-build-end',
  };
  const binary = path.join(root, 'keepwork-mcp.exe');
  fs.writeFileSync(binary, compiledIdentityFixture(info));
  const packaged = packageWin7Runtime({ binary, output: path.join(root, 'release'), expected: info });
  const manifestPath = path.join(root, 'candidate.json');
  const check = value => {
    fs.writeFileSync(manifestPath, JSON.stringify(value));
    const result = spawnSync(checker, [manifestPath], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  };
  const accepted = check(packaged.manifest);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(accepted.stdout.trim(), info.version);
  assert.ok(fs.statSync(packaged.archive).size > 0);
  for (const change of [
    value => { value.variant = 'modern'; },
    value => { value.buildTarget = 'x86_64-pc-windows-msvc'; },
    value => { value.platform = 'macos'; },
    value => { value.terminalApi = 'pty-session-v1'; },
    value => { value.url = value.url.replace('mcp-win7-win8-rs', 'mcp-stable-rs'); },
    value => { value.files[0].size += 1; },
  ]) {
    const candidate = structuredClone(packaged.manifest); change(candidate);
    assert.notEqual(check(candidate).status, 0);
  }
});
