const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// This isolated integration test temporarily makes its fixture app foreground and switches Spaces.
// Run separately from the ordinary concurrent GUI fixtures so they cannot steal its focus.
test('Home pet overlay over another macOS app in zoomed and native full-screen modes', {
  skip: process.platform !== 'darwin' || process.env.AICHAT_TEST_MACOS_HOME_OVERLAY !== '1',
  timeout: 90_000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-home-overlay-'));
  try {
    const executables = await require('./fixtures/appkit-pair.cjs')(dir, 'home-overlay');
    await run('clang', [
      '-fobjc-arc', '-Werror', '-Wall', '-framework', 'Cocoa', '-framework', 'CoreGraphics', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/pet_home_overlay_macos.m'),
      path.join(__dirname, '../src-tauri/src/app/pet_overlay_macos.m'), '-o', executables[0],
    ]);
    await fs.copyFile(executables[0], executables[1]);
    for (const mode of ['zoom', 'fullscreen']) {
      await t.test(mode, async subtest => {
        const directory = path.join(dir, mode);
        await fs.mkdir(directory);
        try {
          const result = await run(executables[0], [executables[1], mode, directory], { timeout: 32_000 });
          assert.match(result.stdout, new RegExp(`passed ${mode}: foreground retained`));
          subtest.diagnostic(result.stdout.trim());
        } catch (error) {
          if (error.code !== 77) throw error;
          subtest.skip(error.stderr.trim() || 'WindowServer did not permit foreground verification.');
        }
      });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
