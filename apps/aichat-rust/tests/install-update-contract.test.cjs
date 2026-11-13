const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderer } = require('./helpers/desktop-renderer.cjs');

const app = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(app, 'src-tauri/src/app/updates_window.rs'), 'utf8');
function command(name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('#[tauri::command]', start);
  return source.slice(start, end < 0 ? undefined : end);
}

test('Bridge installUpdate never selects or applies an MCP update in any readiness quadrant', async () => {
  const bridgeInstall = command('desktop_install_update');
  assert.doesNotMatch(bridgeInstall, /snap\.mcp\.can_apply|apply_staged_update/,
    'MCP-only and simultaneous pending updates must not change the desktop installation target');
  assert.doesNotMatch(bridgeInstall, /open_updates_window\(/,
    'no ready desktop update returns the current snapshot without redirecting to MCP actions');
  for (const name of ['desktop_install_update', 'updates_window_apply_desktop']) {
    const desktop = command(name);
    assert.match(desktop, /if install_desktop_from_ui\(&app, &state\)\? == DesktopInstallOutcome::Launched\s*\{\s*state\.quitting\.store\(true, Ordering::Relaxed\);[\s\S]*?app\.exit\(0\)/);
  }
  for (const desktopReady of [false, true]) for (const mcpReady of [false, true]) {
    let mcpApplications = 0;
    const expected = { desktop: { canApply: desktopReady }, mcp: { canApply: mcpReady } };
    const fixture = renderer('rust', 'darwin', false, false, { invoke: command => {
      if (command === 'updates_window_apply_mcp') mcpApplications++;
      return Promise.resolve(command === 'desktop_install_update' ? expected : true);
    } });
    assert.deepEqual(await fixture.window.aichatDesktop.installUpdate(), expected);
    assert.deepEqual(fixture.calls.map(call => call.command), ['desktop_install_update']);
    assert.equal(mcpApplications, 0);
  }
});

test('the explicit MCP update entry retains its native confirmation and sender boundary', () => {
  const mcp = command('updates_window_apply_mcp');
  assert.match(mcp, /verify_updates_sender\(&window, &state\)\?/);
  assert.match(mcp, /blocking_show\(\)/);
  assert.match(mcp, /if confirmed\s*\{\s*let _ = state\.mcp_supervisor\.apply_staged_update\(\)\.await\?/);
});


test('automatic replacement is limited to an explicit full quit and preserves close-to-pet', () => {
  const startup = fs.readFileSync(path.join(app, 'src-tauri/src/app/startup.rs'), 'utf8');
  assert.match(startup, /ExitRequested \{ code: Some\(0\), api, \.\. \}/);
  assert.match(startup, /core_for_events\.quitting\.load\(Ordering::Relaxed\)/);
  assert.match(startup, /core\.updates\.install_on_exit\(\)/);
  assert.match(startup, /InstanceAction::Replace => \{\s*core_for_lock\.replacing_instance\.store\(true/);
  assert.match(startup, /&& !core_for_events\.replacing_instance\.load\(Ordering::Relaxed\)/);
  const main = fs.readFileSync(path.join(app, 'src-tauri/src/app/main_window.rs'), 'utf8');
  assert.doesNotMatch(main, /install_on_exit|launch_desktop_installer/);
  assert.match(source, /重启并更新/);
  assert.doesNotMatch(source, /打开新版本安装向导/);
});
