const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file);
const { AgentSessions } = require('../src/core/agentSessions.ts');
const { CodexHarness } = require('../src/core/codexHarness.ts');
const { AcpHarness } = require('../src/core/acpHarness.ts');
const { ClaudeHarness } = require('../src/core/claudeHarness.ts');
const resources = new Map();
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-modes-')); resources.set(dir, []);
    t.after(async () => { for (const resource of resources.get(dir)) resource.close(); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); resources.delete(dir); });
    return dir;
}
class Fake extends EventEmitter {
    calls = []; responses = [];
    async call(method, params) { this.calls.push({method, params}); return method === 'thread/start' ? {thread:{id:'thread'}} : method === 'turn/start' ? {turn:{id:'turn'}} : {}; }
    respond(id, result) { this.responses.push({id, result}); }
    close() {}
}
test('modes govern create, resume, per-turn access and approvals without replay', async t => {
    const dir = temp(t), fake = new Fake(), file = path.join(dir,'sessions.json');
    const manager = new AgentSessions(file, fake); resources.get(dir).push(manager);
    const session = await manager.create('owner', {conversationId:'chat', roots:[dir], mode:'ask'});
    manager.toolBridge.register('owner','chat',{pageId:'page',generation:'gen',instructions:'',revision:'one',tools:[{name:'host_command',description:'Mutating host command',inputSchema:{type:'object'}}]});
    manager.toolBridge.setBackend('owner','chat',[{name:'workspace_file',description:'Files',inputSchema:{type:'object'}}], async ()=>{assert.fail('Plan must not dispatch a write');});
    assert.equal(fake.calls[0].params.sandbox,'read-only');
    assert.equal(fake.calls[0].params.approvalPolicy,'on-request');
    const request = (id, extra={}) => fake.emit('request',{id,method:'item/commandExecution/requestApproval',params:{threadId:'thread',...extra}});
    const complete = () => fake.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
    await manager.turn(session.id,'owner',{requestId:'ask',text:'question',mode:'ask'});
    request('manual'); assert.equal(fake.responses.length,0);
    assert.equal((await manager.read(session.id,'owner')).pending.length,1);
    manager.respond(session.id,'owner',{id:'manual',decision:'decline'}); complete();
    await manager.turn(session.id,'owner',{requestId:'plan',text:'design',mode:'plan'});
    const plan = fake.calls.filter(c=>c.method==='turn/start').at(-1).params;
    assert.equal(plan.sandboxPolicy.type,'readOnly'); assert.match(plan.input[0].text,/AIChat Plan mode/);
    for (const [name,args] of [['run_terminal',{}],['host_command',{}],['workspace_file',{operation:'write'}]]) {
        const blocked = await manager.toolBridge.invoke('owner','chat',name,args);
        assert.equal(blocked.isError,true); assert.match(blocked.content[0].text,/current agent mode/);
    }
    assert.ok(!manager.toolBridge.list('owner','chat').some(tool=>tool.name==='host_command'));
    request('write'); assert.equal(fake.responses.at(-1).result.decision,'decline');
    request('read',{readOnly:true}); assert.equal(fake.responses.at(-1).result.decision,'accept'); complete();
    const restoredFake = new Fake(), restored = new AgentSessions(file, restoredFake); resources.get(dir).push(restored);
    await restored.read(session.id,'owner');
    assert.equal(restoredFake.calls.find(c=>c.method==='thread/resume').params.sandbox,'read-only');
    await restored.turn(session.id,'owner',{requestId:'craft',text:'execute',mode:'craft'});
    const craft = restoredFake.calls.find(c=>c.method==='turn/start').params;
    assert.deepEqual(craft.sandboxPolicy,{type:'dangerFullAccess'}); assert.equal(craft.approvalPolicy,'never'); assert.doesNotMatch(craft.input[0].text,/AIChat Plan mode/);
    restoredFake.emit('request',{id:'auto',method:'item/fileChange/requestApproval',params:{threadId:'thread'}});
    assert.equal(restoredFake.responses[0].result.decision,'accept');
    await restored.turn(session.id,'owner',{requestId:'craft',text:'execute',mode:'craft'});
    assert.equal(restoredFake.calls.filter(c=>c.method==='turn/start').length,1);
});
for (const [backend, flags] of [['codex',['--modes']], ['workbuddy',['--modes']], ['copilot',['--config-options','--mode-config']], ['claude',[]]]) {
    test(`${backend}: native plan and exit use provider mode API`, async t => {
        const dir = temp(t), log = path.join(dir,'rpc.jsonl');
        const fixture = path.join(__dirname,'fixtures',backend==='codex'?'fake-codex-session.cjs':backend==='claude'?'fake-claude.cjs':'fake-acp.cjs');
        const args = [fixture,...flags,'--log='+log,'--log-rpc'];
        const adapter = backend==='codex' ? new CodexHarness(process.execPath,args) : backend==='claude' ? new ClaudeHarness(dir,process.execPath,args) : new AcpHarness(backend,dir,process.execPath,args);
        resources.get(dir).push(adapter);
        const {thread} = await adapter.call('thread/start',{cwd:dir});
        assert.equal((await adapter.call('thread/mode/set',{threadId:thread.id,mode:'plan',model:'fixture'})).nativePlan,true);
        const exit = await adapter.call('thread/mode/set',{threadId:thread.id,mode:'craft',model:'fixture'});
        assert.equal(exit.nativePlan,false);
        await adapter.call('thread/mode/set',{threadId:thread.id,mode:'ask',model:'fixture'});
        const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
        if(backend==='codex') { assert.equal(exit.turnOverrides.collaborationMode.mode,'default'); assert.equal(exit.turnOverrides.collaborationMode.settings.developer_instructions,null); }
        else if(backend==='claude') assert.deepEqual(calls.filter(c=>c.request?.subtype==='set_permission_mode').map(c=>c.request.mode),['plan','default','default']);
        else if(backend==='workbuddy') assert.deepEqual(calls.filter(c=>c.method==='session/set_mode').map(c=>c.params.modeId),['plan','code','ask']);
        else assert.deepEqual(calls.filter(c=>c.params?.configId==='mode-config').map(c=>c.params.value),['plan','code','ask']);
    });
}
test('ACP without advertised planning returns fallback without sending an invented mode', async t => {
    const dir=temp(t), log=path.join(dir,'rpc.jsonl');
    const adapter=new AcpHarness('workbuddy',dir,process.execPath,[path.join(__dirname,'fixtures/fake-acp.cjs'),'--log='+log]);resources.get(dir).push(adapter);
    const {thread}=await adapter.call('thread/start',{cwd:dir});
    assert.equal((await adapter.call('thread/mode/set',{threadId:thread.id,mode:'plan'})).nativePlan,false);
    assert.doesNotMatch(fs.readFileSync(log,'utf8'),/session\/set_mode/);
});
