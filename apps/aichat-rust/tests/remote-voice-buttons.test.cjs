const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const appRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(appRoot, relative), 'utf8');

test('begin-input is an explicit local settings action without a remote keyboard command', () => {
  const main = JSON.parse(read('src-tauri/capabilities/default.json'));
  const settings = JSON.parse(read('src-tauri/capabilities/remote-voice.json'));
  assert.deepEqual(main.windows, ['main', 'pet', 'updates']);
  assert.equal(main.permissions.includes('allow-remote-voice-settings'), false);
  assert.deepEqual(settings.windows, ['remote-voice']);
  assert.equal(settings.local, true);
  assert.equal(Object.hasOwn(settings, 'remote'), false);
  const permissions = read('src-tauri/permissions/desktop-commands.toml').split('[[permission]]');
  const legacy = permissions.find(part => part.includes('identifier = "allow-desktop-commands"'));
  const local = permissions.find(part => part.includes('identifier = "allow-remote-voice-settings"'));
  assert.ok(local.includes('"remote_voice_begin_input"'));
  assert.equal(legacy.includes('remote_voice_begin_input'), false);
  const host = read('src-tauri/src/app/remote_voice_host.rs');
  const begin = host.slice(host.indexOf('fn remote_voice_begin_input(')).split('#[cfg(test)]')[0];
  assert.match(begin, /verify\(&window\)\?/);
  assert.match(begin, /show_main_window/);
  assert.match(begin, /window\.hide\(\)/);
  assert.doesNotMatch(begin, /SendInput|CGEventPost|\.submit\(|\.clear\(|\.deliver\(/);
  const bridge = read('src/bridge.ts') + read('src-tauri/src/bridge.rs');
  assert.doesNotMatch(bridge, /remote_voice_begin_input/);
});

test('Home and Back/Menu are independent device-scoped controls and the HID reader never synthesizes Enter', () => {
  const source = read('src-tauri/src/remote_voice/buttons.rs');
  const mac = read('src-tauri/src/remote_voice/buttons_macos.m');
  const windows = read('src-tauri/src/remote_voice/home_windows.rs');
  const startup = read('src-tauri/src/app/startup.rs');
  const host = read('src-tauri/src/app/remote_voice_host.rs');
  assert.doesNotMatch(source + mac + windows, /CGEventPost|SendInput|SetWindowsHookEx|WH_KEYBOARD_LL/);
  assert.match(source, /keepwork_remote_home_poll/);
  assert.match(source, /keepwork_remote_buttons_poll/);
  assert.match(source, /pub fn poll_home\(listener: &Listener\) -> bool\s*\{\s*listener\.poll\(\)/);
  assert.match(source, /pub fn poll_clear\(listener: &Listener\) -> bool\s*\{\s*listener\.poll_clear\(\)/);
  assert.match(windows, /attrs\.VendorID == 0x2717[\s\S]*?attrs\.ProductID == 0x32b8/);
  assert.match(windows, /VK_APPS\s*=>\s*\(RemoteButton::Clear/);
  assert.match(startup, /#\[cfg\(any\(target_os = "macos", windows\)\)\]\s*\{\s*let voice = back_app[\s\S]*?clear_main_composer/);
  assert.match(host, /#\[cfg\(any\(target_os = "macos", windows\)\)\]\r?\npub\(super\) fn clear_main_composer/);
  const fallback = source.slice(source.indexOf('#[cfg(not(any(target_os = "macos", windows)))]'));
  assert.match(fallback, /pub fn poll_clear\(_:\s*&Listener\) -> bool\s*\{\s*false\s*\}/);
  const input = read('src-tauri/src/remote_voice/native_input.rs');
  assert.match(input, /home_windows::take_key_keyup_suppression\(vk\)/);
  assert.match(input, /home_windows::should_suppress_key_keydown\(vk\)/);
  assert.ok(source.includes('清除提示词'));
  assert.ok(input.includes('is_command(text, "清除提示词")'));
  assert.doesNotMatch(source, /可说“清空输入”/);
});

test('clearing drops the owned ASR future before mutating the current input', () => {
  const ble = read('src-tauri/src/remote_voice/ble.rs').split('#[cfg(test)]')[0];
  const cancel = ble.slice(ble.indexOf('fn cancel_utterance('), ble.indexOf('async fn write('));
  assert.match(cancel, /\*recognition\s*=\s*None/);
  assert.match(cancel, /ptt\.cancel_current\(\)/);
  assert.doesNotMatch(ble, /tokio::spawn|tauri::async_runtime::spawn/);
  const clearSites = [...ble.matchAll(/if service\.poll_clear\(generation\)\s*\{([\s\S]*?)\n\s*\}/g)];
  assert.ok(clearSites.length >= 2, 'clear must win both while waiting and immediately before final delivery');
  for (const [, body] of clearSites) {
    const revoke = body.indexOf('cancel_utterance(');
    const mutate = body.indexOf('service.clear(');
    assert.ok(revoke >= 0 && mutate > revoke, 'invalidate the utterance before clearing');
  }
});

test('macOS button classifier isolates device identity and short-release deduplication without a native listener', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-remote-buttons-'));
  try {
    const executable = path.join(temporary, 'buttons');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'Foundation',
      '-framework', 'IOKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/remote_voice_buttons_macos.m'), '-o', executable], { timeout: 15000 });
    assert.equal(compiled.stderr, '');
    const result = await execute(executable, [], { timeout: 5000 });
    assert.match(result.stdout, /device-scoped remote button fixtures passed/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('physical Record distinguishes completed double taps, held dictation and dialogue controls', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-remote-record-'));
  try {
    const executable = path.join(temporary, process.platform === 'win32' ? 'gestures.exe' : 'gestures');
    await execute('rustc', ['--test', '--edition=2021',
      path.join(__dirname, 'fixtures/remote_voice_record_gestures.rs'), '-o', executable], { timeout: 20000 });
    await execute(executable, [], { timeout: 5000 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
