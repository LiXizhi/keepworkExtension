const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const ts = require('typescript');

test('dashboard routes, script syntax, auth and admin Origin protection', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-dashboard-test-'));
    const oldHome = os.homedir;
    const oldLoader = require.extensions['.ts'];
    let server;
    try {
        os.homedir = () => home;
        require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
        const { startHttpServer } = require('../src/mcp/http.ts');
        const { runtimeBuildInfo } = require('../src/core/runtimeBuildInfo.ts');
        const originalBuildInfo = { ...runtimeBuildInfo };
        t.after(() => Object.assign(runtimeBuildInfo, originalBuildInfo));
        Object.assign(runtimeBuildInfo, { version: '9.8.7', commit: 'a'.repeat(40), builtAt: '2026-10-19T12:34:56.000Z' });
        for (const requireAuth of [true, false]) {
            const reservation = net.createServer();
            await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
            const port = reservation.address().port;
            await new Promise(resolve => reservation.close(resolve));
            const hostKind = requireAuth ? 'local-helper' : 'vscode-extension';
            const hostVersion = requireAuth ? '2.3.4' : undefined;
            server = await startHttpServer({ port, root: home, requireAuth, hostKind, hostVersion });
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
            assert.equal(health.runtimeVersion, process.env.KEEPWORK_MCP_RUNTIME_VERSION || '9.8.7');
            assert.equal(health.runtimeCommit, process.env.KEEPWORK_MCP_RUNTIME_COMMIT || 'a'.repeat(40));
            assert.equal(health.runtimeBuiltAt, '2026-10-19T12:34:56.000Z');
            assert.equal(health.hostKind, hostKind);
            assert.equal(health.hostVersion, hostVersion);
            for (const field of ['execPath', 'entryPath', 'nodeVersion', 'platform', 'arch']) assert.equal(field in health, false);
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
                assert.match(html, /id="channel-status"/);
                assert.match(html, /href="#api-docs"/);
                assert.ok(!html.includes(server.token));
                assert.ok(!html.includes(home));
                new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
            }
            assert.equal((await fetch(base + '/admin/channels', {headers:{Origin:'https://evil.example'}})).status, 403);
            if(requireAuth)assert.equal((await fetch(base + '/admin/channels')).status,401);
            for (const route of ['/admin/status', '/admin/history', '/admin/api-docs', '/admin/personas']) {
                assert.equal((await fetch(base + route)).status, requireAuth ? 401 : 200);
                const headers = { Authorization: `Bearer ${server.token}`, Origin: base };
                const response = await fetch(base + route, { headers });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                if (route === '/admin/status') {
                    const status = await response.json();
                    for (const field of ['runtimeVersion', 'runtimeCommit', 'runtimeBuiltAt', 'hostKind', 'hostVersion']) {
                        assert.equal(status[field], health[field], field);
                    }
                    assert.equal(status.version, health.version);
                    assert.equal(status.nodeVersion, process.version);
                    assert.equal(status.platform, process.platform);
                    assert.equal(status.arch, process.arch);
                    assert.equal(status.execPath, process.execPath);
                    assert.equal(status.entryPath, path.resolve(process.argv[1]));
                    assert.ok(Number.isFinite(Date.parse(status.startedAt)));
                    assert.notEqual(status.startedAt, status.runtimeBuiltAt);
                    assert.ok(!JSON.stringify(status).includes(server.token));
                }
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
            const connectionUrl=base+'/admin/channels/connection';
            assert.equal((await fetch(connectionUrl,{method:'POST',headers:{Origin:'https://untrusted.example'},body:'{}'})).status,403);
            assert.equal((await fetch(connectionUrl,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,Origin:base},body:'{"id":"missing","action":"connect"}'})).status,400);
            const supervisorUrl = base + '/admin/channels/supervisor';
            assert.equal((await fetch(supervisorUrl, {method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);
            if(requireAuth)assert.equal((await fetch(supervisorUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"enabled":false}'})).status,401);
            const configHeaders={Authorization:`Bearer ${server.token}`,Origin:base,'Content-Type':'application/json'};
            assert.equal((await fetch(supervisorUrl,{method:'POST',headers:configHeaders,body:'{"enabled":"false"}'})).status,400);
            const configured=await fetch(supervisorUrl,{method:'POST',headers:configHeaders,body:'{"enabled":false}'});
            assert.equal(configured.status,200);assert.equal((await configured.json()).supervisor.enabled,false);
            assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.keepwork-mcp/config.json'),'utf8')).autoFollowImClients,false);
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
test('overview displays build identity, source and environment with safe legacy fallbacks', async t => {
    const Module = require('node:module'), { chromium } = require('playwright-core');
    function load(relative) {
        const file = path.resolve(__dirname, relative), mod = new Module(file, module);
        mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
        return mod.exports;
    }
    const executablePath = load('../src/core/headless.ts').resolveBrowser();
    if (!executablePath) { t.skip('System Edge/Chrome unavailable'); return; }
    const html = load('../src/mcp/dashboard.ts').dashboardHtml();
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let status = {
            version: '0.1.2', runtimeVersion: '9.8.7', runtimeCommit: 'a'.repeat(40), runtimeBuiltAt: '2026-10-19T12:34:56.000Z',
            hostKind: 'vscode-extension', nodeVersion: 'v24.19.0', platform: 'darwin', arch: 'arm64',
            execPath: '/usr/local/bin/node', entryPath: '/extensions/<img src=x onerror=alert(1)>/dist/cli.js',
            pid: 123, port: 8080, workspaceRoot: 'fixture', startedAt: '2026-10-20T01:00:00.000Z', uptimeMs: 1000, clients: [],
        };
        let followEnabled=true,channelEnabled=true;const supervisorWrites=[],connectionWrites=[];
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: html });
            if (url.pathname === '/admin/status') return route.fulfill({ json: status });
            if(url.pathname==='/admin/channels/connection'){const body=route.request().postDataJSON();connectionWrites.push(body);channelEnabled=body.action==='connect';return route.fulfill({json:{ok:true}});}
            if(url.pathname==='/admin/channels/supervisor'){const body=route.request().postDataJSON();supervisorWrites.push(body);followEnabled=body.enabled;return route.fulfill({json:{supervisor:{enabled:followEnabled}}});}
            if (url.pathname === '/admin/channels') return route.fulfill({json:{supervisor:{enabled:followEnabled,clients:{dingtalk:true,feishu:false,checkedAt:Date.now()},accounts:[]},channels:[
                {channel:'dingtalk',installed:true,checkedAt:Date.now(),accounts:[{profile:'corp:user',name:'<img src=x onerror=alert(1)>',organization:'示例公司',status:'expired',expiresAt:'2020-01-01T00:00:00Z',refreshExpiresAt:null}],bindings:[{id:'test-binding',profile:'corp:user',enabled:channelEnabled,status:channelEnabled?'listening':'stopped'}]},
                {channel:'feishu',installed:false,checkedAt:Date.now(),accounts:[],bindings:[],error:'CLI 未安装或不可访问'}
            ]}});
            return route.fulfill({ status: 404, body: '{}' });
        });
        const read = () => page.locator('#meta').evaluate(element =>
            Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling.textContent])));
        await page.goto('http://127.0.0.1:8080/dashboard#overview');
        await page.getByText('9.8.7', { exact: true }).waitFor();
        await page.locator('#channel-status .channel-card').nth(1).waitFor();
        assert.match(await page.locator('#channel-status').textContent(),/已过期/);
        assert.match(await page.locator('#channel-status').textContent(),/CLI 未提供/);
        assert.match(await page.locator('#channel-status').textContent(),/未绑定分身/);
        assert.equal(await page.locator('#channel-status img').count(),0);
        await page.screenshot({path:path.join(os.tmpdir(),'keepwork-channels-desktop.png'),fullPage:true});
        assert.equal(await page.locator('#follow-im-clients').isChecked(),true);
        await page.locator('#follow-im-clients').uncheck();
        await page.waitForFunction(()=>!document.querySelector('#follow-im-clients').disabled);
        assert.deepEqual(supervisorWrites,[{enabled:false}]);
        assert.equal(await page.locator('#follow-im-clients').isChecked(),false);
        assert.match(await page.locator('#supervisor-status').textContent(),/钉钉进程：运行中.*飞书进程：未运行/);
        assert.match(await page.locator('.channel-account').first().textContent(),/示例公司/);
        assert.equal(await page.locator('.channel-badge.connected').count(),1);
        await page.getByRole('button',{name:'断开连接',exact:true}).click();
        await page.getByRole('button',{name:'连接',exact:true}).waitFor();
        await page.getByRole('button',{name:'连接',exact:true}).click();
        await page.getByRole('button',{name:'断开连接',exact:true}).waitFor();
        assert.deepEqual(connectionWrites,[{id:'test-binding',action:'disconnect'},{id:'test-binding',action:'connect'}]);
        await page.locator('.channel-card details summary').first().click();
        await page.locator('#refresh').click();
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.channel-card details').first().getAttribute('open'),'');
        await page.locator('.channel-card details summary').first().click();
        const meta = await read();
        assert.equal(meta['MCP version / 版本'], '9.8.7');
        assert.equal(meta['Service API version'], '0.1.2');
        assert.match(meta['Built at / 构建时间'], /10\/19\/2026.*8:34:56.*GMT\+8/);
        assert.equal(meta['Source / 服务来源'], 'VS Code / Cursor 扩展');
        assert.equal(meta['Git commit / 提交'], 'a'.repeat(40));
        assert.equal(meta['Entry / 启动文件'], status.entryPath);
        assert.equal(meta['Node.js'], 'v24.19.0');
        assert.equal(meta.Platform, 'darwin / arm64');
        assert.equal(await page.locator('#meta img').count(), 0);
        for (const [kind, label] of [['local-helper', 'KP Local Helper'], ['standalone', 'Standalone / 独立运行时'], ['electron-node-runtime', 'AIChat Desktop / NodeRuntime']]) {
            status = { ...status, hostKind: kind, hostVersion: '2.3.4' };
            await page.locator('#refresh').click();
            await page.getByText(label, { exact: true }).waitFor();
            assert.equal((await read())['Host version / 宿主版本'], '2.3.4');
        }
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path:path.join(os.tmpdir(),'keepwork-channels-mobile.png'),fullPage:true});
        status = { version: '0.1.2', pid: 123, port: 8080, workspaceRoot: 'fixture', uptimeMs: 1000, clients: [] };
        await page.locator('#refresh').click();
        await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('Unknown / 未提供'));
        const legacy = await read();
        assert.equal(legacy['MCP version / 版本'], 'Unknown / 未提供');
        assert.equal(legacy['Built at / 构建时间'], 'Unknown / 未提供');
        assert.equal(legacy['Source / 服务来源'], 'Unknown / 未提供');
        assert.equal(legacy.Status, 'Running');
        await page.getByRole('button',{name:'AIChat 排查',exact:true}).click();
        assert.match(await page.locator('#chat-frame').getAttribute('src'),/channel%3Ddingtalk/);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
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
