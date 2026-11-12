const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { AgentSessions, ownerKey, workspacePrompt } = require('../src/core/agentSessions.ts');
const { CodexHarness } = require('../src/core/codexHarness.ts');
const { handleAgentHttp } = require('../src/mcp/agentHttp.ts');
class Fake extends EventEmitter {
    calls = []; responses = []; n = 0;
    async call(method, params) {
        this.calls.push({method, params});
        if (method === 'thread/start') return { thread: { id: `thread${++this.n}` } };
        if (method === 'thread/resume') return { thread: { turns: [{ items: [{ id: 'restored', type: 'agentMessage', text: 'persisted answer' }] }] } };
        if (method === 'turn/start') return { turn: { id: `turn${this.n}` } };
        if (method === 'config/read') return { config: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' } };
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'model/list') return { data: [{ id: 'model-fixture' }] };
        return {};
    }
    respond(id, result) { this.responses.push({id, result}); }
    close() { this.emit('exit'); }
}
function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-agents-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'repo'); fs.mkdirSync(root);
    const file = path.join(dir, 'state', 'sessions.json'), fake = new Fake(), manager = new AgentSessions(file, fake);
    t.after(() => manager.close());
    const owner = ownerKey('http://localhost', 'a'.repeat(32));
    return {dir, root, file, fake, manager, owner};
}

test('workspace context contains roots and user text without injecting encoding instructions, including resumed turns', async t => {
    const {root,file,manager,owner}=setup(t);
    assert.equal(workspacePrompt('list my TODO please', [root], ['My workspace']),
        `Workspace folders (primary first):\n1. My workspace: ${root}\n\nlist my TODO please`);
    const session=await manager.create(owner,{conversationId:'encoding',roots:[root]});
    const fake=new Fake(),resumed=new AgentSessions(file,fake);t.after(()=>resumed.close());
    await resumed.turn(session.id,owner,{requestId:'read-unicode',text:'Read unicode.md'});
    const prompt=fake.calls.find(c=>c.method==='turn/start').params.input[0].text;
    assert.doesNotMatch(prompt,/Windows text I\/O|OutputEncoding|Get-Content -Encoding/);
    assert.ok(prompt.endsWith('\n\nRead unicode.md'));
});
test('sessions survive reconnect/restart, remain owned, and replay snapshots without resubmission', async t => {
    const {root, file, fake, manager, owner} = setup(t);
    const session = await manager.create(owner, { conversationId: 'chat-a', roots: [root] });
    assert.equal((await manager.create(owner, { conversationId: 'chat-a', roots: [root] })).id, session.id);
    await assert.rejects(manager.read(session.id, 'wrong-owner'), /not found/);
    const input = {requestId:'one', text:'hello'};
    await manager.turn(session.id, owner, input);
    await manager.turn(session.id, owner, input);
    assert.equal(fake.calls.filter(c=>c.method==='turn/start').length, 1);
    const events = []; const off = manager.subscribe(session.id, owner, e=>events.push(e)); off();
    assert.equal(events[0].session.status, 'running');
    fake.emit('notification', {method:'item/started', params:{threadId:session.threadId, item:{id:'a', type:'agentMessage', text:''}}});
    fake.emit('notification', {method:'item/agentMessage/delta', params:{threadId:session.threadId, itemId:'a', delta:'answer'}});
    fake.emit('notification', {method:'turn/completed', params:{threadId:session.threadId, turn:{status:'completed'}}});
    const snapshot = await manager.read(session.id, owner);
    assert.equal(snapshot.items[0].text, 'answer'); assert.equal(snapshot.status, 'completed');
    const restartedFake = new Fake(), restarted = new AgentSessions(file, restartedFake); t.after(()=>restarted.close());
    assert.equal((await restarted.read(session.id, owner)).items[0].text, 'persisted answer');
    assert.equal(restartedFake.calls.filter(c=>c.method==='turn/start').length, 0);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('answer'), 'transcripts remain in provider storage');
});
test('overlapping roots warn without blocking concurrent turns; each session stays single-turn and Stop is independent', async t => {
    const {root, fake, manager, owner} = setup(t);
    const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
    const a = await manager.create(owner,{conversationId:'a', roots:[root,nested]});
    const b = await manager.create(owner,{conversationId:'b', roots:[nested]});
    await manager.turn(a.id,owner,{requestId:'a1',text:'go'});
    const result = await manager.turn(b.id,owner,{requestId:'b1',text:'go'});
    assert.equal(result.session.status, 'running');
    assert.deepEqual(result.warnings, [{code:'workspace_overlap',sessions:[{id:a.id,title:a.title}]}]);
    await assert.rejects(manager.turn(b.id,owner,{requestId:'b2',text:'go'}), /already running/);
    assert.equal((await manager.turn(b.id,owner,{requestId:'b1',text:'go'})).warnings, undefined, 'duplicate requests do not replay warnings');
    assert.equal(fake.calls.filter(c=>c.method==='turn/start').length, 2);
    assert.deepEqual(fake.calls.find(c=>c.method==='turn/start').params.sandboxPolicy, {type:'dangerFullAccess'});
    assert.equal(fake.calls.find(c=>c.method==='turn/start').params.approvalPolicy, 'never');
    assert.ok(fake.calls.find(c=>c.method==='turn/start').params.input[0].text.toLowerCase().includes(nested.toLowerCase()));
    await manager.interrupt(a.id,owner);
    assert.equal(fake.calls.at(-1).method,'turn/interrupt');
    fake.emit('notification',{method:'turn/completed',params:{threadId:a.threadId,turn:{status:'interrupted'}}});
    assert.equal((await manager.read(b.id,owner)).status, 'running');
    fake.emit('notification',{method:'turn/completed',params:{threadId:b.threadId,turn:{status:'completed'}}});
    assert.deepEqual((await manager.turn(b.id,owner,{requestId:'b2',text:'go'})).warnings, []);
});
test('Full access approves tools while questions remain interactive and cannot be answered twice', async t => {
    const {root, fake, manager, owner} = setup(t);
    const s = await manager.create(owner,{conversationId:'a',roots:[root]});
    await manager.turn(s.id,owner,{requestId:'a1',text:'go'});
    fake.emit('request',{id:8,method:'item/commandExecution/requestApproval',params:{threadId:s.threadId,command:'git status'}});
    assert.equal((await manager.read(s.id,owner)).status,'running');
    assert.deepEqual(fake.responses.at(-1),{id:8,result:{decision:'accept'}});
    fake.emit('request',{id:10,method:'item/fileChange/requestApproval',params:{threadId:s.threadId}});
    assert.deepEqual(fake.responses.at(-1),{id:10,result:{decision:'accept'}});
    fake.emit('request',{id:11,method:'item/permissions/requestApproval',params:{threadId:s.threadId,permissions:{network:{enabled:true}}}});
    assert.deepEqual(fake.responses.at(-1),{id:11,result:{permissions:{network:{enabled:true}},scope:'turn'}});
    fake.emit('request',{id:12,method:'unknown/requestApproval',params:{threadId:s.threadId}});
    assert.deepEqual(fake.responses.at(-1),{id:12,result:{decision:'decline'}});
    assert.throws(()=>manager.respond(s.id,owner,{id:8,decision:'accept'}),/expired/);
    fake.emit('request',{id:9,method:'item/tool/requestUserInput',params:{threadId:s.threadId,questions:[{id:'choice',question:'Choose'}]}});
    assert.equal((await manager.read(s.id,owner)).status,'waiting');
    manager.respond(s.id,owner,{id:9,answers:{choice:'one'}});
    assert.throws(()=>manager.respond(s.id,owner,{id:9,answers:{choice:'two'}}),/expired/);
    assert.deepEqual(fake.responses.at(-1).result,{answers:{choice:{answers:['one']}}});
    fake.close(); assert.equal(manager.list(owner)[0].status,'interrupted');
});
test('archive/removal never calls provider delete, missing roots and invalid owners fail', async t => {
    const {root, fake, manager, owner} = setup(t);
    assert.throws(()=>ownerKey('x','short'),/required/);
    await assert.rejects(manager.create(owner,{conversationId:'bad',roots:['relative']}));
    const s = await manager.create(owner,{conversationId:'a',roots:[root]});
    await manager.update(s.id,owner,{title:'New name',archived:true});
    assert.equal(manager.list(owner)[0].archived,true);
    await manager.update(s.id,owner,{archived:false});
    await manager.update(s.id,owner,{remove:true});
    assert.equal(manager.list(owner).length,0);
    assert.ok(!fake.calls.some(c=>c.method==='thread/delete'));
});
test('HTTP API validates owners and streams initial snapshots', async t => {
    const {root, manager} = setup(t), http = require('node:http');
    const server = http.createServer((req,res)=>void handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{server.closeAllConnections();server.close();});
    const base = `http://127.0.0.1:${server.address().port}/agents`, headers={Origin:'http://localhost','X-Agent-Owner':'a'.repeat(32),'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/sessions')).status,400);
    const s=await fetch(base+'/sessions',{method:'POST',headers,body:JSON.stringify({conversationId:'a',roots:[root]})}).then(r=>r.json());
    const abort = new AbortController();
    const stream=await fetch(base+`/sessions/${s.id}/events`,{headers,signal:abort.signal});
    const first=await stream.body.getReader().read(); assert.ok(new TextDecoder().decode(first.value).includes(s.id)); abort.abort();
    const post = (route, body) => fetch(base + route, {method:'POST',headers,body:JSON.stringify(body)});
    const b = await post('/sessions',{conversationId:'b',roots:[root]}).then(r=>r.json());
    assert.equal((await post(`/sessions/${s.id}/turns`,{requestId:'a1',text:'first'})).status,200);
    const simultaneous = await post(`/sessions/${b.id}/turns`,{requestId:'b1',text:'second'});
    assert.equal(simultaneous.status,200);
    assert.equal((await simultaneous.json()).warnings[0].sessions[0].id,s.id);
    assert.equal((await post(`/sessions/${b.id}/turns`,{requestId:'b2',text:'same session'})).status,400);
});
test('real stdio transport handles fragmented JSON and server requests', async t => {
    const harness = new CodexHarness(process.execPath,[path.join(__dirname,'fixtures','fake-codex.cjs')]);
    t.after(()=>harness.close());
    const notifications=[]; harness.on('notification',m=>notifications.push(m));
    harness.on('request',m=>harness.respond(m.id,{decision:'decline'}));
    assert.deepEqual(await harness.call('model/list'),{data:[{id:'fixture'}]});
    await harness.call('fixture/request');
    assert.ok(notifications.some(m=>m.method==='fixture/notice'));
    assert.deepEqual(await harness.call('fixture/unicode'),{text:'中文任务\n检查日历 📅'},'UTF-8 survives a chunk boundary inside a multibyte character');
});

test('large NDJSON snapshots keep streaming intermediate output and completion without Stop',async t=>{
    const {root,manager,fake}=setup(t),http=require('node:http');
    const owner=ownerKey('http://localhost','b'.repeat(32));
    const session=await manager.create(owner,{conversationId:'large-stream',roots:[root]});
    await manager.turn(session.id,owner,{requestId:'large-request',text:'large output'});
    const output='中文输出 '.repeat(25000);
    fake.emit('notification',{method:'item/started',params:{threadId:session.threadId,item:{id:'cmd',type:'commandExecution',status:'inProgress',command:'read fixture',aggregatedOutput:output}}});
    const server=http.createServer((req,res)=>void handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{server.closeAllConnections();server.close();});
    const abort=new AbortController();t.after(()=>abort.abort());
    const response=await fetch(`http://127.0.0.1:${server.address().port}/agents/sessions/${session.id}/events`,{headers:{Origin:'http://localhost','X-Agent-Owner':'b'.repeat(32)},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    const next=async()=>{
        for(;;){
            const end=buffer.indexOf('\n');
            if(end>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())return JSON.parse(line).session;continue;}
            const chunk=await reader.read();assert.equal(chunk.done,false,'stream must stay connected');buffer+=decoder.decode(chunk.value,{stream:true});
        }
    };
    assert.equal((await next()).items[0].aggregatedOutput,output);
    fake.emit('notification',{method:'item/started',params:{threadId:session.threadId,item:{id:'reply',type:'agentMessage',text:'中间消息'}}});
    assert.equal((await next()).items.at(-1).text,'中间消息');
    fake.emit('notification',{method:'turn/completed',params:{threadId:session.threadId,turn:{status:'completed'}}});
    assert.equal((await next()).status,'completed');
    assert.equal(fake.calls.filter(c=>c.method==='turn/interrupt').length,0);
});

test('Codex reasoning and answer deltas reach owned HTTP viewers before the turn completes',async t=>{
    const {root,manager,fake}=setup(t),http=require('node:http');
    const token='c'.repeat(32),owner=ownerKey('http://localhost',token);
    const session=await manager.create(owner,{conversationId:'reasoning-stream',roots:[root]});
    await manager.turn(session.id,owner,{requestId:'reasoning-request',text:'think and answer'});
    const server=http.createServer((req,res)=>void handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();server.close();});
    const base=`http://127.0.0.1:${server.address().port}/agents/sessions/${session.id}`;
    const headers={Origin:'http://localhost','X-Agent-Owner':token};
    const foreign=await fetch(base+'/events',{headers:{...headers,'X-Agent-Owner':'d'.repeat(32)}});
    assert.equal(foreign.status,400);
    assert.match((await foreign.json()).error,/not found/);
    const abort=new AbortController();t.after(()=>abort.abort());
    const response=await fetch(base+'/events',{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',cursor=-1;
    const next=async()=>{
        for(;;){
            const end=buffer.indexOf('\n');
            if(end>=0){
                const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
                const event=JSON.parse(line);assert.ok(event.cursor>cursor);cursor=event.cursor;return event.session;
            }
            const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value,{stream:true});
        }
    };
    const notify=(method,params)=>fake.emit('notification',{method,params:{threadId:session.threadId,...params}});
    const itemText=(view,id)=>view.items.find(item=>item.id===id)?.text;
    assert.equal((await next()).status,'running');
    notify('item/started',{item:{id:'thought',type:'reasoning',summary:[],content:[]}});
    await next();
    notify('item/reasoning/summaryPartAdded',{itemId:'thought',summaryIndex:0});
    await next();
    notify('item/reasoning/summaryTextDelta',{itemId:'thought',summaryIndex:0,delta:'先检查'});
    let view=await next();
    assert.equal(view.status,'running');assert.equal(itemText(view,'thought'),'先检查');
    notify('item/reasoning/summaryTextDelta',{itemId:'thought',summaryIndex:0,delta:'中文 📅'});
    view=await next();
    assert.equal(view.status,'running');assert.equal(itemText(view,'thought'),'先检查中文 📅');
    notify('item/reasoning/summaryPartAdded',{itemId:'thought',summaryIndex:1});
    await next();
    notify('item/reasoning/summaryTextDelta',{itemId:'thought',summaryIndex:1,delta:'再回复'});
    view=await next();assert.equal(itemText(view,'thought'),'先检查中文 📅\n\n再回复');
    notify('item/reasoning/textDelta',{itemId:'thought',contentIndex:0,delta:'原始思考'});
    view=await next();assert.equal(itemText(view,'thought'),'先检查中文 📅\n\n再回复','summary remains the displayed reasoning when raw content arrives');
    notify('item/completed',{item:{id:'thought',type:'reasoning',summary:['先检查中文 📅','再回复'],content:['原始思考']}});
    view=await next();assert.equal(itemText(view,'thought'),'先检查中文 📅\n\n再回复');
    assert.deepEqual(view.items.find(item=>item.id==='thought').summary,['先检查中文 📅','再回复']);
    assert.deepEqual(view.items.find(item=>item.id==='thought').content,['原始思考']);
    notify('item/started',{item:{id:'raw-thought',type:'reasoning',summary:[],content:[]}});await next();
    notify('item/reasoning/textDelta',{itemId:'raw-thought',contentIndex:0,delta:'只有原文'});
    view=await next();assert.equal(view.status,'running');assert.equal(itemText(view,'raw-thought'),'只有原文');
    notify('item/reasoning/textDelta',{itemId:'raw-thought',contentIndex:1,delta:'第二段'});
    view=await next();assert.equal(itemText(view,'raw-thought'),'只有原文\n\n第二段');
    notify('item/started',{item:{id:'command',type:'commandExecution',aggregatedOutput:''}});await next();
    notify('item/commandExecution/outputDelta',{itemId:'command',delta:'命令输出'});
    view=await next();assert.equal(view.items.find(item=>item.id==='command').aggregatedOutput,'命令输出');
    notify('item/started',{item:{id:'reply',type:'agentMessage',text:''}});await next();
    notify('item/agentMessage/delta',{itemId:'reply',delta:'你好'});
    view=await next();assert.equal(view.status,'running');assert.equal(itemText(view,'reply'),'你好');
    notify('item/agentMessage/delta',{itemId:'reply',delta:'，我在。'});
    view=await next();assert.equal(view.status,'running');assert.equal(itemText(view,'reply'),'你好，我在。');
    notify('turn/completed',{turn:{status:'completed'}});
    view=await next();assert.equal(view.status,'completed');assert.equal(itemText(view,'reply'),'你好，我在。');
    assert.equal(fake.calls.filter(call=>call.method==='turn/start').length,1,'stream progress never resubmits execution');
    assert.equal(fake.calls.filter(call=>call.method==='turn/interrupt').length,0);
});

test('Codex completed and restored reasoning preserves native fields with a readable legacy text projection',async t=>{
    const {root,file,manager,fake,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'reasoning-snapshots',roots:[root]});
    const cases=[
        {id:'summary',type:'reasoning',summary:['摘要一','摘要二'],content:['原文'],expected:'摘要一\n\n摘要二'},
        {id:'content',type:'reasoning',summary:[],content:['原文一','原文二'],expected:'原文一\n\n原文二'},
        {id:'legacy',type:'reasoning',text:'旧版思考',expected:'旧版思考'},
        {id:'future',type:'reasoning',summary:['可读摘要'],futureOptional:{enabled:true},expected:'可读摘要'},
        {id:'structured',type:'reasoning',summary:[{text:'结构化摘要'}],content:[{text:'结构化原文'}],expected:'结构化摘要'},
    ];
    for(const {expected,...item} of cases){
        fake.emit('notification',{method:'item/completed',params:{threadId:session.threadId,item}});
        const actual=(await manager.read(session.id,owner)).items.find(row=>row.id===item.id);
        assert.equal(actual.text,expected);
        for(const [key,value] of Object.entries(item))assert.deepEqual(actual[key],value);
    }
    const restoredFake=new Fake(),call=restoredFake.call.bind(restoredFake);
    restoredFake.call=(method,params)=>method==='thread/resume'?Promise.resolve({thread:{turns:[{items:cases.map(({expected,...item})=>item)}]}}):call(method,params);
    const restored=new AgentSessions(file,restoredFake);t.after(()=>restored.close());
    const view=await restored.read(session.id,owner);
    for(const {expected,...item} of cases){
        const actual=view.items.find(row=>row.id===item.id);
        assert.equal(actual.text,expected);
        for(const [key,value] of Object.entries(item))assert.deepEqual(actual[key],value);
    }
    assert.equal(restoredFake.calls.some(call=>call.method==='turn/start'),false,'restoring history cannot execute a turn');
});

test('Codex known deltas tolerate a missing or late item start without replacing streamed text',async t=>{
    const {root,manager,fake,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'reasoning-late-start',roots:[root]});
    await manager.turn(session.id,owner,{requestId:'late-start',text:'go'});
    const notify=(method,params)=>fake.emit('notification',{method,params:{threadId:session.threadId,...params}});
    notify('item/reasoning/summaryTextDelta',{itemId:'thought',summaryIndex:0,delta:'先收到思考'});
    assert.equal((await manager.read(session.id,owner)).items.find(item=>item.id==='thought')?.text,'先收到思考');
    notify('item/started',{item:{id:'thought',type:'reasoning',summary:[],content:[]}});
    assert.equal((await manager.read(session.id,owner)).items.find(item=>item.id==='thought')?.text,'先收到思考');
    notify('item/agentMessage/delta',{itemId:'reply',delta:'先收到正文'});
    assert.equal((await manager.read(session.id,owner)).items.find(item=>item.id==='reply')?.text,'先收到正文');
    notify('item/started',{item:{id:'reply',type:'agentMessage',text:''}});
    assert.equal((await manager.read(session.id,owner)).items.find(item=>item.id==='reply')?.text,'先收到正文');
    notify('item/futurePrivate/delta',{itemId:'unknown',delta:'未知数据'});
    assert.equal((await manager.read(session.id,owner)).items.some(item=>item.id==='unknown'),false,'unknown delta methods cannot invent visible item types');
});

test('Codex empty completions retain streamed items while nonempty final revisions replace them',async t=>{
    const {root,manager,fake,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'reasoning-completion-revisions',roots:[root]});
    await manager.turn(session.id,owner,{requestId:'completion-revisions',text:'go'});
    const notify=(method,params)=>fake.emit('notification',{method,params:{threadId:session.threadId,...params}});
    const read=async id=>(await manager.read(session.id,owner)).items.find(item=>item.id===id);
    notify('item/reasoning/summaryTextDelta',{itemId:'thought',summaryIndex:0,delta:'流式摘要'});
    notify('item/completed',{item:{id:'thought',type:'reasoning',summary:[],content:[],text:''}});
    assert.equal((await read('thought')).text,'流式摘要','an empty final shell cannot erase delivered reasoning');
    assert.deepEqual((await read('thought')).summary,['流式摘要']);
    notify('item/completed',{item:{id:'thought',type:'reasoning'}});
    assert.equal((await read('thought')).text,'流式摘要','omitted completion fields retain delivered reasoning');
    notify('item/completed',{item:{id:'thought',type:'reasoning',summary:['完成时修订的摘要']}});
    assert.equal((await read('thought')).text,'完成时修订的摘要','a nonempty final native summary is authoritative');
    notify('item/completed',{item:{id:'thought',type:'reasoning',text:'旧契约的最终思考'}});
    assert.equal((await read('thought')).text,'旧契约的最终思考','a legacy text-only completion must override the earlier native summary');
    notify('item/reasoning/textDelta',{itemId:'raw-thought',contentIndex:0,delta:'流式原文'});
    notify('item/completed',{item:{id:'raw-thought',type:'reasoning',content:[]}});
    assert.equal((await read('raw-thought')).text,'流式原文');
    notify('item/completed',{item:{id:'raw-thought',type:'reasoning',content:['最终原文']}});
    assert.equal((await read('raw-thought')).text,'最终原文');
    for(const {id,type,method,key} of [
        {id:'plan',type:'plan',method:'item/plan/delta',key:'text'},
        {id:'reply',type:'agentMessage',method:'item/agentMessage/delta',key:'text'},
        {id:'command',type:'commandExecution',method:'item/commandExecution/outputDelta',key:'aggregatedOutput'},
    ]){
        notify(method,{itemId:id,delta:'流式草稿'});
        notify('item/completed',{item:{id,type,[key]:''}});
        assert.equal((await read(id))[key],'流式草稿',`${type} empty completion retains delivered output`);
        notify('item/completed',{item:{id,type}});
        assert.equal((await read(id))[key],'流式草稿',`${type} omitted completion fields retain delivered output`);
        notify('item/completed',{item:{id,type,[key]:'完成时重写'}});
        assert.equal((await read(id))[key],'完成时重写',`${type} nonempty final output replaces the draft`);
    }
});

test('Codex multi-part reasoning stays bounded while retaining the newest Unicode part',async t=>{
    const {root,manager,fake,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'bounded-reasoning',roots:[root]});
    const latest='末段🙂'.repeat(20000);
    const notify=(summaryIndex,delta)=>fake.emit('notification',{method:'item/reasoning/summaryTextDelta',params:{threadId:session.threadId,itemId:'thought',summaryIndex,delta}});
    notify(0,'a'.repeat(100000));notify(1,latest);
    const item=(await manager.read(session.id,owner)).items.find(item=>item.id==='thought');
    assert.ok(item.summary.reduce((size,text)=>size+text.length,0)<=131072);
    assert.equal(item.summary[1],latest);
    assert.equal(item.summary[0].length,131072-latest.length);
    assert.ok(item.text.endsWith(latest));assert.ok(item.text.length<=131072);
});

test('slow event consumers coalesce to the latest snapshot and flush it on drain',async()=>{
    let push,unsubscribed=0;
    const manager={read:async()=>{},subscribe:(_id,_owner,listener)=>{push=listener;listener({cursor:1,session:{status:'running'}});return()=>unsubscribed++;}};
    const res=new EventEmitter();Object.assign(res,{destroyed:false,headersSent:false,writes:[],setHeader(){},writeHead(){this.headersSent=true;},write(text){this.writes.push(text);return this.writes.length!==1;},destroy(){this.destroyed=true;this.emit('close');},end(){this.emit('close');}});
    await handleAgentHttp({method:'GET',headers:{origin:'http://localhost','x-agent-owner':'a'.repeat(32)}},res,new URL('http://localhost/agents/sessions/s/events'),manager);
    for(let cursor=2;cursor<=100;cursor++)push({cursor,session:{status:cursor===100?'completed':'running'}});
    assert.equal(res.destroyed,false,'write(false) is normal backpressure');
    assert.equal(res.writes.length,1,'at most one snapshot is buffered in Node while blocked');
    res.emit('drain');
    assert.equal(res.writes.length,2);
    assert.equal(JSON.parse(res.writes[1]).cursor,100);
    push({closed:true});assert.equal(unsubscribed,1);
});

test('lost replies reconcile request IDs; uncertain sessions stay busy but only warn other sessions', async t => {
    const {root, fake, manager, owner} = setup(t);
    const a = await manager.create(owner,{conversationId:'a', roots:[root]});
    const b = await manager.create(owner,{conversationId:'b', roots:[root]});
    const call = fake.call.bind(fake);
    fake.call = async (method, params) => {
        if (method === 'turn/start') throw Object.assign(new Error('policy rejected'), {rpcRejected:true});
        return call(method, params);
    };
    await assert.rejects(manager.turn(a.id,owner,{requestId:'rejected',text:'go'}), e=>e.acceptanceUnknown===false);
    assert.equal((await manager.read(a.id,owner)).lastSubmission.state,'rejected');
    fake.call = async (method, params) => {
        if (method === 'turn/start') throw new Error('transport failed');
        return call(method, params);
    };
    await assert.rejects(manager.turn(b.id,owner,{requestId:'uncertain',text:'go'}), e=>e.acceptanceUnknown===true);
    fake.call = call;
    await assert.rejects(manager.turn(b.id,owner,{requestId:'next',text:'go'}),/already running/);
    const concurrent = await manager.turn(a.id,owner,{requestId:'next',text:'go'});
    assert.equal(concurrent.warnings[0].sessions[0].id, b.id);
    fake.emit('notification',{method:'turn/started',params:{threadId:b.threadId,turn:{id:'recovered'}}});
    assert.deepEqual((await manager.read(b.id,owner)).lastSubmission,{requestId:'uncertain',state:'accepted',turnId:'recovered'});
    const duplicate=await manager.turn(b.id,owner,{requestId:'uncertain',text:'go'});
    assert.equal(duplicate.submission.turnId,'recovered');
});

test('removal waits for interruption while sibling folders in one Git worktree run concurrently with a warning', async t => {
    const {root, fake, manager, owner} = setup(t);
    require('node:child_process').execFileSync('git',['init','--quiet',root],{windowsHide:true});
    const one=path.join(root,'one'),two=path.join(root,'two');fs.mkdirSync(one);fs.mkdirSync(two);
    const a=await manager.create(owner,{conversationId:'a',roots:[one]});
    const b=await manager.create(owner,{conversationId:'b',roots:[two]});
    await manager.turn(a.id,owner,{requestId:'a1',text:'go'});
    const concurrent = await manager.turn(b.id,owner,{requestId:'b1',text:'go'});
    assert.equal(concurrent.warnings[0].sessions[0].id, a.id);
    const call=fake.call.bind(fake);
    fake.call=async(method,params)=>{
        if(method==='turn/interrupt') setTimeout(()=>fake.emit('notification',{method:'turn/completed',params:{threadId:a.threadId,turn:{status:'interrupted'}}}),25);
        if(method==='thread/archive') assert.equal(manager.list(owner).find(s=>s.id===a.id).status,'interrupted');
        return call(method,params);
    };
    await manager.update(a.id,owner,{remove:true});
    assert.ok(!manager.list(owner).some(s=>s.id===a.id));
    assert.equal((await manager.read(b.id,owner)).status,'running');
});

test('unrelated roots do not warn; shared roots across owners warn without disclosing session identities', async t => {
    const {root, dir, manager, owner} = setup(t);
    const otherRoot = path.join(dir, 'other'); fs.mkdirSync(otherRoot);
    const a = await manager.create(owner, {conversationId:'a',roots:[root]});
    await manager.update(a.id,owner,{title:'Private title'});
    const otherOwner = ownerKey('http://localhost', 'b'.repeat(32));
    const b = await manager.create(otherOwner, {conversationId:'b',roots:[root]});
    const c = await manager.create(owner, {conversationId:'c',roots:[otherRoot]});
    const [first, second] = await Promise.all([
        manager.turn(a.id,owner,{requestId:'a1',text:'go'}),
        manager.turn(b.id,otherOwner,{requestId:'b1',text:'go'}),
    ]);
    assert.equal(first.session.status,'running');
    assert.equal(second.session.status,'running');
    assert.deepEqual(second.warnings,[{code:'workspace_overlap',sessions:[]}]);
    assert.ok(!JSON.stringify(second).includes('Private title'));
    assert.deepEqual((await manager.turn(c.id,owner,{requestId:'c1',text:'go'})).warnings,[]);
});

test('selected local file references resolve explicit roots and reject missing, global and outside paths', t => {
    const {root,dir} = setup(t);
    const second=path.join(dir,'second');fs.mkdirSync(second);
    fs.writeFileSync(path.join(root,'a.txt'),'a');fs.writeFileSync(path.join(second,'b.txt'),'b');
    const {canonicalRoot}=require('../src/core/agentSessions.ts');
    const roots=[root,second].map(canonicalRoot);
    const prompt=workspacePrompt('Read [#ref a.txt] and [#ref Other/b.txt]',roots,['Primary','Other']);
    assert.ok(prompt.includes(roots[0])&&prompt.includes(roots[1]));
    assert.ok(prompt.toLowerCase().includes(path.join(second,'b.txt').toLowerCase()));
    assert.throws(()=>workspacePrompt('[#ref .brain/private.md]',roots),/Global/);
    assert.throws(()=>workspacePrompt('[#ref missing.txt]',roots),/unavailable/);
    fs.writeFileSync(path.join(dir,'outside.txt'),'outside');
    assert.throws(()=>workspacePrompt('[#ref ../outside.txt]',roots),/outside/);
});

test('stdio crashes reject pending requests and restart handshakes without replaying them', async t => {
    const harness=new CodexHarness(process.execPath,[path.join(__dirname,'fixtures','fake-codex.cjs')]);
    t.after(()=>harness.close());
    await assert.rejects(harness.call('fixture/crash'),/stopped/);
    assert.deepEqual(await harness.call('model/list'),{data:[{id:'fixture'}]});
    const incompatible=new CodexHarness(process.execPath,[path.join(__dirname,'fixtures','fake-codex.cjs'),'--incompatible']);
    t.after(()=>incompatible.close());
    await assert.rejects(incompatible.call('model/list'),/Incompatible/);
});

test('Full Access and never are requested at creation, resume and each turn, including older sessions', async t => {
    const {root,file,fake,manager,owner}=setup(t);
    const call=fake.call.bind(fake);
    fake.call=async(method,params)=>{
        const result=await call(method,params);
        if(method==='thread/start') result.sandbox={type:'readOnly',networkAccess:false};
        return result;
    };
    const s=await manager.create(owner,{conversationId:'readonly',roots:[root]});
    await manager.turn(s.id,owner,{requestId:'one',text:'Inspect repository'});
    assert.equal(fake.calls.find(c=>c.method==='thread/start').params.sandbox,'danger-full-access');
    assert.equal(fake.calls.find(c=>c.method==='thread/start').params.approvalPolicy,'never');
    assert.deepEqual(fake.calls.find(c=>c.method==='turn/start').params.sandboxPolicy,{type:'dangerFullAccess'});
    assert.equal(fake.calls.find(c=>c.method==='turn/start').params.approvalPolicy,'never');
    const resumedFake=new Fake(), restarted=new AgentSessions(file,resumedFake);t.after(()=>restarted.close());
    await restarted.read(s.id,owner);
    assert.equal(resumedFake.calls.find(c=>c.method==='thread/resume').params.sandbox,'danger-full-access');
    assert.equal(resumedFake.calls.find(c=>c.method==='thread/resume').params.approvalPolicy,'never');
    await restarted.turn(s.id,owner,{requestId:'two',text:'Continue'});
    assert.equal(resumedFake.calls.find(c=>c.method==='turn/start').params.approvalPolicy,'never');
});

test('managed policy rejection is surfaced without retrying with a bypass or auto-approving', async t => {
    const {root,fake,manager,owner}=setup(t);
    const s=await manager.create(owner,{conversationId:'restricted',roots:[root]});
    const call=fake.call.bind(fake);let starts=0;
    fake.call=async(method,params)=>{
        if(method==='turn/start'){starts++;throw Object.assign(new Error('Full access disallowed by managed requirements'),{rpcRejected:true});}
        return call(method,params);
    };
    await assert.rejects(manager.turn(s.id,owner,{requestId:'one',text:'Run'}),/managed requirements/);
    assert.equal(starts,1);assert.equal(fake.responses.length,0);
    assert.equal((await manager.read(s.id,owner)).status,'error');
});

test('provider retry notices clear on resumed output and do not replace a pending question state', async t => {
    const {root,fake,manager,owner}=setup(t);
    const s=await manager.create(owner,{conversationId:'retry',roots:[root]});
    await manager.turn(s.id,owner,{requestId:'one',text:'Run'});
    fake.emit('notification',{method:'error',params:{threadId:s.threadId,willRetry:true,error:{message:'Reconnecting... 5/5'}}});
    assert.equal((await manager.read(s.id,owner)).retrying,true);
    fake.emit('notification',{method:'item/started',params:{threadId:s.threadId,item:{id:'a',type:'agentMessage',text:''}}});
    assert.equal((await manager.read(s.id,owner)).error,'');
    fake.emit('request',{id:22,method:'item/tool/requestUserInput',params:{threadId:s.threadId,questions:[{id:'choice',question:'Which file?'}]}});
    fake.emit('notification',{method:'error',params:{threadId:s.threadId,willRetry:true,error:{message:'Reconnecting... 1/5'}}});
    assert.equal((await manager.read(s.id,owner)).status,'waiting');
});

test('persistent command rules require exact native proposal, owner and live request',async t=>{
    const {root,fake,manager,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'persistent-policy',roots:[root],mode:'ask'});
    const decision={acceptWithExecpolicyAmendment:{execpolicy_amendment:['fixture-cli','send']}};
    const request={id:771,method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,command:'fixture-cli send --body hello',availableDecisions:['accept',decision,'cancel']}};
    fake.emit('request',request);
    assert.equal((await manager.read(session.id,owner)).pending[0].decisionCapabilities.execpolicyAmendment,true);
    const input={id:771,decision};
    assert.throws(()=>manager.respond(session.id,'other-owner',input),/not found/);
    for(const bad of [null,{},[],{acceptWithExecpolicyAmendment:{execpolicy_amendment:['fixture-cli']}},{acceptWithExecpolicyAmendment:{execpolicy_amendment:[]}},{...decision,other:true},{acceptWithExecpolicyAmendment:{execpolicy_amendment:['fixture-cli','send'],extra:true}}]) {
        assert.throws(()=>manager.respond(session.id,owner,{id:771,decision:bad}),/Persistent approval/);
        assert.equal((await manager.read(session.id,owner)).pending.length,1);
    }
    assert.equal(fake.responses.length,0);
    manager.respond(session.id,owner,input);
    assert.deepEqual(fake.responses,[{id:771,result:{decision}}]);
    assert.throws(()=>manager.respond(session.id,owner,input),/expired/);
    assert.equal(fake.responses.length,1);
    fake.emit('request',{...request,id:772,method:'item/fileChange/requestApproval'});
    assert.equal((await manager.read(session.id,owner)).pending[0].decisionCapabilities.execpolicyAmendment,false);
    assert.throws(()=>manager.respond(session.id,owner,{id:772,decision}),/Persistent approval/);
    manager.respond(session.id,owner,{id:772,decision:'cancel'});
    fake.emit('request',{...request,id:773,method:'item/permissions/requestApproval'});
    assert.throws(()=>manager.respond(session.id,owner,{id:773,decision}),/Invalid permission/);
    manager.respond(session.id,owner,{id:773,decision:'cancel'});
});

test('explicit automatic approval covers later native requests but not questions or mandatory decisions',async t=>{
    const {root,fake,manager,owner}=setup(t);
    const session=await manager.create(owner,{conversationId:'auto-approval',roots:[root],mode:'ask'});
    const emit=(id,method='item/commandExecution/requestApproval',extra={})=>fake.emit('request',{id,method,params:{threadId:session.threadId,command:'fixture',...extra}});
    emit(810);
    assert.throws(()=>manager.configureAutoApproval(session.id,'other',true),/not found/);
    manager.configureAutoApproval(session.id,owner,true);
    assert.deepEqual(fake.responses.at(-1),{id:810,result:{decision:'accept'}});
    emit(811,'item/fileChange/requestApproval');
    emit(812,'item/permissions/requestApproval',{permissions:{network:{enabled:true}}});
    assert.equal(fake.responses.length,3);
    emit(813,'item/tool/requestUserInput',{questions:[{id:'q',question:'Which target?'}]});
    emit(814,'item/commandExecution/requestApproval',{requiresUserDecision:true});
    emit(815,'item/commandExecution/requestApproval',{availableDecisions:['cancel']});
    assert.equal(fake.responses.length,3);
    assert.equal((await manager.read(session.id,owner)).pending.length,3);
    manager.configureAutoApproval(session.id,owner,false);emit(816);
    assert.equal(fake.responses.length,3);
    assert.equal((await manager.read(session.id,owner)).pending.length,4);
});

test('native Codex catalog and history do not resume; send resumes the original thread once', async t => {
    const {root,manager,owner,fake} = setup(t);
    const original = fake.call.bind(fake);
    let active = false;
    fake.call = async (method, params) => {
        if (method === 'thread/list') { fake.calls.push({method,params}); return {data:[{id:'native-one',cwd:root,name:'Terminal task',updatedAt:123}],nextCursor:'page-two'}; }
        if (method === 'thread/read') { fake.calls.push({method,params}); return {thread:{id:params.threadId,cwd:root,status:{type:active?'active':'idle'},turns:[{items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'original CLI prompt'}]}]}]}}; }
        return original(method,params);
    };
    const catalog = await manager.nativeCatalog(owner);
    assert.equal(catalog.sessions[0].updatedAt,123000); assert.equal(catalog.nextCursor,'page-two');
    const [a,b] = await Promise.all([manager.nativeSession(owner,'native-one'),manager.nativeSession(owner,'native-one')]);
    assert.equal(a.id,b.id); assert.equal(a.items[0].content[0].text,'original CLI prompt');
    assert.equal(fake.calls.filter(c=>c.method==='thread/resume').length,0);
    await assert.rejects(manager.nativeSession('other-owner','native-one'),/unavailable/);
    assert.equal((await manager.nativeCatalog('other-owner')).sessions.length,0);
    active=true; await manager.nativeSession(owner,'native-one');
    await assert.rejects(manager.turn(a.id,owner,{requestId:'busy',text:'continue'}),/already running/);
    active=false; await manager.nativeSession(owner,'native-one');
    await manager.turn(a.id,owner,{requestId:'native-send',text:'continue'});
    await manager.turn(a.id,owner,{requestId:'native-send',text:'continue'});
    assert.equal(fake.calls.filter(c=>c.method==='turn/start').length,1);
    assert.equal(fake.calls.find(c=>c.method==='thread/resume').params.threadId,'native-one');
    assert.equal(fake.calls.find(c=>c.method==='turn/start').params.threadId,'native-one');
});

test('native workspace metadata is additive, refreshable and does not alter legacy continuation roots', async t => {
    const {dir,root,manager,owner,fake}=setup(t), previous=process.env.CODEX_HOME;
    process.env.CODEX_HOME=dir;t.after(()=>{if(previous===undefined) delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
    fs.mkdirSync(path.join(dir,'sessions'));const extra=path.join(dir,'extra');fs.mkdirSync(extra);
    const rollout=path.join(dir,'sessions','native.jsonl');
    fs.writeFileSync(rollout,JSON.stringify({type:'session_meta',payload:{id:'native-roots',runtime_workspace_roots:[root,extra]}})+'\n');
    const original=fake.call.bind(fake);let modern=true;
    fake.call=async(method,params)=>{
        if(method==='thread/read'){fake.calls.push({method,params});return {thread:{id:params.threadId,cwd:root,...(modern?{path:rollout}:{}),turns:[]}};}
        return original(method,params);
    };
    let snapshot=await manager.nativeSession(owner,'native-roots');
    assert.deepEqual(snapshot.roots,[fs.realpathSync(root)]);
    assert.deepEqual(snapshot.nativeWorkspace.roots,[fs.realpathSync(root),fs.realpathSync(extra)]);
    assert.equal(snapshot.nativeWorkspace.complete,true);
    assert.equal(fake.calls.some(c=>c.method==='thread/resume'),false);
    modern=false;snapshot=await manager.read(snapshot.id,owner);
    assert.equal(snapshot.nativeWorkspace.complete,false);
    assert.deepEqual(snapshot.nativeWorkspace.roots,snapshot.roots);
    await manager.turn(snapshot.id,owner,{requestId:'legacy-shape',text:'continue'});
    assert.equal(fake.calls.find(c=>c.method==='turn/start').params.cwd,fs.realpathSync(root));
});
