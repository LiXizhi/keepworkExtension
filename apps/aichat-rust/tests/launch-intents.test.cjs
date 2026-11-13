const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { renderer } = require('./helpers/desktop-renderer.cjs');

const app = path.resolve(__dirname, '..');
const documentId = '42b7c128-a171-44c9-b226-85ff87bde647';
const crypto = { randomUUID: () => documentId };
const entryUrl = 'http://localhost:57175/';

function typescriptBridge({ shell = false, subframe = false, url = entryUrl, capability = 'fixture-launch-token' } = {}) {
  const calls = [], listeners = new Map();
  const window = {
    location: new URL(url),
    __AICHAT_DESKTOP_BOOTSTRAP__: { platform: 'darwin', entryUrl },
    addEventListener: (name, callback) => listeners.set(name, callback),
    postMessage() {},
    ...(shell ? { __AICHAT_PAGE_CONNECTION__: {} } : {}),
  };
  window.top = subframe ? {} : window;
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(app, 'src/bridge.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, window, URL, crypto,
    require: name => name.endsWith('/core')
      ? { invoke: (command, args = {}) => { calls.push({ command, args }); return Promise.resolve(true); } }
      : { listen: () => Promise.resolve(() => {}) },
  });
  exports.installAIChatDesktopBridge(capability);
  return { window, calls, fire: detail => listeners.get('__aichat_desktop_event__')?.({ detail }), pagehide: () => listeners.get('pagehide')?.({}) };
}

for (const implementation of ['injected', 'typescript']) {
  test(`${implementation} Bridge v1 exposes optional launch intents without automatically consuming one`, async () => {
    const fixture = implementation === 'injected'
      ? renderer('rust', 'darwin', false, false, { crypto, entryUrl })
      : typescriptBridge();
    const bridge = fixture.window.aichatDesktop;
    assert.equal(bridge.version, 1);
    assert.equal(bridge.capabilities.launchIntents, true);
    assert.ok(Object.isFrozen(bridge));
    assert.equal(fixture.calls.filter(call => call.command.includes('launch_intent')).length, 0);
    await bridge.getLaunchIntent();
    await bridge.acknowledgeLaunchIntent('ticket');
    const calls = fixture.calls.filter(call => call.command.includes('launch_intent'));
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      { command: 'desktop_get_launch_intent', args: { document: documentId, token: 'fixture-launch-token' } },
      { command: 'desktop_acknowledge_launch_intent', args: { document: documentId, token: 'fixture-launch-token', id: 'ticket' } },
    ]);
    assert.equal(bridge.document, undefined);
    assert.equal(fixture.window.__AICHAT_DESKTOP_BOOTSTRAP__?.launchCapability, undefined);
    let notifications = 0;
    const stop = bridge.onLaunchIntent((...args) => { assert.equal(args.length, 0); notifications++; });
    const notify = () => implementation === 'injected'
      ? fixture.fire(fixture.window, '__aichat_desktop_event__', { detail: { event: 'launch-intent', payload: { ignored: 'untrusted' } } })
      : fixture.fire({ event: 'launch-intent', payload: { ignored: 'untrusted' } });
    notify();
    assert.equal(notifications, 1);
    stop();
    notify();
    assert.equal(notifications, 1);
    // Existing pages may ignore the optional surface and keep using Bridge v1.
    await bridge.roots();
    assert.equal(fixture.calls.at(-1).command, 'desktop_roots');
    const callsBeforePagehide = fixture.calls.length;
    if (implementation === 'injected') fixture.fire(fixture.window, 'pagehide');
    else fixture.pagehide();
    await assert.rejects(bridge.acknowledgeLaunchIntent('late-ticket'), /no longer active/);
    await assert.rejects(bridge.getLaunchIntent(), /no longer active/);
    assert.equal(fixture.calls.length, callsBeforePagehide);
  });

  test(`${implementation} connection pages and subframes receive no launch-intent capability`, () => {
    const shell = implementation === 'injected'
      ? renderer('rust', 'darwin', false, false, { crypto, entryUrl, shell: true })
      : typescriptBridge({ shell: true });
    assert.equal(shell.window.aichatDesktop.capabilities.launchIntents, undefined);
    assert.equal(shell.window.aichatDesktop.getLaunchIntent, undefined);
    const frame = implementation === 'injected'
      ? renderer('rust', 'darwin', true, false, { crypto, entryUrl })
      : typescriptBridge({ subframe: true });
    assert.equal(frame.window.aichatDesktop, undefined);
  });

  test(`${implementation} a renderer cannot invent its own native launch authority`, () => {
    const fixture = implementation === 'injected'
      ? renderer('rust', 'darwin', false, false, { crypto, entryUrl, launchCapability: '' })
      : typescriptBridge({ capability: '' });
    assert.equal(fixture.window.aichatDesktop.capabilities.launchIntents, undefined);
    assert.equal(fixture.window.aichatDesktop.getLaunchIntent, undefined);
    assert.equal(fixture.window.aichatDesktop.capabilities.files, true);
  });
}

test('unrelated top-level documents cannot advertise launch-intent access', () => {
  const fixture = typescriptBridge({ url: 'http://localhost:57175/tool.html' });
  assert.equal(fixture.window.aichatDesktop.capabilities.launchIntents, undefined);
  assert.equal(fixture.window.aichatDesktop.acknowledgeLaunchIntent, undefined);
});

test('a host-controlled local source switch retains the optional contract on the new AIChat entry', () => {
  const fixture = typescriptBridge({ url: 'http://127.0.0.1:3002/AIChat.html' });
  assert.equal(fixture.window.aichatDesktop.capabilities.launchIntents, true);
});

test('launch commands are allow-listed and reject the connection shell before reading or acknowledging', () => {
  const source = fs.readFileSync(path.join(app, 'src-tauri/src/app/launch.rs'), 'utf8');
  const permissions = fs.readFileSync(path.join(app, 'src-tauri/permissions/desktop-commands.toml'), 'utf8');
  const startup = fs.readFileSync(path.join(app, 'src-tauri/src/app/startup.rs'), 'utf8');
  for (const command of ['desktop_get_launch_intent', 'desktop_acknowledge_launch_intent']) {
    assert.ok(permissions.includes(`"${command}"`));
    assert.ok(startup.includes(`super::launch::${command}`));
  }
  assert.match(source, /verify_main_sender\(window, core\)\?/);
  assert.match(source, /page_connection\.lock\(\)\.unwrap\(\)\.is_shell\(&url\)/);
  assert.match(source, /security::trusted_page/);
  assert.equal((source.match(/intents\.authenticate\(&token\)\?/g) || []).length, 2);
  assert.match(startup, /launch_intents\.lock\(\)\.unwrap\(\)\.invalidate_document\(\)/);
});

test('platform registration uses a strict URL-only helper and keeps other installations ownership', () => {
  const plist = fs.readFileSync(path.join(app, 'src-tauri/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array><string>keepwork-secondbrain<\/string><\/array>/);
  const hooks = fs.readFileSync(path.join(app, 'src-tauri/windows/installer-hooks.nsh'), 'utf8');
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(hooks, /WriteRegStr HKCU "Software\\Classes\\keepwork-secondbrain\\shell\\open\\command" "" '\$"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$" --launch-url \$"%1\$"'/);
  const uninstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'));
  assert.ok(uninstall.indexOf('${If} $0 ==') < uninstall.indexOf('DeleteRegKey'));
  const main = fs.readFileSync(path.join(app, 'src-tauri/src/main.rs'), 'utf8');
  assert.ok(main.indexOf('"--launch-url"') < main.indexOf('"--stop-mcp"'));
  assert.match(main, /protocol_launch_action\(std::env::args_os\(\)\.skip\(2\)\)/);
});

const compiler = process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
test('Windows protocol registration and ownership-preserving uninstall hooks compile', {
  skip: process.platform !== 'win32' || !fs.existsSync(compiler), timeout: 60000,
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-launch-hooks-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const hooks = path.join(app, 'src-tauri/windows/installer-hooks.nsh');
  const script = path.join(temp, 'setup.nsi');
  fs.writeFileSync(script, `Unicode true
RequestExecutionLevel user
Name "Keepwork launch hook fixture"
OutFile "${path.join(temp, 'Setup.exe')}"
InstallDir "$TEMP\\Keepwork launch 中文"
!include "LogicLib.nsh"
!define MAINBINARYNAME "Keepwork"
!define MAINBINARYSRCPATH "${process.execPath}"
!define PRODUCTNAME "Keepwork"
!macro CheckIfAppIsRunning executable productName
 DetailPrint "Fixture desktop check"
!macroend
!include "${hooks}"
Section
 !insertmacro NSIS_HOOK_POSTINSTALL
 WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd
Section "Uninstall"
 !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`);
  const result = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', script], {
    encoding: 'utf8', windowsHide: true, timeout: 50000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.statSync(path.join(temp, 'Setup.exe')).size > 0);
});
