const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

test('directory requests open the containing folder in the OS, including legacy dir=1', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-reveal-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, '备课 materials');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'lesson-plan.md'), '');
    fs.writeFileSync(path.join(root, 'index.md'), '');

    const previous = require.extensions['.ts'];
    t.after(() => { if (previous) require.extensions['.ts'] = previous; else delete require.extensions['.ts']; });
    require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, filename);

    const launches = [];
    const bridge = t.mock.method(require('../src/core/vscodeBridge.ts'), 'tryRevealInVscode', async () => true);
    let failLaunch = false;
    t.mock.method(childProcess, 'spawn', (command, args) => {
        launches.push({ command, args });
        const proc = new EventEmitter();
        proc.unref = () => {};
        process.nextTick(() => failLaunch ? proc.emit('error', Error('File manager unavailable')) : proc.emit('spawn'));
        return proc;
    });
    const { tryHandleFs } = require('../src/core/fsServe.ts');
    async function request(method, rel, query) {
        const url = new URL('/fs/reveal', 'http://localhost');
        url.search = new URLSearchParams({ root, path: rel, ...query });
        let response;
        assert.equal(await tryHandleFs({ method, url, pathname: url.pathname, sendJson: (status, body) => { response = { status, body }; } }), true);
        return response;
    }

    const launcher = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
    for (const [method, rel, query, dir] of [
        ['POST', '备课 materials/lesson-plan.md', { mode: 'dir' }, nested],
        ['GET', 'index.md', { dir: '1' }, root],
        ['POST', '备课 materials', { mode: 'dir' }, nested],
        ['GET', '', { mode: 'dir' }, root],
    ]) {
        assert.deepEqual(await request(method, rel, query), { status: 200, body: { ok: true, rel, via: 'os', mode: 'dir' } });
        assert.deepEqual(launches.pop(), { command: launcher, args: [dir] });
    }
    assert.equal(bridge.mock.callCount(), 0);
    assert.equal((await request('GET', 'missing.txt', { mode: 'dir' })).status, 404);
    assert.equal((await request('POST', '../index.md', { mode: 'dir' })).status, 400);
    assert.equal(launches.length, 0);
    const plain = await request('GET', 'index.md', {});
    assert.deepEqual(plain, { status: 200, body: { ok: true, rel: 'index.md', via: 'vscode', mode: 'reveal' } });
    assert.equal(bridge.mock.calls[0].arguments[0], path.join(root, 'index.md'));
    failLaunch = true;
    const failed = await request('POST', 'index.md', { mode: 'dir' });
    assert.equal(failed.body.ok, false);
    assert.match(failed.body.error, /File manager unavailable/);
    assert.equal(launches.length, 1);
});
