const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ts = require('typescript');

test('folder HTTP capability, Origin, auth, listing and missing paths', async () => {
    const tmp = os.tmpdir();
    const home = fs.mkdtempSync(path.join(tmp, 'keepwork-folder-http-test-'));
    const oldHome = os.homedir;
    const oldLoader = require.extensions['.ts'];
    let server;
    try {
        // Keep daemon instance/token/calendar state isolated from the running user daemon.
        os.homedir = () => home;
        require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
        const { startHttpServer } = require('../src/mcp/http.ts');
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        server = await startHttpServer({ port, root: home, requireAuth: true });
        const base = `http://127.0.0.1:${port}`;
        const headers = { Origin: 'http://localhost:5500', Authorization: `Bearer ${server.token}` };
        const health = await (await fetch(base + '/health')).json();
        assert.equal(health.folderBrowserApi, 'folders-v1');
        assert.equal((await fetch(base + '/fs/locations')).status, 401);
        assert.equal((await fetch(base + '/fs/locations', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
        const locations = await fetch(base + '/fs/locations', { headers });
        assert.equal(locations.status, 200);
        assert.equal(locations.headers.get('cache-control'), 'no-store');
        assert.equal((await locations.json()).home, home);
        const listing = await fetch(base + '/fs/browse?path=' + encodeURIComponent(home), { headers });
        assert.equal(listing.status, 200);
        assert.equal((await listing.json()).path, home);
        const missing = await fetch(base + '/fs/browse?path=' + encodeURIComponent(path.join(home, 'missing')), { headers });
        assert.equal(missing.status, 400);
    } finally {
        if (server) await server.close();
        os.homedir = oldHome;
        if (oldLoader) require.extensions['.ts'] = oldLoader; else delete require.extensions['.ts'];
        assert.ok(path.resolve(home).startsWith(path.resolve(tmp) + path.sep));
        assert.ok(path.basename(home).startsWith('keepwork-folder-http-test-'));
        fs.rmSync(home, { recursive: true, force: true });
    }
});
