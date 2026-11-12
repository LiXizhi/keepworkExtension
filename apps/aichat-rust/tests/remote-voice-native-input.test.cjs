const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

test('macOS voice input requires a known window, control and valid caret snapshot', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-voice-input-'));
  try {
    const executable = path.join(temporary, 'native-input');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/remote_voice_native_input_macos.m'),
      '-o', executable], { timeout: 15000 });
    assert.equal(compiled.stderr, '', 'fake Accessibility fixture compiles without warnings');
    const result = await execute(executable, [], { timeout: 5000 });
    assert.match(result.stdout, /native voice input focus snapshots passed/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
