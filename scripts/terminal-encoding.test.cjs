const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { POWERSHELL_UTF8_INIT } = require('../src/core/terminalEncoding.ts');
// Exercise the spawn fallback without contacting the user's live editor terminal.
const bridge = require('../src/core/vscodeBridge.ts');
bridge.tryRunInVscodeTerminal = async () => null;
const { runTerminal } = require('../src/core/terminal.ts');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-encoding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    return root;
}

test('owned PowerShell reads BOM-less UTF-8 without command hints; explicit encoding still wins', { skip: process.platform !== 'win32' }, t => {
    const root = fixture(t), expected = '中文任务：检查日历和待办事项。📅';
    fs.writeFileSync(path.join(root, 'unicode.md'), expected, 'utf8');
    fs.writeFileSync(path.join(root, 'legacy.txt'), expected, 'utf16le');
    const read = command => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(`${POWERSHELL_UTF8_INIT}; ${command}`, 'utf16le').toString('base64')],
        { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.equal(read('Get-Content -Raw ./unicode.md'), expected);
    assert.equal(read('Get-Content -Raw -Encoding Unicode ./legacy.txt'), expected);
    assert.equal(read('Get-Content -Raw ./unicode.md | node -e "process.stdin.pipe(process.stdout)"'), expected);
    assert.equal(read("$PSDefaultParameterValues.ContainsKey('Set-Content:Encoding')"), 'False');
});

test('run_terminal preserves UTF-8 split across stdout and stderr pipe chunks', async t => {
    const root = fixture(t), expected = '中文📅';
    fs.writeFileSync(path.join(root, 'emit.cjs'), `const bytes = Buffer.from(${JSON.stringify(expected)}); let i = 0;
const timer = setInterval(() => { process.stdout.write(bytes.subarray(i, i + 1)); process.stderr.write(bytes.subarray(i, i + 1)); if (++i === bytes.length) clearInterval(timer); }, 30);`);
    const command = `"${process.execPath}" emit.cjs`;
    const result = await runTerminal({ command, root, timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, expected);
    assert.equal(result.command, command);
    assert.equal(result.via, 'spawn');
});

test('Windows spawn keeps cmd grammar and emits Unicode as UTF-8', { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t);
    const result = await runTerminal({ command: 'echo 中文任务 && exit /b 7', root, timeoutMs: 10000 });
    assert.equal(result.stdout.trim(), '中文任务');
    assert.equal(result.exitCode, 7);
    assert.equal(result.ok, false);
});

test('owned interactive PowerShell initializes UTF-8 before the first file read', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const { TerminalSessionManager } = require('../src/core/terminalSessions.ts');
    const manager = new TerminalSessionManager();
    t.after(async () => { manager.closeAll(); await new Promise(resolve => setTimeout(resolve, 300)); });
    const root = fixture(t), expected = '中文日历📅';
    fs.writeFileSync(path.join(root, 'unicode.md'), expected, 'utf8');
    const session = manager.create(root, '.', 'encoding-test', { cols: 180, rows: 30 });
    manager.write(session.id, 'encoding-test', 'Get-Content -Raw ./unicode.md\r');
    await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const output = manager.output(session.id, 'encoding-test', 0).output;
            if (output.includes(expected)) { clearInterval(timer); clearTimeout(deadline); resolve(); }
        }, 50);
        const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Interactive terminal did not return the UTF-8 file content')); }, 12000);
    });
});
