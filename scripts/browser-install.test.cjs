const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KEEPWORK_BROWSER_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-install-'));

const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const install = require('../src/core/browserInstall.ts');

function shellRelative() {
    if (process.platform === 'win32') return path.join('chrome-win', 'headless_shell.exe');
    if (process.platform === 'darwin') return path.join('chrome-mac', 'headless_shell');
    return path.join('chrome-linux', 'headless_shell');
}
function fullRelative() {
    if (process.platform === 'win32') return path.join('chrome-win', 'chrome.exe');
    if (process.platform === 'darwin') return path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    return path.join('chrome-linux', 'chrome');
}
function fakeRevision(root, name, relatives) {
    for (const relative of relatives) {
        const target = path.join(root, name, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
    }
}

test('cache root honors KEEPWORK_BROWSER_CACHE', () => {
    assert.equal(install.browserCacheRoot(), process.env.KEEPWORK_BROWSER_CACHE);
});

test('playwright installer CLI resolves from the packaged dependency', () => {
    const cli = install.playwrightCli();
    assert.ok(cli && cli.endsWith('cli.js') && fs.existsSync(cli));
});

test('executable probe prefers the requested mode and newest revision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-probe-'));
    assert.equal(install.bundledBrowserExecutable(true, root), null);
    fs.mkdirSync(path.join(root, 'not-a-browser'), { recursive: true });
    fakeRevision(root, 'chromium-1000', [fullRelative()]);
    fakeRevision(root, 'chromium_headless_shell-1001', [shellRelative()]);
    assert.equal(install.bundledBrowserExecutable(true, root), path.join(root, 'chromium_headless_shell-1001', shellRelative()));
    assert.equal(install.bundledBrowserExecutable(false, root), path.join(root, 'chromium-1000', fullRelative()));
});

test('ensureBundledBrowser is single-flight and tracks status', async () => {
    const root = process.env.KEEPWORK_BROWSER_CACHE;
    let calls = 0;
    const fakeRun = async () => {
        calls++;
        assert.equal(install.bundledBrowserStatus(), 'downloading');
        await new Promise(resolve => setTimeout(resolve, 30));
        fakeRevision(root, 'chromium_headless_shell-2000', [shellRelative()]);
    };
    assert.equal(install.bundledBrowserStatus(), 'not-installed');
    const [a, b] = [install.ensureBundledBrowser(fakeRun), install.ensureBundledBrowser(fakeRun)];
    assert.strictEqual(a, b);
    await a;
    assert.equal(calls, 1);
    assert.equal(install.bundledBrowserStatus(), 'installed');
    await install.ensureBundledBrowser(fakeRun);
    assert.equal(calls, 1);
});

test('failed downloads surface a bounded error and allow retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-fail-'));
    const originalCache = process.env.KEEPWORK_BROWSER_CACHE;
    process.env.KEEPWORK_BROWSER_CACHE = root;
    try {
        await assert.rejects(install.ensureBundledBrowser(async () => { throw new Error('network down'); }), /network down/);
        assert.equal(install.bundledBrowserStatus(), 'failed');
        await install.ensureBundledBrowser(async () => fakeRevision(root, 'chromium_headless_shell-2001', [shellRelative()]));
        assert.equal(install.bundledBrowserStatus(), 'installed');
    } finally {
        process.env.KEEPWORK_BROWSER_CACHE = originalCache;
    }
});

test('runInstaller spawns the CLI and reports failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-spawn-'));
    const ok = path.join(root, 'ok.js');
    fs.writeFileSync(ok, 'process.exit(0)');
    await install.runInstaller(ok, root);
    const fail = path.join(root, 'fail.js');
    fs.writeFileSync(fail, 'console.error("download exploded");process.exit(3)');
    await assert.rejects(install.runInstaller(fail, root), /exit 3.*download exploded/);
});
