const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { promisify } = require('node:util');
const { compileFunction } = require('node:vm');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/core/folderBrowser.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { browseFolders, folderLocations, absoluteFolder } = mod.exports;

test('folder browser: shallow listing, hidden, filter, pagination, links and invalid targets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-folder-test-'));
    try {
        for (const name of ['Alpha', 'Beta', '.hidden', '中文 folder', 'Alpha/nested']) fs.mkdirSync(path.join(root, name), { recursive: true });
        fs.writeFileSync(path.join(root, 'not-a-folder.txt'), 'text');
        fs.symlinkSync(path.join(root, 'Alpha'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        const first = await browseFolders(root, { limit: 2 });
        assert.equal(first.entries.length, 2);
        assert.equal(first.total, 4);
        assert.equal(first.nextOffset, 2);
        const second = await browseFolders(root, { offset: first.nextOffset, limit: 2 });
        assert.equal(second.nextOffset, null);
        assert.equal(new Set([...first.entries, ...second.entries].map(e => e.path)).size, 4);
        const all = await browseFolders(root, { hidden: true });
        assert.equal(all.entries.length, 5);
        assert.equal(all.entries.find(e => e.name === '.hidden').hidden, true);
        assert.equal(all.entries.find(e => e.name === 'linked').symlink, true);
        assert.equal((await browseFolders(root, { filter: '中文' })).entries[0].name, '中文 folder');
        assert.equal((await browseFolders(path.join(root, 'linked'))).entries[0].name, 'nested');
        assert.equal(all.breadcrumbs.at(-1).path, root);
        assert.equal(all.parent, path.dirname(root));
        assert.throws(() => absoluteFolder('relative/path'));
        await assert.rejects(browseFolders(path.join(root, 'missing')));
        await assert.rejects(browseFolders(path.join(root, 'not-a-folder.txt')));
        assert.equal(absoluteFolder('~'), os.homedir());
    } finally {
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(root).startsWith('keepwork-folder-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('locations come from the daemon platform and include real home and roots', async () => {
    const result = await folderLocations();
    assert.equal(result.platform, process.platform);
    assert.equal(result.home, os.homedir());
    assert.equal(result.locations[0].id, 'home');
    assert.ok(result.volumes.length);
    for (const location of result.locations) assert.ok(fs.statSync(location.path).isDirectory());
});

function loadWindowsBrowser(arch, { elapsedMs = 0, hiddenNames = [], error } = {}) {
    const calls = [];
    function execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        // Model process completion against the supplied deadline without waiting.
        if (elapsedMs > options.timeout) {
            callback(Object.assign(new Error('PowerShell query timed out'), { killed: true }));
        } else if (error) {
            callback(error);
        } else {
            const result = options.env?.KEEPWORK_BROWSE_PATH
                ? hiddenNames : { folders: {}, drives: ['C:\\'] };
            callback(null, JSON.stringify(result), '');
        }
    }
    // execFile's real promisified API resolves both stdout and stderr.
    execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
        execFile(...args, (failure, stdout, stderr) => failure
            ? reject(failure) : resolve({ stdout, stderr }));
    });
    const isolated = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname', 'process'], { filename })(
        isolated.exports,
        name => name === 'node:child_process' ? { execFile } : require(name),
        isolated, filename, path.dirname(filename),
        { platform: 'win32', arch, env: { ...process.env } },
    );
    return { browser: isolated.exports, calls };
}

test('ARM64 Windows folder queries allow slow startup within a finite deadline', async () => {
    const { browser, calls } = loadWindowsBrowser('arm64', { elapsedMs: 15000 });
    assert.equal((await browser.folderLocations()).volumes[0].path, 'C:\\');
    assert.equal((await browser.browseFolders(os.tmpdir())).path, path.resolve(os.tmpdir()));
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.command, 'powershell.exe');
        assert.equal(call.options.timeout, 60000);
        assert.equal(call.options.windowsHide, true);
    }
});

test('Windows folder queries retain the x64 deadline and propagate timeout and query failures', async () => {
    for (const [arch, elapsedMs, timeout] of [['x64', 15000, 10000], ['arm64', 60001, 60000]]) {
        const { browser, calls } = loadWindowsBrowser(arch, { elapsedMs });
        for (const query of [() => browser.folderLocations(), () => browser.browseFolders(os.tmpdir())]) {
            await assert.rejects(query, failure => failure.killed === true && /timed out/.test(failure.message));
        }
        assert.equal(calls.length, 2);
        for (const call of calls) assert.equal(call.options.timeout, timeout);
    }
    const failure = new Error('Windows folder attribute query denied');
    const { browser } = loadWindowsBrowser('arm64', { error: failure });
    await assert.rejects(browser.folderLocations(), error => error === failure);
    await assert.rejects(browser.browseFolders(os.tmpdir()), error => error === failure);
});

test('slow ARM64 attribute queries preserve Windows hidden filtering and path-as-data', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-folder-attributes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['visible', 'attribute-hidden', '.dot-hidden']) fs.mkdirSync(path.join(root, name));
    const { browser, calls } = loadWindowsBrowser('arm64', { elapsedMs: 15000, hiddenNames: ['attribute-hidden'] });
    const visible = await browser.browseFolders(root);
    assert.deepEqual(visible.entries.map(entry => entry.name), ['visible']);
    const all = await browser.browseFolders(root, { hidden: true });
    assert.equal(all.entries.length, 3);
    assert.equal(all.entries.find(entry => entry.name === 'attribute-hidden').hidden, true);
    assert.equal(all.entries.find(entry => entry.name === '.dot-hidden').hidden, true);
    assert.equal(all.entries.find(entry => entry.name === 'visible').hidden, false);
    for (const call of calls) {
        assert.equal(call.options.env.KEEPWORK_BROWSE_PATH, root);
        assert.equal(call.args.some(argument => argument.includes(root)), false);
    }
});
