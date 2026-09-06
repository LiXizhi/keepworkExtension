const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
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
