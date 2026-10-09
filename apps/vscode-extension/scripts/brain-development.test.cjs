const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const exportsForTest = {};
const source = fs.readFileSync(path.join(__dirname, '../src/vscode/brainDevelopment.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: exportsForTest, require, URL, fetch, AbortSignal });
const { selectBrainEntry, startBrainDevelopmentServer } = exportsForTest;

test('development uses local source; missing source and unreachable overrides fall back to /chat', async () => {
    const hosted = new URL('https://keepwork.com/chat'), local = new URL('http://127.0.0.1:3001/AIChat.html');
    const base = { override: '', development: true, hosted, validate: s => new URL(s), local: async () => local };
    assert.equal(await selectBrainEntry(base), local);
    assert.equal(await selectBrainEntry({ ...base, development: false, local: () => { throw Error('must not run'); } }), hosted);
    assert.equal(await selectBrainEntry({ ...base, local: async () => { throw Error('missing source'); } }), hosted);
    assert.equal(await selectBrainEntry({ ...base, override: local.href, probe: async () => false }), hosted);
    assert.equal((await selectBrainEntry({ ...base, override: local.href, probe: async () => true })).href, local.href);
    await assert.rejects(selectBrainEntry({ ...base, override: 'invalid', validate: () => { throw Error('invalid override'); } }), /invalid override/);
});

test('local server serves source without a build, confines paths, and closes cleanly', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-brain-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'AIChat.html'), '<title>Local AIChat</title>');
    fs.writeFileSync(path.join(directory, '.secret'), 'private');
    fs.writeFileSync(path.join(directory, 'app.js'), 'export const ready = true;');
    const server = await startBrainDevelopmentServer(directory, 0);
    t.after(() => server.dispose());
    assert.equal(server.url.hostname, '127.0.0.1');
    assert.equal(await (await fetch(server.url)).text(), '<title>Local AIChat</title>');
    assert.match((await fetch(new URL('app.js', server.url))).headers.get('content-type'), /javascript/);
    assert.equal((await fetch(new URL('.secret', server.url))).status, 404);
    assert.equal((await fetch(new URL('%2e%2e%5coutside.txt', server.url))).status, 404);
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    server.dispose();
    await assert.rejects(fetch(server.url));
});
