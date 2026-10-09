const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const source = path.resolve(__dirname, '../src/vscode/brainNative.ts');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-native-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = path.join(dir, 'workspace'); fs.mkdirSync(folder);
    const state = { selected: [{ scheme: 'file', fsPath: folder }], dialogs: [], commands: [] };
    const vscode = { window: { showOpenDialog: async options => { state.dialogs.push(options); return state.selected; } },
        Uri: { file: fsPath => ({ fsPath }) }, commands: { executeCommand: async (...args) => state.commands.push(args) } };
    const api = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: api, require: name => name === 'vscode' ? vscode : createRequire(source)(name) });
    const reopen = () => api.createBrainNative({ globalStorageUri: { fsPath: path.join(dir, 'profile') } });
    return { state, folder, reopen, call: reopen() };
}

test('native dialog grants persist; JSON round trips preserve binary files without a daemon', async t => {
    const { state, folder, call, reopen } = fixture(t);
    assert.equal((await call('roots')).length, 0);
    const grant = await call('pickFolder', { path: '/renderer/cannot/choose' });
    assert.equal(grant.path, fs.realpathSync(folder));
    assert.equal(state.dialogs[0].canSelectFolders, true);
    assert.equal(state.dialogs[0].canSelectFiles, false);
    const next = reopen();
    assert.equal((await next('roots'))[0].id, grant.id);
    const args = { rootId: grant.id, rel: 'nested/bytes.bin' };
    await next('file', { ...args, op: 'write', bytes: [0, 255, 128, 1] });
    assert.deepEqual(JSON.parse(JSON.stringify(await next('file', { ...args, op: 'read' }))).bytes, [0, 255, 128, 1]);
    assert.deepEqual((await next('file', { rootId: grant.id, op: 'search', query: 'BYTES' })).files, ['nested/bytes.bin']);
    await next('file', { ...args, op: 'reveal' });
    assert.equal(state.commands[0][0], 'revealFileInOS');
    await next('file', { ...args, op: 'delete' });
    assert.equal((await next('file', { ...args, op: 'stat' })).exists, false);
    await next('revokeFolder', { rootId: grant.id });
    await assert.rejects(next('file', { ...args, op: 'read' }), /not granted/);
});

test('cancel, closed views, remote URIs and ungranted paths never acquire grants', async t => {
    const { state, call, folder } = fixture(t);
    state.selected = undefined;
    assert.equal(await call('pickFolder'), null);
    state.selected = [{ scheme: 'file', fsPath: folder }];
    let checks = 0;
    assert.equal(await call('pickFolder', {}, () => ++checks === 1), null);
    assert.equal((await call('roots')).length, 0);
    state.selected = [{ scheme: 'vscode-remote', fsPath: folder }];
    await assert.rejects(call('pickFolder'), /local folder/);
    await assert.rejects(call('file', { op: 'read', rootId: folder, rel: 'secret' }), /not granted/);
    await assert.rejects(call('grant', { path: folder }), /Unsupported/);
});
