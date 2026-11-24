const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

test('macOS live HID media keys produce diagram edges and leave system volume and mute untouched during demo', {
  skip: process.platform !== 'darwin' || process.env.AICHAT_TEST_MACOS_REMOTE_DEMO_MEDIA !== '1',
  timeout: 65000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-demo-media-'));
  const executable = path.join(directory, 'media');
  try {
    await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'Cocoa', '-framework', 'Carbon',
      '-framework', 'ApplicationServices', '-framework', 'CoreAudio',
      path.join(__dirname, 'fixtures/remote_voice_demo_media_macos.m'), '-o', executable], { timeout: 15000 });
    const { stdout } = await execute(executable, ['snapshot'], { timeout: 5000 });
    const state = stdout.trim().split(/\s+/);
    assert.equal(state.length, 3, 'device ID, original volume and mute are required');
    try {
      const result = await execute(executable, ['test', state[0]], { timeout: 30000 });
      t.diagnostic(result.stdout.trim());
      assert.match(result.stdout, /Live system volume, mute, diagram edges and HID interception passed/);
    } finally {
      // Restore from the parent even if the foreground fixture crashes or times out.
      await execute(executable, ['restore', ...state], { timeout: 5000 });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AppKit blocks remote-demo menu shortcuts and session input only during focused capture', {
  skip: process.platform !== 'darwin' || process.env.AICHAT_TEST_MACOS_REMOTE_DEMO !== '1',
  timeout: 30000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-remote-demo-'));
  try {
    const executable = path.join(directory, 'demo');
    await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'Cocoa',
      '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/remote_voice_demo_macos.m'),
      '-o', executable], { timeout: 15000 });
    const result = await execute(executable, [], { timeout: 7000 });
    assert.match(result.stdout, /AppKit demo shortcut fixture passed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('macOS voice input pastes at current focus and explicitly submits once using isolated OS boundaries', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-voice-input-'));
  try {
    const executable = path.join(temporary, 'native-input');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/remote_voice_native_input_macos.m'),
      '-o', executable], { timeout: 15000 });
    assert.equal(compiled.stderr, '', 'isolated clipboard/event fixture compiles without warnings');
    const result = await execute(executable, [], { timeout: 5000 });
    assert.match(result.stdout, /native current-focus paste and explicit Return passed with isolated clipboard and event hook/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('native delivery uses current focus and only an explicit final voice command may submit', () => {
  const root = path.resolve(__dirname, '..');
  const native = fs.readFileSync(path.join(root, 'src-tauri/src/remote_voice/native_input.rs'), 'utf8');
  const mac = fs.readFileSync(path.join(root, 'src-tauri/src/remote_voice/native_input_macos.m'), 'utf8');
  const production = native.split('#[cfg(test)]')[0];
  assert.doesNotMatch(production, /pub struct Target|may_paste|pub fn target|Delivery::Copied/);
  assert.doesNotMatch(mac, /keepwork_voice_input_target/);
  for (const operation of ['copy', 'paste', 'submit']) {
    const body = mac.split('bool keepwork_voice_input_' + operation + '(')[1].split('\n}')[0];
    assert.doesNotMatch(body, /AXUIElement|AXSelectedTextRange|copyFocusedInput|clear_back|CGEventPostToPid/);
  }
  assert.match(mac, /AXUIElementIsAttributeSettable/);
  assert.match(mac, /kAXSecureTextFieldSubrole/);
  assert.doesNotMatch(mac, /activateWithOptions|activateIgnoringOtherApps|makeKeyAndOrderFront/);
  assert.match(production, /deliver_current\(&self\.enabled, &self\.platform, text\)/);
  assert.match(production, /Delivery::ModifiersHeld/);
  assert.match(production, /Delivery::Submitted/);
  assert.match(production, /if complete && is_submit_command\(text\)/, 'only complete dictation may execute the submit command');
  assert.match(production, /backend\.submit\(\)\?/);
  assert.match(mac, /keepwork_voice_input_submit\(void\)[\s\S]*?postKeyboardPair\(36, 0\)/);
  const main = fs.readFileSync(path.join(root, 'src-tauri/src/remote_voice.rs'), 'utf8');
  const ble = fs.readFileSync(path.join(root, 'src-tauri/src/remote_voice/ble.rs'), 'utf8');
  assert.doesNotMatch(main + ble, /Option<Target>|native\.target\(|Delivery::Copied/);
  const html = fs.readFileSync(path.join(root, 'remote-voice.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/remote-voice.ts'), 'utf8');
  assert.doesNotMatch(html + renderer, /光标或前台应用已变化|请手动粘贴|切换前台目标/);
  assert.match(main, /Delivery::Submitted/);
  assert.match(renderer, /submitted/);
  assert.match(html, /发送提示词/);
  assert.match(html, /口令文字不会填入，也不改动剪贴板/);
  assert.match(html, /普通口述[^。]*不会自动按回车/);
});

test('macOS remote voice outline tracks editable field bounds and preserves focus', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-voice-outline-'));
  try {
    const executable = path.join(temporary, 'outline');
    await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/remote_voice_highlight_macos.m'),
      '-o', executable], { timeout: 15000 });
    const result = await execute(executable, [], { timeout: 8000 });
    if (result.stdout.includes('headless:')) return t.skip(result.stdout.trim());
    assert.match(result.stdout, /AppKit current-field outline passed/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Home navigation cannot insert its function glyph into desktop text fields', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/app/home_text_guard.js'), 'utf8');
  const window = new EventTarget();
  vm.runInNewContext(source, { window });
  const emit = (type, properties = {}) =>
    window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties));
  const insert = (data, inputType = 'insertText', isComposing = false) =>
    emit('beforeinput', { data, inputType, isComposing });
  for (const navigation of [{ key: 'Home' }, { key: 'Unidentified', code: 'Home' }, { key: '\uF729' }]) {
    assert.equal(emit('keydown', navigation), true);
    assert.equal(insert('\uF729'), false);
    assert.equal(insert('普通内容'), true);
    assert.equal(insert('\uF729', 'insertFromPaste'), true);
    assert.equal(insert('\uF729', 'insertText', true), true);
    emit('keyup', navigation);
    assert.equal(insert('\uF729'), true);
  }
  emit('keydown', { key: 'Home' });
  emit('blur');
  assert.equal(insert('\uF729'), true);
});

test('physical Back resolves the pet before invoking a single native clear', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/remote_voice.rs'), 'utf8');
  const body = source.split('    fn clear(&self, generation: u64)')[1].split('    fn input_result')[0];
  const pet = body.indexOf('self.back_route.get()');
  const native = body.indexOf('native.clear_back()');
  assert.ok(pet >= 0 && native > pet);
  assert.equal(body.match(/native\.clear_back\(/g).length, 1);
  const route = body.slice(pet, native);
  assert.match(route, /Ok\(BackRoute::Pet\)\s*=>\s*\{[^}]*return;/);
  assert.match(route, /Ok\(BackRoute::MainComposer\)\s*=>\s*\{[^}]*"cleared"[^}]*return;/);
  assert.match(route, /Err\(error\)\s*=>\s*\{[^}]*return;/);
  assert.match(route, /Ok\(BackRoute::Native\)\s*=>\s*\{\s*\}/);
});

test('physical Back clears a disposable external AppKit, WebKit or Chromium editor with the pet hidden', {
  skip: process.platform !== 'darwin' || process.env.AICHAT_TEST_MACOS_REMOTE_BACK !== '1',
  timeout: 150_000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-remote-back-'));
  try {
    const [host, editor] = await require('./fixtures/appkit-pair.cjs')(dir, 'remote-back');
    await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'Cocoa', '-framework', 'WebKit',
      '-framework', 'ApplicationServices', '-framework', 'IOKit', path.join(__dirname, 'fixtures/remote_back_editor_macos.m'), '-o', host]);
    fs.copyFileSync(host, editor);
    for (const mode of ['native', 'web', 'web-main']) {
      await t.test(mode, async subtest => {
        const scratch = path.join(dir, mode);
        fs.mkdirSync(scratch);
        try {
          const result = await execute(host, [editor, mode, scratch], { timeout: 25_000, env: { ...process.env,
            AICHAT_BACK_MAIN_FIXTURE: path.join(__dirname, 'fixtures/remote_back_main_webview.html'),
            AICHAT_BACK_MAIN_SCRIPT: path.join(__dirname, '../src-tauri/src/app/remote_voice_clear_composer.js'),
          } });
          if (result.stderr.trim()) subtest.diagnostic(result.stderr.trim());
          assert.match(result.stdout, /passed external .* active field clear/);
        } catch (error) {
          if (error.code !== 77) throw error;
          subtest.skip(error.stderr.trim() || 'Foreground fixture unavailable');
        }
      });
    }
    const electron = path.resolve(__dirname, '../../aichat-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    for (const [runtime, binary] of [['Chrome', '/Applications/Google Chrome.app'], ['Electron', electron], ['Electron cold', electron],
      ['Electron paste then Back', electron], ['Electron paste then Back, AX wrapper', electron],
      ['Electron paste then Back, in flight', electron]]) {
      await t.test(runtime + ' contenteditable', { skip: !fs.existsSync(binary) }, async subtest => {
        try {
          const directory = path.join(dir, runtime);
          fs.mkdirSync(directory);
          await require('./fixtures/remote-back-chrome.cjs')(host, message => subtest.diagnostic(message),
            runtime.startsWith('Electron') ? { executablePath: electron, directory, cold: runtime === 'Electron cold',
              paste: runtime.includes('paste then Back'), wrapper: runtime.includes('AX wrapper'), immediate: runtime.includes('in flight') } : undefined);
        } catch (error) {
          if (error.code !== 77) throw error;
          subtest.skip('Accessibility permission unavailable');
        }
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
