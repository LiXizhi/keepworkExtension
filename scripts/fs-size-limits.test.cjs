const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const ts = require('typescript');

test('local file HTTP reads and writes exceed the former 16 MB cap while enforcing PPT 100 MiB and other files 1 GiB', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-fs-limit-'));
    const oldHome = os.homedir;
    const oldLoader = require.extensions['.ts'];
    let server;
    try {
        os.homedir = () => home;
        require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText, filename);
        const { startHttpServer } = require('../src/mcp/http.ts');
        const { localFileSizeLimit } = require('../src/core/fsServe.ts');
        assert.equal(localFileSizeLimit('课程.PPTX'), 100 * 1024 * 1024);
        assert.equal(localFileSizeLimit('课程.ppt'), 100 * 1024 * 1024);
        assert.equal(localFileSizeLimit('archive.bin'), 1024 * 1024 * 1024);
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        server = await startHttpServer({ port, root: home, requireAuth: true });
        const headers = { Origin: 'http://localhost:5500', Authorization: `Bearer ${server.token}` };
        const url = name => `http://127.0.0.1:${port}/fs/file?` + new URLSearchParams({ root: home, path: name, links: 'include' });
        const payload = Buffer.alloc(17 * 1024 * 1024, 0x5a);
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        for (const name of ['桂花雨.PPTX', 'nested/large.bin']) {
            const saved = await fetch(url(name), { method: 'PUT', headers, body: payload });
            assert.equal(saved.status, 200, await saved.text());
            const read = await fetch(url(name), { headers });
            assert.equal(read.status, 200);
            assert.equal(Number(read.headers.get('content-length')), payload.length);
            assert.equal(digest(Buffer.from(await read.arrayBuffer())), digest(payload));
        }
        for (const [name, limit] of [['oversize.pptx', 100 * 1024 * 1024], ['oversize.bin', 1024 * 1024 * 1024]]) {
            fs.writeFileSync(path.join(home, name), '');
            fs.truncateSync(path.join(home, name), limit + 1);
            const read = await fetch(url(name), { headers });
            assert.equal(read.status, 400);
            assert.match((await read.json()).error, new RegExp(`max ${limit / 1024 / 1024} MiB`));
        }
        const untrusted = await fetch(url('桂花雨.PPTX'), { headers: { ...headers, Origin: 'https://untrusted.example' } });
        assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
        await untrusted.body.cancel();
        const escaped = await fetch(url('../outside.pptx'), { headers });
        assert.equal(escaped.status, 400);
        await escaped.arrayBuffer();
    } finally {
        if (server) await server.close();
        os.homedir = oldHome;
        if (oldLoader) require.extensions['.ts'] = oldLoader; else delete require.extensions['.ts'];
        fs.rmSync(home, { recursive: true, force: true });
    }
});
