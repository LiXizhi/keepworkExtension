const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { binaryFor } = require('../scripts/bundle-mcp-rust.cjs');

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
