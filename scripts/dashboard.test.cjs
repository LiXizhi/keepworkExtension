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
            assert.doesNotMatch(skill, /listen_dingtalk_messages/);
            assert.ok(!skill.includes(server.token));
            const dingSkillResponse = await fetch(base + '/dashboard/skills/dingtalk/SKILL.md', { headers: { Origin: 'https://keepwork.com' } });
            assert.equal(dingSkillResponse.status, 404);
            const health = await (await fetch(base + '/health')).json();
            assert.equal('dingtalkApi' in health, false);
            for (const route of ['/admin/dingtalk', '/dingtalk/status']) {
                assert.equal((await fetch(base + route, { headers: { Authorization: `Bearer ${server.token}`, Origin: base } })).status, 404);
            }
            for (const route of ['/', '/dashboard', '/dashboard/']) {
                const response = await fetch(base + route);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
                const html = await response.text();
                assert.match(html, /Keepwork local MCP/);
                assert.match(html, /href="#history"/);
                assert.match(html, /id="view-history" hidden/);
                assert.doesNotMatch(html, /dingtalk/i);
                assert.match(html, /href="#api-docs"/);
                assert.ok(!html.includes(server.token));
                assert.ok(!html.includes(home));
                new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
            }
            for (const route of ['/admin/status', '/admin/history', '/admin/api-docs', '/admin/personas']) {
                assert.equal((await fetch(base + route)).status, requireAuth ? 401 : 200);
                const headers = { Authorization: `Bearer ${server.token}`, Origin: base };
                const response = await fetch(base + route, { headers });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                if (route === '/admin/api-docs') {
                    const catalog = await response.json();
                    assert.ok(catalog.endpoints.length > 40);
                    assert.ok(catalog.endpoints.some(entry => entry.path === '/paracraft/{id}/query_scene'));
                    assert.ok(!catalog.endpoints.some(entry => /dingtalk/i.test(entry.path)));
                    assert.ok(catalog.endpoints.every(entry => entry.example.includes(base)));
                    assert.ok(catalog.tools.some(entry => entry.name === 'run_terminal' && entry.inputSchema.properties.command));
                    assert.ok(catalog.tools.some(entry => entry.name === 'listen_dingtalk_messages'));
                    assert.ok(catalog.tools.some(entry => entry.name === 'paracraft_cli'));
                    assert.ok(catalog.tools.some(entry => entry.name === 'computer_use'));
                    assert.ok(catalog.tools.every(entry => entry.description && entry.inputSchema));
                    assert.deepEqual(catalog.skills.map(entry => entry.name), ['agent-cli-verify', 'keepwork-mcp-assistant', 'paracraft-create']);
                    assert.ok(catalog.skills.every(entry => entry.description && entry.uri.endsWith('/SKILL.md')));
                    assert.ok(catalog.references.some(entry => entry.name === 'agent-cli-install' && entry.description));
                    const status = await (await fetch(base + '/admin/status', { headers })).json();
                    assert.equal(status.clients.length, 0, 'Catalog discovery must not create dashboard clients');
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
test('Personas hash opens dashboard statistics and managed sessions in a real browser',async t=>{
    const Module=require('node:module'),{chromium}=require('playwright-core');
    const file=path.resolve(__dirname,'../src/mcp/dashboard.ts'),mod=new Module(file,module);
    mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
    const headlessFile=path.resolve(__dirname,'../src/core/headless.ts'),headless=new Module(headlessFile,module);
    headless._compile(ts.transpileModule(fs.readFileSync(headlessFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,headlessFile);
    const executablePath=headless.exports.resolveBrowser();if(!executablePath){t.skip('System Edge/Chrome unavailable');return;}
    const browser=await chromium.launch({executablePath,headless:true});
    try{
        const page=await browser.newPage();let empty=false;
        await page.route('**/*',route=>{
            const url=new URL(route.request().url());
            if(url.pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:mod.exports.dashboardHtml()});
            if(url.pathname==='/admin/status')return route.fulfill({json:{pid:1,port:8080,workspaceRoot:'fixture',uptimeMs:1000,clients:[]}});
            if(url.pathname==='/admin/personas')return route.fulfill({json:empty?{stats:{total:0,active:0,messages:0,enabledSchedules:0,sessions:0},personas:[],sessions:[]}:{stats:{total:1,active:1,messages:4,enabledSchedules:2,sessions:1},personas:[{id:'default-persona',name:'<img src=x onerror=alert(1)>',state:'running',executor:'keepwork',messages:4,unread:1,enabledSchedules:2,schedules:3,channels:1}],recentMessages:Array.from({length:51},(_,i)=>({id:String(i),direction:'in',relevant:i%2===0,time:Date.now(),channel:'fixture-channel',persona:'default-persona',profile:'corp:user',conversation:'chat',sender:'sender',state:'done',text:'<img src=x onerror=alert(1)> '+i,reply:'Reply '+i})),sessions:[{persona:'My assistant',id:'default-persona',kind:'Conversation',backend:'MCP',state:'running'}]}});
            return route.fulfill({status:404,body:'{}'});
        });
        await page.goto('http://127.0.0.1:8080/dashboard#personas');
        await page.locator('#personas table').waitFor();
        assert.equal(await page.locator('#view-personas').isVisible(),true);
        assert.match(await page.locator('#persona-stats').textContent(),/1 personas.*4 messages/);
        assert.match(await page.locator('#persona-sessions').textContent(),/default-persona.*Conversation.*MCP/);
        assert.equal(await page.locator('#personas img').count(),0);
        assert.equal(await page.locator('#persona-messages tbody tr').count(),50);
        assert.equal(await page.locator('#persona-messages img').count(),0);
        assert.match(await page.locator('#persona-messages').textContent(),/已回复/);
        await page.locator('#persona-messages details').first().locator('summary').click();
        assert.equal(await page.locator('#persona-messages details').first().getAttribute('open'),'');
        await page.locator('#messages-next').click();
        assert.equal(await page.locator('#persona-messages tbody tr').count(),1);
        assert.match(await page.locator('#persona-messages').textContent(),/Reply 50/);
        await page.locator('#messages-prev').click();
        assert.equal(await page.locator('#persona-messages tbody tr').count(),50);
        await page.locator('#messages-next').click();
        await page.locator('#messages-filter').selectOption('related');
        assert.equal(await page.locator('#persona-messages tbody tr').count(),26);
        assert.equal(await page.locator('#messages-prev').isDisabled(),true);
        assert.match(await page.locator('#messages-range').textContent(),/1–26/);
        await page.locator('#messages-filter').selectOption('all');
        assert.equal(await page.locator('#persona-messages tbody tr').count(),50);
        empty=true;await page.getByText('No personas managed by this service.',{exact:true}).waitFor();
        assert.equal(await page.locator('#persona-sessions table').count(),0);
        assert.equal(await page.locator('#persona-messages table').count(),0);
    }finally{await browser.close();}
});
