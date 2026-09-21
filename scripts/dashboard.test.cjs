const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const ts = require('typescript');

test('dashboard routes, script syntax, auth and admin Origin protection', async () => {
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
            server = await startHttpServer({ port, root: home, requireAuth });
            const base = `http://127.0.0.1:${port}`;
            const skillResponse = await fetch(base + '/dashboard/skills/keepwork-mcp-assistant/SKILL.md', { headers: { Origin: 'https://keepwork.com' } });
            assert.equal(skillResponse.status, 200);
            assert.equal(skillResponse.headers.get('access-control-allow-origin'), 'https://keepwork.com');
            const skill = await skillResponse.text();
            assert.match(skill, /name: keepwork-mcp-assistant/);
            assert.ok(skill.includes(base));
            assert.ok(!skill.includes(server.token));
            for (const route of ['/', '/dashboard', '/dashboard/']) {
                const response = await fetch(base + route);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
                const html = await response.text();
                assert.match(html, /Keepwork local MCP/);
                assert.match(html, /href="#history"/);
                assert.match(html, /id="view-history" hidden/);
                assert.match(html, /href="#dingtalk"/);
                assert.match(html, /id="view-dingtalk" hidden/);
                assert.match(html, /href="#api-docs"/);
                assert.ok(!html.includes(server.token));
                assert.ok(!html.includes(home));
                new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
            }
            for (const route of ['/admin/status', '/admin/history', '/admin/api-docs', '/admin/dingtalk']) {
                assert.equal((await fetch(base + route)).status, requireAuth ? 401 : 200);
                const headers = { Authorization: `Bearer ${server.token}`, Origin: base };
                const response = await fetch(base + route, { headers });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                if (route === '/admin/dingtalk') {
                    const ding = await response.json();
                    assert.equal(ding.ok, true);
                    assert.equal(ding.connected, false);
                    assert.equal(ding.connection, 'not-configured');
                    assert.ok(Array.isArray(ding.messages));
                    assert.ok(Array.isArray(ding.listeners));
                    assert.ok(!JSON.stringify(ding).includes(server.token));
                }
                if (route === '/admin/api-docs') {
                    const catalog = await response.json();
                    assert.ok(catalog.endpoints.length > 40);
                    assert.ok(catalog.endpoints.some(entry => entry.path === '/paracraft/{id}/query_scene'));
                    assert.ok(catalog.endpoints.some(entry => entry.path === '/admin/dingtalk'));
                    assert.ok(catalog.endpoints.every(entry => entry.example.includes(base)));
                    assert.ok(!JSON.stringify(catalog).includes(server.token));
                }
                assert.equal((await fetch(base + route, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
            }
            assert.equal((await fetch(base + '/admin/stop', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
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