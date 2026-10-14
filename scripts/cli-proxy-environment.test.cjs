const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, file);
const {cliProxyEnvironment} = require('../src/core/cliProxyEnvironment.ts');
const settings = (server, enabled = '0x1') => `\n ProxyEnable REG_DWORD ${enabled}\n ProxyServer REG_SZ ${server}\n ProxyOverride REG_SZ *.internal;<local>\n`;
test('GUI-launched Gemini and login terminals inherit enabled Windows proxy without mutating the parent', () => {
    const env = {PATH:'original'};
    const result = cliProxyEnvironment(env, 'win32', () => settings('127.0.0.1:7890'));
    assert.equal(result.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(result.HTTP_PROXY, result.HTTPS_PROXY);
    assert.equal(result.NO_PROXY, 'localhost,127.0.0.1,::1,*.internal');
    assert.deepEqual(env, {PATH:'original'});
});
test('explicit proxy settings, including explicit empty values, bypass registry discovery', () => {
    for (const name of ['HTTP_PROXY','https_proxy','ALL_PROXY']) {
        for (const value of ['', 'http://custom:8080']) {
            const env = {[name]:value};
            assert.deepEqual(cliProxyEnvironment(env,'win32',()=>{throw new Error('must not read');}),env);
        }
    }
});
test('per-protocol proxies and existing bypass settings are preserved', () => {
    const result = cliProxyEnvironment({no_proxy:'private.test'},'win32',()=>settings('http=one:80;https=two:81;socks=three:82'));
    assert.equal(result.HTTP_PROXY,'http://one'); assert.equal(result.HTTPS_PROXY,'http://two:81');
    assert.equal(result.no_proxy,'private.test'); assert.equal(result.NO_PROXY,undefined);
});
test('disabled, PAC-only, unreadable and unsupported settings do not invent a proxy', () => {
    for (const read of [()=>settings('localhost:7890','0x0'),()=>'',()=>{throw new Error('unavailable');},()=>settings('socks=localhost:7890'),()=>settings('http://user:password@proxy:80')]) {
        assert.deepEqual(cliProxyEnvironment({},'win32',read),{});
    }
    assert.deepEqual(cliProxyEnvironment({},'darwin',()=>settings('localhost:7890')),{});
});

test('Antigravity and interactive login terminal receive the same proxy at process launch', {skip:process.platform !== 'win32'}, async t => {
    const cp = require('node:child_process'), Module = require('node:module');
    const path = require('node:path'), os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-proxy-test-'));
    const saved = Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(https?|all|no)_proxy$/i.test(key)));
    for (const key of Object.keys(saved)) delete process.env[key];
    const originalExec = cp.execFileSync, originalLoad = Module._load;
    let adapter;
    t.after(()=>{
        adapter?.close(); cp.execFileSync = originalExec; Module._load = originalLoad;
        for (const key of Object.keys(process.env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete process.env[key];
        Object.assign(process.env,saved); fs.rmSync(dir,{recursive:true,force:true});
    });
    cp.execFileSync = (file,args,options) => file === 'reg.exe' ? settings('127.0.0.1:17890') : originalExec(file,args,options);
    const fixture = path.join(dir,'cli.cjs');
    fs.writeFileSync(fixture, "if(process.env.HTTPS_PROXY!=='http://127.0.0.1:17890')process.exit(2); console.log('native-model\\tNative model');");
    const {AntigravityHarness} = require('../src/core/antigravityHarness.ts');
    adapter = new AntigravityHarness(path.join(dir,'cache'),process.execPath,[fixture]);
    assert.equal((await adapter.call('account/read')).account.type,'cli');
    let terminalEnv;
    Module._load = function(id,...rest) {
        if (id === 'node-pty') return {spawn(_command,_args,options) { terminalEnv=options.env; return {onData(){},onExit(){},cols:80,rows:24}; }};
        return originalLoad.call(this,id,...rest);
    };
    const {TerminalSessionManager} = require('../src/core/terminalSessions.ts');
    new TerminalSessionManager().create(dir,undefined,'test-owner');
    assert.equal(terminalEnv.HTTPS_PROXY,'http://127.0.0.1:17890');
    assert.equal(process.env.HTTPS_PROXY,undefined,'parent environment remains untouched');
});
