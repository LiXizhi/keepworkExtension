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
  const header = fs.readFileSync(path.join(build, 'compatibility_script.h'), 'utf8');
  const literals = [...header.matchAll(/R"([A-Za-z0-9_]*)\(([\s\S]*?)\)\1"/g)];
  assert.ok(literals.length > 1, 'the combined script must not be one oversized MSVC raw literal');
  for (const [, delimiter, text] of literals)
    assert.ok(Buffer.byteLength(text) < 16380, `${delimiter} exceeds the MSVC raw literal byte limit`);
  run(['--build', build, '--config', 'Debug']);
  const output = run(['-E', 'chdir', build, 'ctest', '-C', 'Debug', '--output-on-failure']);
  assert.match(output, /Test\s+#\d+:\s+cef-menu-tracking\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-tray-lifecycle\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-chrome-theme\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-pet-geometry\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-popup-layout\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-pet-chat-state\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-pet-input-policy\s/);
  assert.match(output, /Test\s+#\d+:\s+cef-embedded-script\s/);
  // C++ translation normalizes physical source newlines, including Windows
  // checkouts. Preserve the existing runtime bytes rather than checkout CRLF.
  const sourceText = file => fs.readFileSync(path.join(sourceRoot, file), 'utf8').replace(/\r\n?/g, '\n');
  const expected = '(() => {\n  ' + sourceText('onboarding_colors.js')
    + sourceText('menu_icons.js')
    + '\n  const nativePopover = \'popover\' in HTMLElement.prototype && typeof HTMLElement.prototype.showPopover === \'function\';\n  '
    + sourceText('vendor/popover.iife.min.js')
    + '\n  if (!nativePopover) {\n    '
    + sourceText('session_popovers.js') + '\n  }\n})()';
  assert.deepEqual(fs.readFileSync(path.join(build, 'compiled-compatibility-script.js')), Buffer.from(expected),
    'the actual C++ compiler must concatenate the wrapper and all configured JavaScript sources without changing bytes');
  const cmakeSource = fs.readFileSync(path.join(sourceRoot, 'CMakeLists.txt'), 'utf8');
  for (const target of ['cef-window-adapter-test', 'cef-pet-chat-panel-test'])
    assert.ok(cmakeSource.includes(`target_link_options(${target} PRIVATE /MANIFEST:NO)`),
      `${target} must use its explicit RT_MANIFEST instead of also generating another manifest`);
  assert.match(output, /100% tests passed/);
});
