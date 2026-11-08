const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ts = require('typescript');

test('tray channels expose only device status and enforce dashboard authentication', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-dashboard-test-'));
    const oldHome = os.homedir;
    const oldLoader = require.extensions['.ts'];
    let server;
    try {
        os.homedir = () => home;
        require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
        const { startHttpServer } = require('../src/mcp/http.ts');
        for (const requireAuth of [true, false]) {
            const reservation = net.createServer();
            await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
            const port = reservation.address().port;
            await new Promise(resolve => reservation.close(resolve));
            const hostKind = requireAuth ? 'local-helper' : 'vscode-extension';
            const hostVersion = requireAuth ? '2.3.4' : undefined;
            server = await startHttpServer({ port, root: home, requireAuth, hostKind, hostVersion });
            const base = `http://127.0.0.1:${port}`;
            const dashboardHeaders = {Authorization: `Bearer ${server.token}`};
            const trayUrl = base + '/admin/channels?view=tray';
            assert.equal((await fetch(trayUrl, {headers:{Origin:'https://evil.example'}})).status, 403);
            if (requireAuth) assert.equal((await fetch(trayUrl)).status, 401);
            const traySnapshot = await (await fetch(trayUrl, {headers:dashboardHeaders})).json();
            assert.deepEqual(traySnapshot, { channels: [{channel:'dingtalk', bindings:[]}, {channel:'feishu', bindings:[]}], wechat:'unbound' });
            await server.close();
            server = undefined;
        }
    } finally {
        if (server) await server.close();
        os.homedir = oldHome;
        if (oldLoader) require.extensions['.ts'] = oldLoader; else delete require.extensions['.ts'];
        fs.rmSync(home, { recursive: true, force: true });
    }
});
