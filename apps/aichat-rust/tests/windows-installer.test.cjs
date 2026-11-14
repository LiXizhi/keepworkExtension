const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const tauriRoot = path.resolve(__dirname, '../src-tauri');
const hooks = path.join(tauriRoot, 'windows/installer-hooks.nsh');
const template = path.join(tauriRoot, 'windows/installer.nsi');

function maintenanceFunction() {
  const source = fs.readFileSync(template, 'utf8');
  const match = source.match(/^Function PageLeaveReinstall\b[\s\S]*?^FunctionEnd/m);
  assert.ok(match, 'maintenance page leave function must exist');
  return match[0];
}

function upstreamTemplateHash(source) {
  // Git's Windows checkout may use CRLF; lock the upstream text independently
  // of checkout line endings without ignoring any other content changes.
  const normalized = source.replace(/\r\n/g, '\n');
  const upstream = normalized.slice(normalized.indexOf('Unicode true'))
    .replace('      !insertmacro KEEPWORK_PREPARE_OLD_UNINSTALL "$4"\n', '');
  return createHash('sha256').update(upstream).digest('hex');
}

test('maintenance uninstall stops the old installation before its legacy uninstaller runs', () => {
  const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.windows.conf.json'), 'utf8'));
  assert.equal(config.bundle.windows.nsis.template, 'windows/installer.nsi');
  const source = fs.readFileSync(template, 'utf8');
  const expectedHash = 'd00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d';
  for (const newline of ['\n', '\r\n']) {
    const checkout = source.replace(/\r?\n/g, newline);
    assert.equal(upstreamTemplateHash(checkout), expectedHash,
      'keep the vendored Tauri template intact apart from the explicit old-uninstaller handoff');
    assert.notEqual(upstreamTemplateHash(checkout.replace('Unicode true', 'Unicode false')), expectedHash,
      'line-ending normalization must still reject changes to upstream template content');
  }
  const body = maintenanceFunction();
  assert.match(body, /reinst_uninstall:[\s\S]*?ReadRegStr \$4 SHCTX "\$\{MANUPRODUCTKEY\}" ""\s+!insertmacro KEEPWORK_PREPARE_OLD_UNINSTALL "\$4"\s+ReadRegStr \$R1 SHCTX "\$\{UNINSTKEY\}" "UninstallString"[\s\S]*?ExecWait '\$R1' \$0/,
    'PREINSTALL is too late: stop the old install before the selected maintenance uninstall');
  assert.equal((source.match(/!insertmacro KEEPWORK_PREPARE_OLD_UNINSTALL/g) || []).length, 1,
    'opening the setup or viewing its maintenance choices must not stop the desktop');
  const hookSource = fs.readFileSync(hooks, 'utf8');
  const prepare = hookSource.match(/!macro KEEPWORK_PREPARE_OLD_UNINSTALL\b([\s\S]*?)!macroend/);
  assert.ok(prepare);
  assert.match(prepare[1], /--stop-desktop "\$\{installDir\}\\Keepwork\.exe"[\s\S]*?--stop-desktop "\$\{installDir\}\\aichat-rust\.exe"[\s\S]*?--stop-mcp "\$\{installDir\}"/,
    'stop both desktop names and MCP from the old installation, even if the new destination differs');
});

test('Windows install and uninstall stop the desktop supervisor before cleaning MCP', () => {
  const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.windows.conf.json'), 'utf8'));
  assert.equal(config.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh');
  const source = fs.readFileSync(hooks, 'utf8');
  for (const name of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL']) {
    const body = source.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`));
    assert.ok(body, `${name} must be defined`);
    assert.match(body[1], /!insertmacro CheckIfAppIsRunning "\$INSTDIR\\Keepwork\.exe" "\$\{PRODUCTNAME\}"\s+!insertmacro CheckIfAppIsRunning "\$INSTDIR\\aichat-rust\.exe" "\$\{PRODUCTNAME\}"\s+!insertmacro KEEPWORK_STOP_BUNDLED_MCP/,
      `${name} must stop both native executable names before stopping any bundled service`);
  }
  assert.match(source, /--stop-desktop "\$\{executablePath\}"/,
    'the default Tauri process check must actively stop the exact installed executable');
  assert.match(source, /--stop-mcp "\$INSTDIR"/);
  for (const [, message] of source.matchAll(/Abort "([^"]*)"/g)) {
    if (message !== '$1') {
      assert.match(message, /[\u4e00-\u9fff]/u, `installer failure must explain itself in Chinese: ${message}`);
    }
  }
  assert.match(source, /--error-file/);
  assert.match(source, /FileReadUTF16LE/,
    'read helper failure reasons as Unicode regardless of the Windows console code page');
  assert.match(source, /MessageBox[\s\S]*?\$1/,
    'show the actual helper failure in the installer UI');
  assert.doesNotMatch(source, /powershell|taskkill|ExecutionPolicy/i);
});

test('installer extracts its helper once and reports a failed first extraction in Chinese', () => {
  const source = fs.readFileSync(hooks, 'utf8');
  const prepare = source.match(/!macro KEEPWORK_PREPARE_INSTALLER_HELPER\b([\s\S]*?)!macroend/);
  const run = source.match(/!macro KEEPWORK_RUN_INSTALLER_HELPER\b([\s\S]*?)!macroend/);
  assert.ok(prepare, 'helper extraction must have its own guarded preparation step');
  assert.ok(run);
  assert.match(prepare[1], /\$\{If\} \$KeepworkInstallerHelperReady != "?1"?/);
  assert.match(prepare[1], /SetOverwrite try[\s\S]*?File \/oname=\$PLUGINSDIR\\keepwork-installer-helper\.exe[\s\S]*?SetOverwrite lastused/,
    'a first write failure must reach the controlled error path, without the default Ignore dialog');
  assert.match(prepare[1], /\$\{If\} \$\{Errors\}[\s\S]*?[\u4e00-\u9fff][\s\S]*?MessageBox[\s\S]*?SetErrorLevel 2[\s\S]*?Abort/);
  assert.match(prepare[1], /StrCpy \$KeepworkInstallerHelperReady "?1"?/);
  assert.ok(prepare[1].indexOf('StrCpy $KeepworkInstallerHelperReady') > prepare[1].indexOf('Abort'),
    'the helper becomes reusable only after extraction succeeds');
  assert.equal((source.match(/File \/oname=\$PLUGINSDIR\\keepwork-installer-helper\.exe/g) || []).length, 1);
  assert.match(run[1], /!insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER[\s\S]*?nsExec::ExecToStack/);
  assert.doesNotMatch(run[1], /\bFile\s+\/oname=/,
    'subsequent stop/check commands must not overwrite the helper that just executed');
});

test('Windows installer stops both desktop names before MCP and preserves other installations', {
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
    return { child, exited, executable };
  }
  const desktop = await launch('Keepwork 安装目录/Keepwork.exe');
  const legacyDesktop = await launch('Keepwork 安装目录/aichat-rust.exe');
  const bundled = await launch('Keepwork 安装目录/resources/mcp-runtime/x64/bin/keepwork-mcp.exe');
  const legacy = await launch('Keepwork 安装目录/resources/mcp-runtime/keepworkmcp.exe');
  const unrelated = await launch('Keepwork 安装目录-other/keepwork-mcp.exe');
  const unrelatedDesktop = await launch('Keepwork 安装目录-other/Keepwork.exe');
  const unrelatedLegacyDesktop = await launch('Keepwork 安装目录-other/aichat-rust.exe');
  function helper(command, target, expectedStatus = 0, errorFile) {
    const result = spawnSync('cargo', [
      'run', '--quiet', '--manifest-path', path.join(tauriRoot, 'Cargo.toml'),
      '--bin', 'Keepwork', '--', command, target,
      ...(errorFile ? ['--error-file', errorFile] : []),
    ], { encoding: 'utf8', windowsHide: true, timeout: 150000 });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }
  function alive(...processes) {
    for (const { child } of processes) {
      process.kill(child.pid, 0);
      assert.equal(child.exitCode, null);
    }
  }
  for (const app of [desktop, legacyDesktop]) {
    const errorFile = path.join(temp, `${path.basename(app.executable)}-中文错误.txt`);
    const diagnostic = helper('--check-desktop-stopped', app.executable, 2, errorFile);
    assert.match(diagnostic, /[\u4e00-\u9fff]/u, 'busy desktop diagnostic must be Chinese');
    const bytes = fs.readFileSync(errorFile);
    assert.equal(bytes.readUInt16LE(0), 0xfeff, 'NSIS diagnostic file must carry a UTF-16LE BOM');
    const installerDiagnostic = bytes.subarray(2).toString('utf16le').trim();
    assert.match(installerDiagnostic, /[\u4e00-\u9fff]/u);
    assert.ok(diagnostic.includes(installerDiagnostic), 'installer UI must receive the complete helper failure reason');
  }
  alive(desktop, legacyDesktop, bundled, legacy, unrelated, unrelatedDesktop, unrelatedLegacyDesktop);
  helper('--stop-desktop', desktop.executable);
  await desktop.exited;
  alive(legacyDesktop, bundled, legacy, unrelated, unrelatedDesktop, unrelatedLegacyDesktop);
  helper('--stop-desktop', legacyDesktop.executable);
  await legacyDesktop.exited;
  alive(bundled, legacy, unrelated, unrelatedDesktop, unrelatedLegacyDesktop);
  helper('--stop-mcp', install);
  await Promise.all([bundled.exited, legacy.exited]);
  for (const app of [desktop, legacyDesktop]) {
    helper('--stop-desktop', app.executable);
    helper('--check-desktop-stopped', app.executable);
  }
  helper('--stop-desktop', path.join(temp, 'missing-install', 'Keepwork.exe'));
  helper('--stop-mcp', install);
  alive(unrelated, unrelatedDesktop, unrelatedLegacyDesktop);
});

const compiler = process.env.MAKENSIS || 'C:/Program Files (x86)/NSIS/makensis.exe';
const inputCharsetFlag = process.platform === 'win32' ? '/INPUTCHARSET' : '-INPUTCHARSET';
test('maintenance handoff compiles and runs against an old check-only uninstaller on Windows', {
  skip: !fs.existsSync(compiler), timeout: 240000,
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-old-uninstaller-'));
  const install = path.join(temp, '旧版 Keepwork 安装目录');
  const registry = `Software\\Keepwork\\InstallerMigrationTests\\${path.basename(temp)}`;
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    if (process.platform === 'win32') {
      spawnSync('reg.exe', ['delete', `HKCU\\${registry}`, '/f'], { windowsHide: true });
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function run(file, args, timeout = 60000) {
    const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }
  // Cross-platform compilation needs a File payload, not a runnable Windows
  // helper. Real Windows execution below always uses the freshly built app.
  let helper = path.join(temp, 'compile-only-helper.exe');
  fs.writeFileSync(helper, 'MZ compile-only fixture');
  if (process.platform === 'win32') {
    run('cargo', ['build', '--quiet', '--manifest-path', path.join(tauriRoot, 'Cargo.toml'), '--bin', 'Keepwork'], 150000);
    const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', path.join(tauriRoot, 'Cargo.toml')]));
    helper = path.join(metadata.target_directory, 'debug', 'Keepwork.exe');
  }
  async function launch(relative) {
    const executable = path.join(temp, relative);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    const child = spawn(executable, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const processRecord = { child, exited: once(child, 'exit') };
    children.push(processRecord);
    const [ready] = await once(child.stdout, 'data');
    assert.match(ready.toString(), /ready/);
    return processRecord;
  }
  let desktop, legacyDesktop, mcp, external;
  if (process.platform === 'win32') {
    desktop = await launch('旧版 Keepwork 安装目录/Keepwork.exe');
    legacyDesktop = await launch('旧版 Keepwork 安装目录/aichat-rust.exe');
    mcp = await launch('旧版 Keepwork 安装目录/resources/keepwork-mcp.exe');
    external = await launch('旧版 Keepwork 安装目录-other/Keepwork.exe');
  }
  const writer = path.join(temp, 'legacy-writer.exe');
  const marker = path.join(temp, 'legacy-uninstaller-ran.txt');
  const oldSource = path.join(temp, 'old.nsi');
  fs.writeFileSync(oldSource, `Unicode true
SetCompress off
RequestExecutionLevel user
Name "Old Keepwork uninstaller fixture"
OutFile "${writer}"
InstallDir "${install}"
!include "LogicLib.nsh"
Section
 WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
 ; Reproduce the published old behavior: check only, never terminate.
 nsExec::ExecToStack '"${helper}" --check-desktop-stopped "$INSTDIR\\Keepwork.exe"'
 Pop $0
 Pop $1
 \${If} $0 != "0"
  SetErrorLevel 2
  Abort "Old uninstaller rejected a running desktop"
 \${EndIf}
 nsExec::ExecToStack '"${helper}" --check-desktop-stopped "$INSTDIR\\aichat-rust.exe"'
 Pop $0
 Pop $1
 \${If} $0 != "0"
  SetErrorLevel 2
  Abort "Old uninstaller rejected a running legacy desktop"
 \${EndIf}
 Delete "$INSTDIR\\Keepwork.exe"
 Delete "$INSTDIR\\aichat-rust.exe"
 FileOpen $0 "${marker}" w
 FileWrite $0 "old-uninstaller-completed"
 FileClose $0
SectionEnd
`);
  run(compiler, [inputCharsetFlag, 'UTF8', oldSource]);
  assert.ok(fs.statSync(writer).size > 0);
  if (process.platform === 'win32') run(writer, ['/S']);
  const fixture = path.join(temp, 'handoff.exe');
  const newSource = path.join(temp, 'handoff.nsi');
  fs.writeFileSync(newSource, `Unicode true
SetCompress off
RequestExecutionLevel user
Name "Keepwork maintenance handoff fixture"
OutFile "${fixture}"
InstallDir "${install}"
!include "LogicLib.nsh"
!define MAINBINARYNAME "Keepwork"
!define MAINBINARYSRCPATH "${helper}"
!define PRODUCTNAME "Keepwork"
!define MANUPRODUCTKEY "${registry}\\Install"
!define UNINSTKEY "${registry}\\Uninstall"
Var WixMode
Var UpdateMode
Var PassiveMode
!macro CheckIfAppIsRunning executable productName
!macroend
!include "${hooks}"
!macro FixtureSelectedUninstall hwnd output
 StrCpy \${output} 1
!macroend
!define NSD_GetState "!insertmacro FixtureSelectedUninstall"
LangString unableToUninstall 1033 "Fixture old uninstaller failed"
${maintenanceFunction()}
Section
 SetShellVarContext current
 WriteRegStr HKCU "\${MANUPRODUCTKEY}" "" "${install}"
 WriteRegStr HKCU "\${UNINSTKEY}" "UninstallString" '"${path.join(install, 'uninstall.exe')}" /S'
 StrCpy $WixMode 0
 StrCpy $UpdateMode 0
 StrCpy $PassiveMode 0
 StrCpy $R0 1
 Call PageLeaveReinstall
 DeleteRegKey HKCU "${registry}"
SectionEnd
`);
  run(compiler, [inputCharsetFlag, 'UTF8', newSource]);
  assert.ok(fs.statSync(fixture).size > 0);
  if (process.platform !== 'win32') return;
  run(fixture, ['/S']);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'old-uninstaller-completed');
  await Promise.all([desktop.exited, legacyDesktop.exited, mcp.exited]);
  process.kill(external.child.pid, 0);
  assert.equal(external.child.exitCode, null, 'maintenance must preserve another installation');
});

test('Windows installer hooks compile in install and uninstall sections', {
  skip: !fs.existsSync(compiler), timeout: 60000,
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-nsis-hooks-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const include = hooks;
  const helper = path.join(temp, 'compile-only-helper.exe');
  fs.writeFileSync(helper, 'MZ compile-only fixture');
  fs.writeFileSync(path.join(temp, 'setup.nsi'), `Unicode true
SetCompress off
RequestExecutionLevel user
Name "Keepwork installer hook fixture"
OutFile "Setup.exe"
InstallDir "$TEMP\\Keepwork-hook-fixture"
!include "LogicLib.nsh"
!define MAINBINARYNAME "Keepwork"
!define MAINBINARYSRCPATH "${helper}"
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
  const result = spawnSync(compiler, [inputCharsetFlag, 'UTF8', path.join(temp, 'setup.nsi')], {
    cwd: tauriRoot, encoding: 'utf8', windowsHide: true, timeout: 50000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.statSync(path.join(temp, 'Setup.exe')).size > 0);
});

test('helper preparation tolerates a locked existing helper and rejects a blocked first write', {
  skip: !fs.existsSync(compiler), timeout: 60000,
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-helper-write-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const helper = path.join(temp, 'compile-only-helper.exe');
  fs.writeFileSync(helper, 'MZ compile-only fixture');
  for (const scenario of ['locked', 'blocked']) {
    const marker = path.join(temp, `${scenario}-completed.txt`);
    const executable = path.join(temp, `${scenario}.exe`);
    const script = path.join(temp, `${scenario}.nsi`);
    const prepare = scenario === 'locked' ? `
 !insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER
 ; Deny write access while allowing reads/deletion: a repeated File instruction
 ; fails deterministically, without depending on antivirus or process timing.
 System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\\keepwork-installer-helper.exe", i 0x80000000, i 5, p 0, i 3, i 0, p 0) p.r8'
 \${If} $8 == -1
  SetErrorLevel 91
  Abort "Fixture could not lock the extracted helper"
 \${EndIf}
 !insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER
 !insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER
 System::Call 'kernel32::CloseHandle(p r8)'
` : `
 ; A directory at the target filename makes the very first extraction fail.
 CreateDirectory "$PLUGINSDIR\\keepwork-installer-helper.exe"
 !insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER
`;
    fs.writeFileSync(script, `Unicode true
SetCompress off
RequestExecutionLevel user
Name "Keepwork helper write fixture"
OutFile "${executable}"
!include "LogicLib.nsh"
!define MAINBINARYNAME "Keepwork"
!define MAINBINARYSRCPATH "${helper}"
!define PRODUCTNAME "Keepwork"
!macro CheckIfAppIsRunning executable productName
!macroend
!include "${hooks}"
Section
 InitPluginsDir
${prepare}
 FileOpen $0 "${marker}" w
 FileWrite $0 "completed"
 FileClose $0
SectionEnd
`);
    const compiled = spawnSync(compiler, [inputCharsetFlag, 'UTF8', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    assert.ok(fs.statSync(executable).size > 0);
    if (process.platform === 'win32') {
      const executed = spawnSync(executable, ['/S'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.ifError(executed.error);
      assert.equal(executed.status, scenario === 'locked' ? 0 : 2, executed.stdout + executed.stderr);
      assert.equal(fs.existsSync(marker), scenario === 'locked');
    }
  }
});
