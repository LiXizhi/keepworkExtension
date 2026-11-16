const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { binaryFor, sourceFingerprint, readBuildInfo, validateBinary } = require('../scripts/bundle-mcp-rust.cjs');

const targets = [
  { arch: 'arm64', platform: 'macos', triple: 'aarch64-apple-darwin' },
  { arch: 'x64', platform: 'macos', triple: 'x86_64-apple-darwin' },
  { arch: 'x64', platform: 'windows', triple: 'x86_64-pc-windows-msvc' },
  { arch: 'arm64', platform: 'windows', triple: 'aarch64-pc-windows-msvc' },
];

function fixture(t, arch) {
  const rustRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-rust-target-'));
  t.after(() => fs.rmSync(rustRoot, { recursive: true, force: true }));
  const name = arch.platform === 'windows' ? 'keepwork-mcp.exe' : 'keepwork-mcp';
  const expected = path.join(rustRoot, 'target', arch.triple, 'release', name);
  const generic = path.join(rustRoot, 'target', 'release', name);
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  return { rustRoot, expected, generic, write };
}

test('importing the Rust bundler does not build Cargo or mutate staged resources', () => {
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const cp = require('node:child_process');
    cp.execFileSync = () => { throw new Error('import invoked a build command'); };
    for (const method of ['mkdirSync', 'rmSync', 'writeFileSync', 'copyFileSync', 'chmodSync']) {
      fs[method] = () => { throw new Error('import mutated staged resources: ' + method); };
    }
    assert.equal(typeof require(process.argv[1]).binaryFor, 'function');
  `;
  const result = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../scripts/bundle-mcp-rust.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const arch of targets) {
  test(`${arch.triple} selects its own artifact even when the generic binary is newer`, t => {
    const f = fixture(t, arch);
    f.write(f.expected, `target artifact: ${arch.triple}`);
    f.write(f.generic, 'newer artifact from another target');
    fs.utimesSync(f.expected, new Date('2020-01-01'), new Date('2020-01-01'));
    fs.utimesSync(f.generic, new Date('2030-01-01'), new Date('2030-01-01'));
    let builds = 0;
    assert.equal(binaryFor(arch, false, { rustRoot: f.rustRoot, buildTarget: () => builds++ }), f.expected);
    assert.equal(builds, 0, '--no-build must not trigger compilation');
    assert.equal(fs.readFileSync(f.expected, 'utf8'), `target artifact: ${arch.triple}`);
  });

  test(`${arch.triple} refuses a generic binary when its matching artifact is missing`, t => {
    const f = fixture(t, arch);
    f.write(f.generic, 'host binary cannot satisfy a different target');
    assert.throws(
      () => binaryFor(arch, false, { rustRoot: f.rustRoot }),
      error => error.message.includes(arch.triple) && /missing Rust daemon binary/.test(error.message),
    );
  });

  test(`${arch.triple} builds the requested target before locating its artifact`, t => {
    const f = fixture(t, arch);
    const builds = [];
    const result = binaryFor(arch, undefined, {
      rustRoot: f.rustRoot,
      buildTarget: requested => {
        builds.push(requested);
        f.write(f.expected, 'requested target was built');
      },
    });
    assert.deepEqual(builds, [arch]);
    assert.equal(result, f.expected);
  });
}

test('a requested target build failure is surfaced without falling back to a generic binary', t => {
  const arch = targets[0];
  const f = fixture(t, arch);
  f.write(f.expected, 'old target artifact');
  f.write(f.generic, 'generic artifact');
  const failure = new Error('Cargo target compilation failed');
  assert.throws(
    () => binaryFor(arch, true, { rustRoot: f.rustRoot, buildTarget: () => { throw failure; } }),
    error => error === failure,
  );
});

const expectedIdentity = {
  version: '0.99.0',
  commit: 'a'.repeat(40),
  sourceHash: 'b'.repeat(64),
};
const agentCapabilities = {
  agentSessionApi: 'v1',
  agentInventoryApi: 'v1',
  agentContextApi: 'v1',
  agentModeApi: 'v1',
};

function buildInfo(arch, overrides = {}) {
  return {
    marker: 'keepwork-mcp-build-v1',
    product: 'keepwork-mcp-runtime',
    engine: 'rust',
    ...expectedIdentity,
    target: arch.triple,
    capabilities: { ...agentCapabilities },
    endMarker: 'keepwork-mcp-build-end',
    ...overrides,
  };
}

function binaryBytes(info) {
  // Deliberately not executable on any target: cross-platform validation must
  // inspect the embedded record without running the binary or trusting its mtime.
  return Buffer.concat([
    Buffer.from([0, 255, 127, 69, 76, 70, 0]),
    Buffer.from(JSON.stringify(info)),
    Buffer.from([0, 254, 1, 0]),
  ]);
}

for (const arch of targets) {
  test(`${arch.triple} validates its embedded identity and agent capabilities without execution`, t => {
    const f = fixture(t, arch);
    const info = buildInfo(arch);
    f.write(f.expected, binaryBytes(info));
    assert.deepEqual(readBuildInfo(f.expected), info);
    assert.deepEqual(validateBinary(f.expected, arch, expectedIdentity), info);
  });
}

test('a legacy binary without an embedded record cannot be packaged as a new agent runtime', t => {
  const arch = targets[0];
  const f = fixture(t, arch);
  f.write(f.expected, 'old daemon binary with no native agent implementation');
  assert.throws(() => readBuildInfo(f.expected));
  assert.throws(() => validateBinary(f.expected, arch, expectedIdentity));
});

for (const [name, overrides] of [
  ['wrong product', { product: 'unrelated-runtime' }],
  ['wrong engine', { engine: 'node' }],
  ['old version', { version: '0.98.0' }],
  ['different source commit', { commit: 'c'.repeat(40) }],
  ['wrong target architecture', { target: targets[1].triple }],
  ['stale source at the same version and commit', { sourceHash: 'd'.repeat(64) }],
]) {
  test(`runtime validation rejects ${name}`, t => {
    const arch = targets[0];
    const f = fixture(t, arch);
    f.write(f.expected, binaryBytes(buildInfo(arch, overrides)));
    assert.throws(() => validateBinary(f.expected, arch, expectedIdentity));
  });
}

for (const capability of Object.keys(agentCapabilities)) {
  test(`runtime validation rejects a binary missing ${capability}`, t => {
    const arch = targets[0];
    const f = fixture(t, arch);
    const info = buildInfo(arch);
    delete info.capabilities[capability];
    f.write(f.expected, binaryBytes(info));
    assert.throws(() => validateBinary(f.expected, arch, expectedIdentity));
  });
}

test('runtime validation requires the supported capability contract rather than mere presence', t => {
  const arch = targets[0];
  const f = fixture(t, arch);
  f.write(f.expected, binaryBytes(buildInfo(arch, {
    capabilities: { ...agentCapabilities, agentSessionApi: 'v2' },
  })));
  assert.throws(() => validateBinary(f.expected, arch, expectedIdentity));
});

function writeRustSources(f) {
  f.write(path.join(f.rustRoot, 'Cargo.toml'), '[workspace]\nmembers = ["crates/keepwork-mcp"]\n');
  f.write(path.join(f.rustRoot, 'Cargo.lock'), 'version = 4\n');
  f.write(path.join(f.rustRoot, 'crates/keepwork-mcp/Cargo.toml'), `[package]\nname = "keepwork-mcp"\nversion = "${expectedIdentity.version}"\n`);
  f.write(path.join(f.rustRoot, 'crates/keepwork-mcp/build.rs'), 'fn main() {}\n');
  f.write(path.join(f.rustRoot, 'crates/keepwork-mcp/src/main.rs'), 'fn main() {}\n');
}

test('source fingerprints detect uncommitted Rust changes and ignore generated target output', t => {
  const f = fixture(t, targets[0]);
  writeRustSources(f);
  const original = sourceFingerprint(f.rustRoot);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(sourceFingerprint(f.rustRoot), original);
  f.write(f.expected, 'generated release output');
  assert.equal(sourceFingerprint(f.rustRoot), original);
  f.write(path.join(f.rustRoot, 'crates/keepwork-mcp/src/main.rs'), 'fn main() { println!("new agent code"); }\n');
  const modified = sourceFingerprint(f.rustRoot);
  assert.notEqual(modified, original, 'same-version local changes require a rebuilt binary');
  f.write(path.join(f.rustRoot, 'crates/keepwork-mcp/src/agents/new.rs'), 'pub fn new_protocol() {}\n');
  assert.notEqual(sourceFingerprint(f.rustRoot), modified, 'new untracked Rust modules must enter the fingerprint');
});

function treeBytes(directory) {
  const entries = {};
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative + '/');
      else entries[relative] = fs.readFileSync(path.join(dir, entry.name)).toString('base64');
    }
  }
  visit(directory);
  return entries;
}

test('a failed universal slice validation leaves every existing staged resource unchanged', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-rust-bundle-atomic-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fakeRepo = path.join(temporary, 'repo');
  const script = path.join(fakeRepo, 'apps/aichat-rust/scripts/bundle-mcp-rust.cjs');
  const fakeRustRoot = path.join(fakeRepo, 'apps/mcp-rust');
  const output = path.join(temporary, 'existing-resources');
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write(script, fs.readFileSync(path.resolve(__dirname, '../scripts/bundle-mcp-rust.cjs')));
  write(path.join(fakeRepo, 'scripts/lib/rust-runtime-identity.cjs'), fs.readFileSync(path.resolve(__dirname, '../../../scripts/lib/rust-runtime-identity.cjs')));
  writeRustSources({ rustRoot: fakeRustRoot, write });
  const sourceHash = sourceFingerprint(fakeRustRoot);
  for (const arch of targets.slice(0, 2)) {
    const binary = path.join(fakeRustRoot, 'target', arch.triple, 'release', 'keepwork-mcp');
    write(binary, arch.arch === 'arm64'
      ? binaryBytes(buildInfo(arch, { sourceHash }))
      : Buffer.from('old x64 daemon without a build identity'));
    write(path.join(output, arch.arch, 'runtime.json'), `existing ${arch.arch} manifest`);
    write(path.join(output, arch.arch, 'bin/keepwork-mcp'), `existing ${arch.arch} runtime`);
  }
  write(path.join(output, 'other-arch/bin/preserve-me'), 'existing resources must not be pruned on failure');
  const before = treeBytes(output);
  const preload = path.join(temporary, 'no-build.cjs');
  write(preload, [
    "require('node:child_process').execFileSync = (command) => {",
    `  if (command === 'git') return ${JSON.stringify(expectedIdentity.commit)};`,
    "  throw new Error('unexpected native execution during --no-build: ' + command);",
    '};',
  ].join(String.fromCharCode(10)));
  const result = spawnSync(process.execPath, [
    '--require', preload, script, '--no-build', '--target', 'universal-apple-darwin', '--outdir', output,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'a missing build identity must fail the bundle command');
  assert.match(result.stderr, /build.identity|build.info|embedded|marker/i, 'the invalid slice must reach identity validation');
  assert.deepEqual(treeBytes(output), before, result.stderr || result.stdout);
});
