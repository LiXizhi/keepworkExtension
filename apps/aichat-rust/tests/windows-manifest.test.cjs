const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Windows manifest flags cover test harnesses and activate native Common Controls v6', { timeout: 60000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork manifest '));
  const fixture = path.resolve(__dirname, 'fixtures/windows_manifest.rs');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    const manifest = path.join(directory, 'windows-app-manifest.xml');
    fs.copyFileSync(path.resolve(__dirname, '../src-tauri/windows-app-manifest.xml'), manifest);
    const probe = path.join(directory, 'linker-args' + suffix);
    const executable = path.join(directory, 'manifest-tests' + suffix);
    run(process.env.RUSTC || 'rustc', ['--edition=2021', fixture, '-o', probe]);
    const args = run(probe, [manifest]).trim().split(/\r?\n/).filter(Boolean);
    if (!args.length) t.diagnostic('Native Common Controls loading requires Windows MSVC; target selection is checked on this host.');
    run(process.env.RUSTC || 'rustc', [
      '--edition=2021', '--test', fixture, '-o', executable,
      ...args.flatMap(arg => ['-C', `link-arg=${arg}`]),
    ]);
    run(executable, ['--nocapture']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
