const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

const appRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(appRoot, relative), 'utf8');

test('only the local voice settings window can persist automatic-start preference', () => {
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
  assert.ok(local.includes('"remote_voice_set_auto_start"'));
  assert.equal(legacy.includes('remote_voice_set_auto_start'), false);
  const host = read('src-tauri/src/app/remote_voice_host.rs');
  const command = host.slice(host.indexOf('fn remote_voice_set_auto_start(')).split('#[tauri::command]')[0];
  assert.ok(command.includes('verify(&window)?'), 'preference writes require the exact local settings sender');
  assert.ok(/enabled:\s*bool/.test(command), 'a typed boolean controls the preference');
  const bridge = read('src/bridge.ts') + read('src-tauri/src/bridge.rs');
  assert.equal(bridge.includes('remote_voice_set_auto_start'), false);
  assert.ok(read('src-tauri/src/app/startup.rs').includes('remote_voice_host::remote_voice_set_auto_start'));
});

test('automatic-start preference is explicit in native settings and can be switched off while input runs', () => {
  const html = read('remote-voice.html');
  const renderer = read('src/remote-voice.ts');
  assert.ok(/<input\b(?=[^>]*\btype="checkbox")(?=[^>]*\bid="auto-start")[^>]*>/.test(html),
    'settings expose an automatic-start checkbox');
  assert.ok(renderer.includes('autoStart'), 'saved preference is represented separately from current running state');
  assert.ok(renderer.includes('remote_voice_set_auto_start'), 'the checkbox persists the preference through its guarded command');
  assert.ok((/enabled\s*:/.test(renderer) || /const enabled\s*=[^\n]*\.checked/.test(renderer))
    && /\.checked/.test(renderer), 'the checkbox sends a boolean');
  const configuration = html.match(/<fieldset\b[^>]*id="configuration"[^>]*>([\s\S]*?)<\/fieldset>/)?.[1];
  assert.ok(configuration !== undefined);
  if (configuration.includes('id="auto-start"')) {
    assert.equal(/configuration[^\n]*disabled\s*=\s*next\.running/.test(renderer), false,
      'running input cannot disable the automatic-start opt-out control');
  }
  assert.equal(/默认关闭，重启后需手动启动/.test(html), false, 'settings must describe the new default');
});

test('paired-device admission probes never perform discovery, connection, or keyboard monitoring', () => {
  const source = read('src-tauri/src/remote_voice/paired.rs').split('#[cfg(test)]')[0];
  const directory = path.join(appRoot, 'src-tauri/src/remote_voice');
  const nativeFiles = fs.readdirSync(directory).filter(name => /^paired.*\.(m|mm)$/.test(name));
  const native = nativeFiles.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
  const probe = source + native;
  assert.equal(/\.start_scan\(|\.connect\(|\.subscribe\(|CGEventTapCreate|SetWindowsHookEx|CGEventPost|SendInput|NativeInput::new/.test(probe), false,
    'checking an existing pairing cannot start a scan, connect, or install an input hook');
  assert.ok(source.includes('paired_remote'), 'the watcher uses a dedicated read-only paired-device query');
  assert.ok(source.includes('select_paired'), 'multiple/unknown candidates are handled before starting voice');
});

test('automatic monitoring starts after core initialization and shutdown revokes both watcher and input', () => {
  const startup = read('src-tauri/src/app/startup.rs');
  const setup = startup.indexOf('.setup(');
  const automatic = startup.indexOf('.start_automatic()');
  assert.ok(setup >= 0 && automatic > setup, 'the watcher is installed from app setup after AppCore exists');
  assert.ok(startup.indexOf('let core = Arc::new(AppCore') < automatic);
  const core = read('src-tauri/src/remote_voice.rs');
  const start = core.slice(core.indexOf('fn start_automatic(')).split('\n    pub fn ')[0];
  assert.ok(/spawn/.test(start), 'monitoring is detached from the webview startup path');
  assert.equal(/block_on\(|thread::sleep\(/.test(start), false, 'startup must not wait for a pairing probe');
  const run = startup.slice(startup.lastIndexOf('.run('));
  assert.ok(run.includes('RunEvent::Exit') && run.includes('RunEvent::ExitRequested'));
  assert.ok(run.includes('voice.shutdown()'), 'exit invalidates pending probe results and stops input');
  const menu = read('src-tauri/src/app/host_menu.rs');
  const quit = menu.slice(menu.indexOf('fn quit_desktop('), menu.indexOf('async fn show_mcp_status('));
  assert.ok(quit.includes('core.remote_voice.shutdown()'));
});

test('automatic-start intent and stale-probe policy passes isolated production Rust fixtures', {
  timeout: 30000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-voice-autostart-'));
  try {
    const executable = path.join(temporary, process.platform === 'win32' ? 'policy.exe' : 'policy');
    await execute('rustc', ['--edition', '2021', '--test',
      path.join(__dirname, 'fixtures/remote_voice_autostart_policy.rs'), '-o', executable], { timeout: 20000 });
    const result = await execute(executable, [], { timeout: 5000 });
    assert.ok(/test result: ok/.test(result.stdout), result.stdout + result.stderr);
    assert.ok(/0 failed/.test(result.stdout));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
