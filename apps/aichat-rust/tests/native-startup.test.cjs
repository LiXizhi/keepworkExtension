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

test('startup attaches native controls to main without a second window or remote IPC permission', () => {
  const native = read('src-tauri/src/app/native_startup.rs');
  assert.match(native, /get_window\("main"\)/);
  assert.doesNotMatch(native, /WindowBuilder|WebviewWindowBuilder|WebviewUrl|\.initialization_script\(|\.navigate\(|\.eval\(/);
  assert.match(native, /CreateWindowExW/);
  assert.match(native, /gtk::Spinner::new/);
  const mac = read('src-tauri/src/app/native_startup_macos.m');
  assert.match(mac, /NSProgressIndicator/);
  assert.match(mac, /NSTextField/);
  assert.match(mac, /NSButton/);
  const capabilities = fs.readdirSync(path.join(appRoot, 'src-tauri/capabilities'));
  for (const file of capabilities.filter(name => name.endsWith('.json'))) {
    const capability = JSON.parse(read(`src-tauri/capabilities/${file}`));
    assert.equal(capability.windows?.includes('startup'), false, `${file} must not grant bridge permissions to the native window`);
  }
});

test('one main window loads hidden and removes recovery before revealing the verified first screen', () => {
  const startup = read('src-tauri/src/app/startup.rs');
  const builder = startup.slice(startup.indexOf('let mut main_builder ='), startup.indexOf('let main_win = main_builder.build()'));
  assert.match(builder, /\.visible\(false\)/);
  assert.match(builder, /\.focused\(false\)/);
  assert.doesNotMatch(builder, /\.visible\(!background_launch\)/);
  assert.doesNotMatch(startup, /tauri::async_runtime::block_on/);
  const install = startup.indexOf('native_startup::install(');
  assert.ok(install > startup.indexOf('let main_win = main_builder.build()'), 'install startup controls inside the existing main window');
  assert.ok(install < startup.indexOf('.mcp_supervisor.ensure_started(true)'), 'same-window recovery must be available before the first runtime attempt');
  assert.doesNotMatch(startup, /get_window\("startup"\)|native_startup::create\(/);
  const initialVisibility = startup.indexOf('page_connection.set_foreground(!background_launch)');
  assert.ok(initialVisibility >= 0 && initialVisibility < startup.indexOf('DesktopLock::acquire_with_launch('), 'initialize visibility before the singleton can receive a newer user wake or close intent');
  const connectionSetup = startup.slice(startup.indexOf('let (connection_script, initial_generation)'), startup.indexOf('let mut main_builder ='));
  assert.doesNotMatch(connectionSetup, /set_foreground/, 'setup must retain a user wake or close received during bootstrap');
  const reserve = startup.indexOf('connection.begin(&entry_target, false)');
  assert.ok(reserve >= 0 && reserve < startup.indexOf('let mut main_builder ='), 'reserve initial attempt before the hidden recovery document can retry');
  const pageLoad = startup.slice(startup.indexOf('.on_page_load('), startup.indexOf('.on_new_window('));
  assert.doesNotMatch(pageLoad, /sync_window_presentation|\.show\(|\.set_focus\(/, 'native page completion and network error documents cannot reveal chat');

  const lifecycle = read('src-tauri/src/app/main_window.rs');
  const ready = lifecycle.slice(lifecycle.indexOf('fn desktop_main_document_ready('), lifecycle.indexOf('pub(super) fn step_zoom('));
  assert.match(ready, /verify_connection_token\(&window,\s*&state,\s*&token,\s*false\)\?/);
  assert.match(ready, /actual\.as_str\(\)\s*!=\s*url/);
  assert.match(ready, /\.document_ready\(generation,\s*&actual\)/);
  assert.match(ready, /if ready\s*\{\s*sync_window_presentation\(&app,\s*false\)/);
  const hide = lifecycle.slice(lifecycle.indexOf('fn hide_main_window('), lifecycle.indexOf('fn sync_window_presentation('));
  assert.match(hide, /set_foreground\(false\)/);
  assert.match(hide, /sync_window_presentation\(app,\s*false\)/);
  assert.equal((startup.match(/hide_main_window\(&app_for_close/g) || []).length, 1, 'the only main window owns close-to-tray');
  assert.doesNotMatch(lifecycle, /get_window\("startup"\)/);
  assert.match(lifecycle, /native_startup::update\(/);
  assert.match(lifecycle, /native_startup::remove\(/);
  const mainPresentation = lifecycle.slice(lifecycle.indexOf('Presentation::Main =>'), lifecycle.indexOf('pub(super) fn current_entry_url'));
  const removeRecovery = mainPresentation.indexOf('native_startup::remove(');
  assert.ok(removeRecovery >= 0 && removeRecovery < mainPresentation.indexOf('window.show()'), 'remove recovery before the ready workspace becomes visible');
});

test('native recovery shortcuts stay within startup and include focused Windows buttons', () => {
  const native = read('src-tauri/src/app/native_startup.rs');
  const windows = native.slice(native.indexOf('#[cfg(windows)]'), native.indexOf('#[cfg(target_os = "linux")]'));
  assert.match(windows, /if message == WM_KEYDOWN\s*\{\s*(?:let action = )?shortcut_action\(/);
  assert.match(windows, /SetWindowSubclass\(/, 'focused native controls use local subclass handlers');
  assert.match(windows, /message == WM_NCDESTROY[\s\S]*?RemoveWindowSubclass[\s\S]*?Box::from_raw\(data/, 'every subclass owns and releases its callback with its HWND');
  for (const key of ['VK_CONTROL', 'VK_MENU', 'VK_SHIFT', 'VK_LWIN', 'VK_RWIN']) {
    assert.ok(windows.includes(`GetKeyState(${key} as i32)`), `${key} must reach the shared shortcut classifier`);
  }
  const linux = native.slice(native.indexOf('#[cfg(target_os = "linux")]'), native.indexOf('#[cfg(not(any('));
  assert.match(linux, /\.connect_key_press_event/);
  assert.match(linux, /let action = shortcut_action\(/);
  for (const modifier of ['CONTROL_MASK', 'MOD1_MASK', 'SHIFT_MASK', 'META_MASK', 'SUPER_MASK', 'HYPER_MASK']) {
    assert.ok(linux.includes(`ModifierType::${modifier}`), `${modifier} must reach the shared shortcut classifier`);
  }
  assert.match(linux, /Propagation::Proceed/, 'unmatched shortcuts must retain the OS control behavior');
  assert.doesNotMatch(native, /RegisterHotKey|SetWindowsHookEx|WH_KEYBOARD|addGlobalMonitorForEvents|grab_keyboard|gdk_keyboard_grab/);
  const startup = read('src-tauri/src/app/startup.rs');
  assert.match(startup, /native_startup::Action::Retry =>\s*\{?\s*main_window::reload_main_window/);
  assert.match(startup, /native_startup::Action::Hide =>\s*\{\s*hide_main_window/);
});

test('macOS startup overlay covers and preserves one WebView, restores focus, and releases callbacks', {
  skip: process.platform !== 'darwin', timeout: 45000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-native-startup-'));
  try {
    const executable = path.join(temporary, 'native-startup');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'Cocoa', '-framework', 'WebKit',
      path.join(__dirname, 'fixtures/native_startup_macos.m'), '-o', executable], { timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(compiled.stderr, '', 'AppKit fixture compiles without warnings');
    try {
      const result = await execute(executable, [], { timeout: 10000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /native startup AppKit controls passed/);
    } catch (error) {
      assert.fail(`Native startup fixture failed (exit=${error.code}, signal=${error.signal}):\n${error.stdout}\n${error.stderr}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
