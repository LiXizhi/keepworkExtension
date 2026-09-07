const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { spawnSync, spawn } = require('node:child_process');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText + (filename.endsWith('computer.ts') ? '\nexports.helperForTest = helper;' : ''), filename);
const { ComputerController, computerSchema, helperForTest } = require('../src/core/computer.ts');
const { computerToolSchema } = require('../src/mcp/computerTools.ts');
const { z } = require('zod');
const { computerOverlay } = require('../src/core/computerOverlay.ts');

test('complete native helper starts and exits on closed input without consent', { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(helperForTest, 'utf16le').toString('base64')], { input: '', encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), '');
    assert.equal(result.stderr.trim(), '', 'Non-error startup output must not trigger the stderr failure handler');
});

test('controller forwards the requesting session identity to native consent', async () => {
    const owners = [];
    const controller = new ComputerController('win32', async (args, owner) => { owners.push(owner); return JSON.stringify({ width: 1920, height: 1080, data: 'aW1hZ2U=' }); });
    await controller.run({ action: 'key', key: 'Tab' }, 'session-one');
    await controller.run({ action: 'key', key: 'Tab' }, 'session-two');
    assert.deepEqual(owners, ['session-one', 'session-two']);
});

test('overlay preserves revocation and capture isolation guards', () => {
    assert.match(computerOverlay, /StartPosition = FormStartPosition.Manual/);
    assert.match(computerOverlay, /AutoScaleMode = AutoScaleMode.None/);
    assert.doesNotMatch(helperForTest, /ReadLineAsync/);
    assert.match(computerOverlay, /button.Click \+= delegate \{ Revoke\(\); \}/);
    assert.match(computerOverlay, /SetWindowDisplayAffinity\(Handle, 0x11\)/);
    assert.match(computerOverlay, /ShowWithoutActivation/);
    assert.match(computerOverlay, /passthrough = border \|\| tip/);
    assert.match(computerOverlay, /if \(passthrough\) parameters.ExStyle \|= 0x20 \| 0x80000/);
    assert.match(computerOverlay, /Tip = new ControlOverlay\(false, true\)/);
    assert.match(computerOverlay, /Tip.ProtectCapture\(\)/);
    assert.match(computerOverlay, /Tip.Dispose\(\)/);
    assert.match(computerOverlay, /return Panel != null && Panel.Bounds.Contains\(x, y\)/);
    assert.match(computerOverlay, /OnHandleCreated\(EventArgs args\)[\s\S]*?ProtectCapture\(\)/);
    assert.match(computerOverlay, /PrepareCapture\(\)[\s\S]*?Border.ProtectCapture\(\);[\s\S]*?Panel.ProtectCapture\(\);[\s\S]*?DwmFlush\(\)/);
    assert.match(helperForTest, /ControlOverlay\]::PrepareCapture\(\)\s*\$graphics.CopyFromScreen/);
    assert.match(helperForTest, /\$owner -ne \$envelope.owner/);
    assert.match(helperForTest, /ControlOverlay\]::Check\(\)/);
    assert.match(helperForTest, /finally \{ \[ControlOverlay\]::Revoke\(\) \}/);
});

test('native overlay compiles without displaying windows or sending input', { skip: process.platform !== 'win32' }, () => {
    const command = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: computerOverlay, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('published tool schema exposes action and empty calls default only to status', async () => {
    const schema = z.toJSONSchema(computerToolSchema);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.action.enum.includes('screenshot'));
    assert.deepEqual(computerToolSchema.parse({}), { action: 'status' });
    const controller = new ComputerController('win32', () => { throw Error('must not run'); });
    await controller.run(computerToolSchema.parse({}));
    assert.equal(computerSchema.safeParse(computerToolSchema.parse({ action: 'click' })).success, false);
    assert.equal(computerSchema.safeParse(computerToolSchema.parse({ text: 'hello' })).success, false);
});

test('desktop schema rejects arbitrary scripts, shortcuts and invalid coordinates', () => {
    for (const input of [{ action: 'execute', code: 'x' }, { action: 'key', key: 'Win+R' }, { action: 'click', x: -1, y: 0 }, { action: 'type', text: 'a'.repeat(1001) }, { action: 'screenshot', approved: true }]) {
        assert.equal(computerSchema.safeParse(input).success, false);
    }
});

test('status is side-effect free and unsupported platforms fail closed', async () => {
    const controller = new ComputerController('linux', () => { throw Error('must not run'); });
    assert.equal(JSON.parse((await controller.run({ action: 'status' })).content[0].text).supported, false);
    await assert.rejects(controller.run({ action: 'screenshot' }), /Windows/);
});

test('one desktop action at a time with no queue; lock releases after denial', async () => {
    let rejectAction;
    const controller = new ComputerController('win32', () => new Promise((resolve, reject) => { rejectAction = reject; }));
    const pending = controller.run({ action: 'screenshot' });
    await assert.rejects(controller.run({ action: 'click', x: 1, y: 1 }), /busy/);
    rejectAction(Error('denied'));
    await assert.rejects(pending, /denied/);
    const next = controller.run({ action: 'key', key: 'Escape' });
    rejectAction(Error('denied again'));
    await assert.rejects(next, /denied again/);
});

test('screenshots preserve MCP image blocks and physical dimensions', async () => {
    const controller = new ComputerController('win32', async () => JSON.stringify({ width: 1920, height: 1080, data: 'aW1hZ2U=' }));
    const result = await controller.run({ action: 'screenshot' });
    assert.equal(result.content[1].type, 'image');
    assert.equal(JSON.parse(result.content[0].text).width, 1920);
});

test('every input returns a fresh visual observation rather than claiming UI success', async () => {
    const controller = new ComputerController('win32', async () => JSON.stringify({ width: 2560, height: 1440, data: 'aW1hZ2U=' }));
    for (const args of [{ action: 'click', x: 994, y: 1416 }, { action: 'type', text: 'hello world' }, { action: 'key', key: 'Enter' }, { action: 'scroll', delta: 120 }]) {
        const result = await controller.run(args);
        const metadata = JSON.parse(result.content[0].text);
        assert.equal(metadata.action, args.action);
        assert.equal(metadata.inputSent, true);
        assert.equal(metadata.completed, undefined);
        assert.equal(metadata.width, 2560);
        assert.equal(result.content[1].type, 'image');
    }
    assert.match(helperForTest, /Invoke-DesktopAction \(\[pscustomobject\]@\{ action='screenshot' \}\)/);
    const missing = new ComputerController('win32', async () => '');
    await assert.rejects(missing.run({ action: 'key', key: 'Tab' }), /observation missing/);
});

test('fixed Windows helper parses without executing desktop actions', { skip: process.platform !== 'win32' }, () => {
    const parser = "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { input: helperForTest, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('native pipe reader does not block the UI thread waiting for input', { skip: process.platform !== 'win32' }, async () => {
    const probe = helperForTest.slice(0, helperForTest.indexOf("$owner = ''")) + '\n$reader = [ControlOverlay]::ReadRequest(); [Console]::Out.WriteLine("reader-ready"); [Console]::Out.Flush()';
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('UI thread blocked on idle stdin')), 10000);
            let output = '';
            child.stdout.on('data', chunk => {
                output += chunk;
                if (output.includes('reader-ready')) { clearTimeout(timer); resolve(); }
            });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('exit', () => { clearTimeout(timer); if (!output.includes('reader-ready')) reject(Error('No readiness signal')); });
        });
    } finally { child.stdin.end(); child.kill(); }
});