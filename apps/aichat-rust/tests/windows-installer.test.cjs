const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const tauriRoot = path.resolve(__dirname, '../src-tauri');
const hooks = path.join(tauriRoot, 'windows/installer-hooks.nsh');

test('Windows install and uninstall stop the desktop supervisor before cleaning MCP', () => {
  const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.windows.conf.json'), 'utf8'));
  assert.equal(config.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh');
  const source = fs.readFileSync(hooks, 'utf8');
  for (const name of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL']) {
    const body = source.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`));
    assert.ok(body, `${name} must be defined`);
    assert.match(body[1], /!insertmacro CheckIfAppIsRunning "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe" "\$\{PRODUCTNAME\}"\s+!insertmacro KEEPWORK_STOP_BUNDLED_MCP/);
  }
  assert.match(source, /--stop-mcp "\$INSTDIR"/);
  assert.doesNotMatch(source, /powershell|taskkill|ExecutionPolicy/i);
});

test('Windows installer stops bundled MCP executables while preserving another installation', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-mcp-installer-'));
  const install = path.join(temp, 'Keepwork 安装目录');
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function launch(relative) {
    const executable = path.join(temp, relative);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    const child = spawn(executable, ['-e', 'console.log("ready"); setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(child, 'exit');
    children.push({ child, exited });
    const [ready] = await once(child.stdout, 'data');
    assert.match(ready.toString(), /ready/);
    return { child, exited };
  }
  const bundled = await launch('Keepwork 安装目录/resources/mcp-runtime/x64/bin/keepwork-mcp.exe');
  const legacy = await launch('Keepwork 安装目录/resources/mcp-runtime/keepworkmcp.exe');
  const unrelated = await launch('Keepwork 安装目录-other/keepwork-mcp.exe');
  function cleanup() {
    const result = spawnSync('cargo', [
      'run', '--quiet', '--manifest-path', path.join(tauriRoot, 'Cargo.toml'),
      '--bin', 'Keepwork', '--', '--stop-mcp', install,
    ], { encoding: 'utf8', windowsHide: true, timeout: 150000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  cleanup();
  await Promise.all([bundled.exited, legacy.exited]);
  process.kill(unrelated.child.pid, 0);
  assert.equal(unrelated.child.exitCode, null);
  cleanup();
  process.kill(unrelated.child.pid, 0);
});

const compiler = process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
test('Windows installer hooks compile in install and uninstall sections', {
  skip: process.platform !== 'win32' || !fs.existsSync(compiler), timeout: 60000,
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-nsis-hooks-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const include = hooks;
  fs.writeFileSync(path.join(temp, 'setup.nsi'), `Unicode true
RequestExecutionLevel user
Name "Keepwork installer hook fixture"
OutFile "Setup.exe"
InstallDir "$TEMP\\Keepwork-hook-fixture"
!include "LogicLib.nsh"
!define MAINBINARYNAME "Keepwork"
!define MAINBINARYSRCPATH "${process.execPath}"
!define PRODUCTNAME "Keepwork"
!macro CheckIfAppIsRunning executable productName
 DetailPrint "Fixture desktop process check"
!macroend
!include "${include}"
Section
 !insertmacro NSIS_HOOK_PREINSTALL
 WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd
Section "Uninstall"
 !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
`);
  const result = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', path.join(temp, 'setup.nsi')], {
    cwd: tauriRoot, encoding: 'utf8', windowsHide: true, timeout: 50000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.statSync(path.join(temp, 'Setup.exe')).size > 0);
});
