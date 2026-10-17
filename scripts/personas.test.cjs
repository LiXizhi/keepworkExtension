const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
function moduleFor(mocks){const file=path.resolve(__dirname,'../src/core/personas.ts'),m=new Module(file,module);m.filename=file;m.paths=module.paths;m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
function fixture(t,backend='keepwork'){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'personas-test-')),pending=[],calls=[];
    let client={defaultExecutor:{backend,model:'preferred'},token:'owner-login'};
    const {Personas,nextPersonaRun}=moduleFor({'./aichatPresence':{latestAichatClient:owner=>owner==='owner'?client:null},'./messagingPolicy':{defaultMessageConfig:()=>({}),knowledgeContext:()=>''},'./terminal':{runTerminal:async opts=>{calls.push(opts);return {ok:true};}}});
    const callbacks=new Map();const sessions={async create(owner,input){calls.push({owner,input});return {id:'native'};},subscribe(id,owner,fn){callbacks.set(id,fn);return()=>callbacks.delete(id);},async turn(id,owner,input){calls.push({owner,input});callbacks.get(id)?.({session:{status:'running',pending:[]}});},async interrupt(){callbacks.get('native')?.({session:{status:'interrupted'}});},respond(id,owner,input){calls.push({owner,input});}};
    const messaging={setAgentPrompt:()=>{},agentBindings:()=>[],detachAgent:()=>{},assertAgentBinding:()=>{},inboxView:()=>({conversations:[]}),workers:{answer(input,signal,login,executeTool){if(!login)return Promise.reject(Error('需要登录 AIChat'));return new Promise((resolve,reject)=>{pending.push({input,resolve,reject,executeTool});signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});}}};
    const service=new Personas(home,sessions,messaging);t.after(async()=>{service.close();await new Promise(r=>setImmediate(r));fs.rmSync(home,{recursive:true,force:true});});
    service.upsert('owner',{id:'first',name:'我的分身',root:home,executor:'auto'});
    return {service,home,pending,calls,callbacks,nextPersonaRun,Personas,sessions,messaging,setClient:value=>{client=value;}};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('one long conversation, owner isolation, idempotent submission and final-only transcript',async t=>{
    const f=fixture(t);f.service.submit('owner','first',{requestId:'message-1',text:'hello'});f.service.submit('owner','first',{requestId:'message-1',text:'hello'});
    assert.equal(f.pending.length,1);assert.throws(()=>f.service.read('other','first'));
    assert.throws(()=>f.service.submit('owner','first',{requestId:'message-2',text:'second'}),/上一项/);
    f.pending[0].resolve('final');await tick();assert.deepEqual(f.service.read('owner','first').messages.map(m=>m.text),['hello','final']);
    f.service.submit('owner','first',{requestId:'message-1',text:'hello'});assert.equal(f.pending.length,1);
    f.service.upsert('owner',{id:'second',name:'另一个分身'});assert.equal(f.service.read('owner','second').messages.length,0);
});
test('selected CLI uses isolated internal owner and exposes approvals but not tool/reasoning messages',async t=>{
    const f=fixture(t,'workbuddy');f.service.submit('owner','first',{requestId:'cli-run',text:'read'});await tick();
    assert.equal(f.calls[0].input.backend,'workbuddy');assert.equal(f.calls[0].input.model,'preferred');assert.equal(f.calls[0].input.mode,'ask');assert.notEqual(f.calls[0].owner,'owner');
    f.callbacks.get('native')({session:{status:'waiting',pending:[{id:1,method:'approval'}]}});assert.equal(f.service.read('owner','first').job.state,'waiting');
    f.callbacks.get('native')({session:{status:'completed',items:[{type:'reasoning',text:'secret thought'},{type:'commandExecution',text:'hidden command'},{type:'agentMessage',text:'answer'}]}});await tick();
    assert.deepEqual(f.service.read('owner','first').messages.map(m=>m.text),['read','answer']);assert.equal(f.pending.length,0);
});
test('owner fallback writes require approval; cancellation and path escape fail closed',async t=>{
    const f=fixture(t);f.service.submit('owner','first',{requestId:'write',text:'write'});const worker=f.pending[0];
    await assert.rejects(worker.executeTool('read_file',{path:'../outside'}),/outside/);
    const write=worker.executeTool('write_file',{path:'result.txt',content:'approved'});assert.equal(fs.existsSync(path.join(f.home,'result.txt')),false);
    const approval=f.service.read('owner','first').job.pending[0];f.service.respond('owner','first',{id:approval.id,decision:'accept'});await write;assert.equal(fs.readFileSync(path.join(f.home,'result.txt'),'utf8'),'approved');
    const denied=worker.executeTool('write_file',{path:'denied.txt',content:'no'});await f.service.cancel('owner','first');await assert.rejects(denied);await tick();assert.equal(fs.existsSync(path.join(f.home,'denied.txt')),false);
});
test('daily scheduling honors timezone and does not replay missed or overlapping work',async t=>{
    const f=fixture(t);assert.equal(new Date(f.nextPersonaRun('09:00','Asia/Shanghai',Date.parse('2026-10-16T00:00:00Z'))).toISOString(),'2026-10-16T01:00:00.000Z');
    assert.throws(()=>f.nextPersonaRun('25:00','UTC'));
    f.service.schedule('owner','first',{id:'daily',title:'daily',prompt:'task',time:'09:00',timezone:'UTC',enabled:true});let s=f.service.read('owner','first').schedules[0];
    f.service.tick(s.next+120000);assert.equal(f.pending.length,0);
    s=f.service.read('owner','first').schedules[0];f.service.tick(s.next);assert.equal(f.pending.length,1);f.service.tick(s.next);assert.equal(f.pending.length,1);
    const next=f.service.read('owner','first').schedules[0].next;f.service.tick(next);assert.equal(f.pending.length,1);assert.match(f.service.read('owner','first').schedules[0].last,/跳过/);
});
test('restart retains transcript, marks interrupted work unknown and never resubmits',async t=>{
    const f=fixture(t);f.service.submit('owner','first',{requestId:'restart',text:'pending'});
    const second=new f.Personas(f.home,f.sessions,f.messaging);t.after(()=>second.close());assert.equal(second.read('owner','first').job.state,'unknown');
    second.submit('owner','first',{requestId:'restart',text:'pending'});assert.equal(f.pending.length,1);
});
test('history pagination, read state, bounded context and deletion during execution',async t=>{
    const f=fixture(t);for(let i=0;i<28;i++){f.service.submit('owner','first',{requestId:'m'+i,text:'q'+i});f.pending.at(-1).resolve('a'+i);await tick();}
    const page=f.service.read('owner','first');assert.equal(page.messages.length,50);assert.equal(f.service.read('owner','first',page.before).messages.length,6);assert.ok(page.unread>0);f.service.markRead('owner','first');
    assert.ok(f.pending.at(-1).input.history.length<=16);assert.ok(f.pending.at(-1).input.prompt.length<16000);
    f.service.submit('owner','first',{requestId:'delete',text:'pending'});await f.service.remove('owner','first');await tick();assert.equal(f.service.list('owner').length,0);assert.equal(fs.readdirSync(f.home).filter(x=>x.endsWith('.json')).length,0);
});
test('missing account login never uses another account worker credential',async t=>{
    const f=fixture(t);f.setClient(null);f.service.submit('owner','first',{requestId:'login',text:'hi'});await tick();assert.equal(f.service.read('owner','first').job.state,'needs-login');assert.equal(f.pending.length,0);
});
