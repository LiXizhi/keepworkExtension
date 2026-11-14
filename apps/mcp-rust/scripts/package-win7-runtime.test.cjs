const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageWin7Runtime, BASE } = require('./package-win7-runtime.cjs');
const { readRuntimeArchive } = require('../../../scripts/lib/runtime-archive.cjs');
const { buildEnvironment, buildCommand, config } = require('./build-win7.cjs');

// Section-backed PE fixture, not an executable. Real target compilation and
// native Windows 7/8 acceptance are separate gates from this packaging contract.
function fixture(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-win7-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = { marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust',
    version: '0.3.0', commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), target: config.target,
    variant: 'win7-win8', minWindows: [6, 1, 7601],
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' },
    ...patch, endMarker: 'keepwork-mcp-build-end' };
  const bytes = Buffer.alloc(0x1200), header = 0x80, optional = header + 24, section = optional + 0xf0;
  bytes.write('MZ'); bytes.writeUInt32LE(header, 0x3c); bytes.write('PE\0\0', header);
  bytes.writeUInt16LE(0x8664, header + 4); bytes.writeUInt16LE(1, header + 6);
  bytes.writeUInt16LE(0xf0, header + 20); bytes.writeUInt16LE(0x20b, optional);
  bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt16LE(6, optional + 40); bytes.writeUInt16LE(1, optional + 42);
  bytes.writeUInt16LE(6, optional + 48); bytes.writeUInt16LE(1, optional + 50);
  bytes.writeUInt32LE(0x200, optional + 60); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  bytes.write(JSON.stringify(info), 0x200, 'utf8');
  const binary = path.join(root, 'daemon 中文.exe');
  fs.writeFileSync(binary, bytes);
  return { root, binary, bytes, info, output: path.join(root, 'output') };
}

test('Windows 7/8 archive has independent channel, compiled variant, complete file digests and no native PTY claim', t => {
  const f = fixture(t);
  const result = packageWin7Runtime({ ...f, expected: f.info });
  const archive = fs.readFileSync(result.archive), files = readRuntimeArchive(archive);
  assert.equal(BASE, 'https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs');
  assert.equal(result.manifest.url, `${BASE}/0.3.0/windows-x64.zip`);
  assert.equal(result.manifest.size, archive.length);
  assert.equal(result.manifest.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual([...files.keys()].filter(name => !name.endsWith('/')).sort(), ['LICENSE', 'bin/keepwork-mcp.exe', 'runtime.json']);
  const runtime = JSON.parse(files.get('runtime.json'));
  for (const key of ['version', 'variant', 'minWindows', 'buildTarget', 'commit', 'sourceHash', 'platform', 'arch']) {
    assert.deepEqual(runtime[key], result.manifest[key], key);
  }
  assert.equal(runtime.variant, 'win7-win8');
  assert.equal(runtime.health.match.runtimeVariant, 'win7-win8');
  assert.equal(runtime.terminalApi, undefined);
  assert.equal(result.manifest.unpackedSize, result.manifest.files.reduce((sum, file) => sum + file.size, 0));
  for (const file of result.manifest.files) {
    assert.equal(file.size, files.get(file.path).length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(files.get(file.path)).digest('hex'));
  }
  assert.throws(() => packageWin7Runtime({ ...f, expected: f.info }), /must be new/);
});

for (const [label, patch] of [
  ['modern target', { target: 'x86_64-pc-windows-msvc' }],
  ['obsolete single-system variant', { variant: 'win7' }],
  ['missing legacy identity', { variant: undefined }],
  ['wrong baseline', { minWindows: [10, 0, 19045] }],
]) {
  test(`Windows 7/8 packager rejects ${label} before producing output`, t => {
    const f = fixture(t, patch);
    assert.throws(() => packageWin7Runtime({ ...f, expected: f.info }));
    assert.equal(fs.existsSync(f.output), false);
  });
}

test('Windows 7/8 packaging audits the actual PE baseline independently of embedded claims', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.binary);
  bytes.writeUInt16LE(10, 0x80 + 24 + 48);
  fs.writeFileSync(f.binary, bytes);
  assert.throws(() => packageWin7Runtime({ ...f, expected: f.info }), /exceeds Windows 7/);
  assert.equal(fs.existsSync(f.output), false);
});

test('build command pins a real Win7 standard library and static CRT while preserving caller SDK flags', () => {
  const command = buildCommand();
  assert.equal(command[0], '+' + config.toolchain);
  assert.ok(command.includes(config.target));
  assert.ok(command.includes('build-std=std,panic_abort'));
  const original = { RUSTFLAGS: '-L native=C:/sdk/lib', PATH: 'test-path' };
  const built = buildEnvironment(original);
  assert.equal(original.CARGO_ENCODED_RUSTFLAGS, undefined);
  assert.deepEqual(built.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), [
    '-L', 'native=C:/sdk/lib', '-C', 'target-feature=+crt-static', '-C', 'link-arg=/SUBSYSTEM:CONSOLE,6.01',
  ]);
  assert.equal(built.PATH, original.PATH);
});
