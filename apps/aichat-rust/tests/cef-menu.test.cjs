const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '../windows/cef-host');

test('CEF native menu, theme and pet regressions run against production C++ state and geometry', { timeout: 120000 }, t => {
  const cmake = process.env.CMAKE || 'cmake';
  const available = spawnSync(cmake, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (available.error?.code === 'ENOENT') return t.skip('CMake is unavailable for portable native menu tests');
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stdout + available.stderr);
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-cef-menu-'));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  const run = args => {
    const result = spawnSync(cmake, args, { encoding: 'utf8', windowsHide: true, timeout: 55000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  run(['-S', sourceRoot, '-B', build, '-DKEEPWORK_POLICY_TESTS_ONLY=ON', '-DCMAKE_BUILD_TYPE=Debug']);
  run(['--build', build, '--config', 'Debug']);
  const output = run(['-E', 'chdir', build, 'ctest', '-C', 'Debug', '--output-on-failure']);
  assert.match(output, /Test\s+#\d+:\s+cef-menu-tracking\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-tray-lifecycle\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-chrome-theme\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-pet-geometry\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-popup-layout\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-pet-chat-state\s/);
  assert.match(output, /100% tests passed/);
});
