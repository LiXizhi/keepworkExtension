const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('macOS resource copies isolate live executable inodes and restore failed builds', {
  skip: process.platform === 'win32' ? 'The resource copy guard uses Unix inode semantics.' : false,
  timeout: 60000,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-resource-copy-test-'));
  try {
    const childExecutable = path.join(directory, 'resource-copy-child');
    if (process.platform === 'darwin') {
      const childCompiled = spawnSync(process.env.RUSTC || 'rustc', [
        '--edition=2021', path.resolve(__dirname, 'fixtures/macos_resource_child.rs'),
        '-o', childExecutable,
      ], { encoding: 'utf8', timeout: 30000 });
      assert.ifError(childCompiled.error);
      assert.equal(childCompiled.status, 0, childCompiled.stdout + childCompiled.stderr);
    }
    const executable = path.join(directory, 'resource-copy-tests');
    const compiled = spawnSync(process.env.RUSTC || 'rustc', [
      '--edition=2021', '--test',
      path.resolve(__dirname, 'fixtures/macos_resource_copy.rs'),
      '-o', executable,
    ], { encoding: 'utf8', timeout: 45000 });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(executable, ['--nocapture'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, KEEPWORK_RESOURCE_TEST_CHILD: childExecutable },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
