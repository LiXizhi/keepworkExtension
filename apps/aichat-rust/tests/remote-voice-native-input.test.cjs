const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

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
  assert.doesNotMatch(mac, /AXSelectedTextRange|keepwork_voice_input_target/);
  assert.doesNotMatch(mac.split('// Clear alone')[0], /AXUIElementCopyAttributeValue/);
  assert.match(mac, /AXUIElementIsAttributeSettable/);
  assert.match(mac, /kAXSecureTextFieldSubrole/);
  assert.doesNotMatch(mac, /activateWithOptions|activateIgnoringOtherApps|makeKeyAndOrderFront|CGEventPostToPid/);
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
