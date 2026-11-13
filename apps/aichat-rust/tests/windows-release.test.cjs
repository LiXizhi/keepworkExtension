const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { peMachine, verify } = require('../scripts/verify-windows-release.cjs');

const appRoot = path.resolve(__dirname, '..');

test('packaged self-update smoke has valid PowerShell syntax', {
  skip: process.platform !== 'win32',
}, () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
    $parseTokens = $null; $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($env:KEEPWORK_SMOKE_PARSE_FILE, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }
  `], {
    env: { ...process.env, KEEPWORK_SMOKE_PARSE_FILE: path.join(appRoot, 'scripts/windows-self-update-smoke.ps1') },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
const desktopVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const runtimeVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(appRoot, '../mcp-rust/crates/keepwork-mcp/Cargo.toml'), 'utf8'))[1];
const machines = { x64: 0x8664, arm64: 0xaa64 };
const commit = 'c'.repeat(40);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function executable(arch, marker = 0) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(machines[arch], 0x84);
  bytes[bytes.length - 1] = marker;
  return bytes;
}

function fixture(t, arch = 'x64', applicationName = 'Keepwork.exe') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-windows-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'payload');
  const runtimeDirectory = path.join(directory, 'resources/mcp-runtime', arch);
  const manifestFile = path.join(runtimeDirectory, 'runtime.json');
  const runtime = path.join(runtimeDirectory, 'bin/keepwork-mcp.exe');
  const application = path.join(directory, applicationName);
  const binary = path.join(root, 'keepwork-mcp.exe');
  const installer = path.join(root, `Keepwork_${desktopVersion}_${arch}-setup.exe`);
  const manifest = {
    schemaVersion: 2,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: 'keepwork-mcp-runtime',
    engine: 'rust',
    version: runtimeVersion,
    commit,
    platform: 'windows',
    arch,
    entry: 'bin/keepwork-mcp.exe',
    args: ['--port', '8089'],
    env: {},
    health: { url: 'http://127.0.0.1:8089/health', match: { name: 'keepwork-mcp' }, timeoutMs: 10000 },
  };
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(application, executable(arch, 1));
  fs.writeFileSync(runtime, executable(arch, 2));
  fs.writeFileSync(binary, executable(arch, 2));
  // NSIS uses a launcher architecture independent of its installed payload.
  fs.writeFileSync(installer, 'fixture installer bytes');
  return {
    root, application, runtime, runtimeDirectory, manifestFile, manifest,
    options: { directory, arch, commit, binary, installer },
    updateManifest(patch) {
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, ...patch }));
    },
  };
}

for (const arch of ['x64', 'arm64']) {
  for (const applicationName of ['Keepwork.exe', 'aichat-rust.exe']) {
    test(`verifies ${arch} ${applicationName} payload and records the actual runtime and installer hashes`, (t) => {
      const { options, runtime } = fixture(t, arch, applicationName);
      const result = verify(options);
      assert.equal(result.desktopVersion, desktopVersion);
      assert.equal(result.runtimeVersion, runtimeVersion);
      assert.equal(result.arch, arch);
      assert.equal(result.commit, commit);
      assert.equal(result.engine, 'rust');
      assert.equal(result.platform, 'windows');
      assert.equal(result.runtimeSha256, hash(fs.readFileSync(runtime)));
      assert.deepEqual(result.installer, {
        name: path.basename(options.installer),
        size: fs.statSync(options.installer).size,
        sha256: hash(fs.readFileSync(options.installer)),
      });
    });
  }
}

for (const nested of [false, true]) {
  test(`rejects current and legacy desktop executables together${nested ? ' in nested directories' : ''}`, (t) => {
    const f = fixture(t);
    const extra = path.join(f.options.directory, ...(nested ? ['legacy'] : []), 'aichat-rust.exe');
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.writeFileSync(extra, executable('x64', 3));
    assert.throws(() => verify(f.options), /exactly one desktop executable/);
  });
}

test('rejects duplicate current desktop executables instead of selecting the first path', (t) => {
  const f = fixture(t);
  const extra = path.join(f.options.directory, 'duplicate', 'Keepwork.exe');
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(extra, executable('x64', 3));
  assert.throws(() => verify(f.options), /exactly one desktop executable/);
});

test('rejects an unknown executable name instead of treating any PE as the desktop application', (t) => {
  const f = fixture(t);
  fs.renameSync(f.application, path.join(f.options.directory, 'other-application.exe'));
  assert.throws(() => verify(f.options), /exactly one desktop executable/);
});

test('rejects a stale runtime version even when the daemon binary matches the build output', (t) => {
  const f = fixture(t);
  f.updateManifest({ version: '0.0.0-stale' });
  assert.throws(() => verify(f.options), /runtime version/);
});

test('rejects a manifest from a different source commit', (t) => {
  const f = fixture(t);
  f.updateManifest({ commit: 'd'.repeat(40) });
  assert.throws(() => verify(f.options), /runtime commit/);
});

test('rejects abbreviated commit identities', (t) => {
  const f = fixture(t);
  assert.throws(() => verify({ ...f.options, commit: commit.slice(0, 10) }), /full source commit/);
});

for (const [key, value, message] of [
  ['args', ['--port', '18089'], /runtime arguments/],
  ['env', { KEEPWORK_MCP_REQUIRE_AUTH: '0' }, /runtime environment/],
  ['health', { url: 'http://0.0.0.0:8089/health', match: { name: 'keepwork-mcp' }, timeoutMs: 10000 }, /runtime health configuration/],
]) {
  test(`rejects changed runtime ${key} despite matching release identity`, (t) => {
    const f = fixture(t);
    f.updateManifest({ [key]: value });
    assert.throws(() => verify(f.options), message);
  });
}

for (const component of ['application', 'runtime']) {
  test(`rejects a mixed-architecture ${component} despite a matching runtime manifest`, (t) => {
    const f = fixture(t, 'arm64');
    fs.writeFileSync(f[component], executable('x64', 2));
    assert.throws(() => verify(f.options), /architecture mismatch/);
  });
}

test('rejects altered packaged daemon bytes with the correct architecture', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.runtime, executable('x64', 3));
  assert.equal(peMachine(f.runtime), machines.x64);
  assert.throws(() => verify(f.options), /differs from build output/);
});

test('rejects multiple bundled runtimes instead of accepting the first manifest', (t) => {
  const f = fixture(t);
  const extra = path.join(f.options.directory, 'resources/mcp-runtime/arm64/runtime.json');
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(extra, JSON.stringify({ ...f.manifest, arch: 'arm64' }));
  assert.throws(() => verify(f.options), /exactly one bundled runtime/);
});

test('rejects a legacy Node runtime advertised as the bundled payload', (t) => {
  const f = fixture(t);
  f.updateManifest({ product: 'keepwork-mcp-node-runtime', engine: 'node' });
  assert.throws(() => verify(f.options), /runtime product/);
});

test('rejects a package with no bundled runtime', (t) => {
  const f = fixture(t);
  fs.rmSync(f.runtimeDirectory, { recursive: true });
  assert.throws(() => verify(f.options), /exactly one bundled runtime/);
});

test('rejects invalid PE offsets before reading the architecture field', (t) => {
  const f = fixture(t);
  const bytes = executable('x64');
  bytes.writeUInt32LE(0xfffffff0, 0x3c);
  fs.writeFileSync(f.application, bytes);
  assert.throws(() => verify(f.options), /Invalid PE header/);
});
