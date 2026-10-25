const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
function moduleFor(mocks){const file=path.resolve(__dirname,'../src/core/personas.ts'),m=new Module(file,module);m.filename=file;m.paths=module.paths;m.require=id=>{if(Object.hasOwn(mocks,id))return mocks[id];if(['./personaMessaging','./agentRolePolicy'].includes(id)){const f=path.resolve(__dirname,'../src/core',id.slice(2)+'.ts'),c=new Module(f,module);c.filename=f;c.paths=module.paths;c.require=m.require;c._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);return c.exports;}return require(id);};m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
function fixture(t,backend='keepwork'){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'personas-test-')),pending=[],calls=[];
    let client={defaultExecutor:{backend,model:'preferred'},token:'owner-login'};
    const {Personas,nextPersonaRun}=moduleFor({'./aichatRuntime':{createMcpAgentRuntime:()=>{throw Error('test must inject runtime');}},'./aichatPresence':{latestAichatBrainRoot:()=>home,latestAichatClient:owner=>owner==='owner'?client:null},'./messagingPolicy':{defaultMessageConfig:()=>({}),knowledgeContext:()=>''},'./terminal':{runTerminal:async opts=>{calls.push(opts);return {ok:true};}}});
    const callbacks=new Map();const sessions={async create(owner,input){calls.push({owner,input});return {id:'native'};},subscribe(id,owner,fn){callbacks.set(id,fn);return()=>callbacks.delete(id);},async turn(id,owner,input){calls.push({owner,input});callbacks.get(id)?.({session:{status:'running',pending:[]}});},async interrupt(){callbacks.get('native')?.({session:{status:'interrupted'}});},respond(id,owner,input){calls.push({owner,input});}};
    const messaging={setAgentRootResolver:resolve=>{messaging.resolveRoot=resolve;},watch:()=>()=>{},setAgentPrompt:()=>{},agentBindings:()=>[],detachAgent:()=>{},assertAgentBinding:()=>{},inboxView:()=>({conversations:[]}),workers:{answer(input,signal,login,executeTool){if(!login)return Promise.reject(Error('需要登录 AIChat'));return new Promise((resolve,reject)=>{pending.push({input,resolve,reject,executeTool});signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});}}};
    const factory=(login,executeTool)=>({close(){},answer(input,signal){return messaging.workers.answer(input,signal,login,(name,args)=>executeTool(name,args,signal));}});
    const service=new Personas(home,sessions,messaging,factory);t.after(async()=>{service.close();await new Promise(r=>setImmediate(r));fs.rmSync(home,{recursive:true,force:true});});
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
    const approval=f.service.read('owner','first').job.pending[0];assert.throws(()=>f.service.respond('owner','first',{id:approval.id,decision:{acceptWithExecpolicyAmendment:{execpolicy_amendment:['write_file']}}}),/仅支持单次授权/);assert.equal(f.service.read('owner','first').job.pending.length,1);f.service.respond('owner','first',{id:approval.id,decision:'accept'});await write;assert.equal(fs.readFileSync(path.join(f.home,'result.txt'),'utf8'),'approved');
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

test('clear context is owner scoped, persistent, preserves schedules and dedup, and starts fresh',async t=>{
    const f=fixture(t);
    f.service.schedule('owner','first',{id:'daily',title:'daily',prompt:'task',time:'09:00',timezone:'UTC',enabled:true});
    for(let i=0;i<10;i++){f.service.submit('owner','first',{requestId:'old-'+i,text:'old context '+i});f.pending.at(-1).resolve('old answer');await tick();}
    assert.throws(()=>f.service.clear('other','first'),/不存在/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.home,fs.readdirSync(f.home).find(x=>x.endsWith('.json'))),'utf8')).summary);
    f.service.clear('owner','first');
    const cleared=f.service.read('owner','first');assert.deepEqual(cleared.messages,[]);assert.equal(cleared.before,null);assert.equal(cleared.job,undefined);assert.equal(cleared.schedules.length,1);assert.equal(cleared.name,'我的分身');assert.equal(cleared.unread,0);
    const persisted=JSON.parse(fs.readFileSync(path.join(f.home,fs.readdirSync(f.home).find(x=>x.endsWith('.json'))),'utf8'));assert.equal(persisted.summary,'');assert.deepEqual(persisted.messages,[]);
    const restarted=new f.Personas(f.home,f.sessions,f.messaging);t.after(()=>restarted.close());assert.deepEqual(restarted.read('owner','first').messages,[]);
    f.service.submit('owner','first',{requestId:'old-0',text:'old context 0'});assert.equal(f.pending.length,10);
    f.service.submit('owner','first',{requestId:'fresh',text:'fresh'});assert.deepEqual(f.pending.at(-1).input.history,[]);assert.doesNotMatch(f.pending.at(-1).input.prompt,/old context|old answer/);
    assert.throws(()=>f.service.clear('owner','first'),/等待或取消/);assert.equal(f.service.read('owner','first').messages.length,1);
    f.pending.at(-1).resolve('new answer');await tick();
});

test('dashboard snapshot shows owned conversation and native execution metadata without context bodies',async t=>{
    const f=fixture(t);f.sessions.list=owner=>{assert.match(owner,/^[a-f0-9]{64}$/);return [{id:'native-session',backend:'codex',status:'running',items:[{text:'private body'}],pending:[{secret:'hidden'}]}];};
    f.service.submit('owner','first',{requestId:'job',text:'private question'});
    const snapshot=f.service.dashboard();
    assert.equal(snapshot.stats.total,1);assert.equal(snapshot.stats.active,1);assert.equal(snapshot.stats.messages,1);
    assert.deepEqual(snapshot.sessions.map(s=>s.kind),['Conversation','CLI','Runtime']);
    assert.equal(snapshot.sessions[1].id,'native-session');
    assert.doesNotMatch(JSON.stringify(snapshot),/private question|private body|hidden|owner-login/);
    f.pending[0].resolve('private reply');await tick();
    assert.equal(f.service.dashboard().stats.active,0);assert.equal(f.service.dashboard().sessions.some(s=>s.kind==='Runtime'),false);
});

test('persona auto-approval cannot be injected by upsert and remains owner, root and executor scoped',async t=>{
    const f=fixture(t,'codex');const configurations=[];
    f.sessions.configureAutoApproval=(...args)=>configurations.push(args);
    f.service.upsert('owner',{id:'first',name:'我的分身',root:f.home,executor:'codex',cliApprovalGrant:{root:f.home,backend:'codex'}});
    assert.equal(f.service.read('owner','first').cliApproval.scope,'ask');
    f.service.submit('owner','first',{requestId:'grant-test',text:'task'});await tick();
    f.callbacks.get('native')({session:{status:'waiting',pending:[{id:91,method:'item/commandExecution/requestApproval',decisionCapabilities:{autoApproval:true}}]}});
    assert.throws(()=>f.service.respond('other','first',{id:91,decision:'acceptAlwaysForPersona'}),/不存在/);
    assert.throws(()=>f.service.respond('owner','first',{id:92,decision:'acceptAlwaysForPersona'}),/不支持/);
    f.service.respond('owner','first',{id:91,decision:'acceptAlwaysForPersona'});
    assert.equal(f.service.read('owner','first').cliApproval.scope,'always');assert.equal(configurations.at(-1)[2],true);
    f.callbacks.get('native')({session:{status:'completed',items:[{type:'agentMessage',text:'done'}]}});await tick();
    f.service.upsert('owner',{id:'first',name:'我的分身',root:f.home,executor:'claude'});
    assert.equal(f.service.read('owner','first').cliApproval.scope,'ask');
    f.service.upsert('owner',{id:'first',name:'我的分身',root:'',executor:'codex'});
    assert.equal(f.service.read('owner','first').cliApproval.scope,'ask');
    f.service.upsert('owner',{id:'first',name:'我的分身',root:f.home,executor:'codex'});
    assert.equal(f.service.read('owner','first').cliApproval.scope,'always');
    assert.throws(()=>f.service.revokeApproval('other','first'),/不存在/);
    f.service.revokeApproval('owner','first');assert.equal(f.service.read('owner','first').cliApproval.scope,'ask');
});


test('new persona inherits shared brain while explicit clearing remains possible', t => {
    const f = fixture(t);
    const created = f.service.upsert('owner', {id:'shared',name:'Shared'});
    assert.equal(created.root, fs.realpathSync(f.home));
    assert.equal(f.service.upsert('owner', {id:'shared',name:'Shared',root:''}).root, '');
});


test('channel scope follows current persona brain, including restored clients and explicit clearing',t=>{
 const f=fixture(t);
 assert.equal(f.messaging.resolveRoot('owner','first'),fs.realpathSync(f.home));
 assert.equal(f.messaging.resolveRoot('unknown','first'),'');
 f.service.upsert('owner',{id:'first',name:'Persona',root:''});
 assert.equal(f.messaging.resolveRoot('owner','first'),'');
});

test('custom persona fork persists role and portable routing without copying owner history',async t=>{
    const f=fixture(t),groups=[{channel:'dingtalk',account:'corp:user',id:'group',name:'Team'}];
    f.service.submit('owner','first',{requestId:'owner-history',text:'Private owner conversation'});f.pending[0].resolve('Private answer');await tick();
    const created=f.service.upsert('owner',{id:'fork',name:'Lily',prompt:'Research using $research',executor:'keepwork',messaging:{version:1,enabled:true,groups}});
    assert.equal(created.root,fs.realpathSync(f.home));assert.equal(created.messagingVersion,1);assert.equal(created.prompt,'Research using $research');
    assert.deepEqual(f.service.read('owner','fork').messages,[]);
    assert.deepEqual(created.messaging,{version:1,enabled:true,groups});
    assert.throws(()=>f.service.upsert('owner',{id:'duplicate',name:'ＬＩＬＹ',prompt:'other',messaging:{version:1,enabled:true,groups}}),/唯一/);
    assert.throws(()=>f.service.upsert('owner',{id:'empty',name:'Empty',prompt:'role',messaging:{version:1,enabled:true,groups:[]}}),/主要群聊/);
    const restored=new f.Personas(f.home,f.sessions,f.messaging);t.after(()=>restored.close());
    assert.deepEqual(restored.read('owner','fork').messaging,created.messaging);
    f.service.submit('owner','fork',{requestId:'fork-task',text:'Research'});
    assert.match(f.pending[1].input.prompt,/Research using \$research/);assert.doesNotMatch(JSON.stringify(f.pending[1].input),/Private owner conversation|Private answer/);
    assert.throws(()=>f.service.upsert('owner',{...created,root:''}),/等待/);
    f.pending[1].resolve('Research result');await tick();
    const cleared=f.service.upsert('owner',{...created,root:''});assert.equal(cleared.root,'');assert.deepEqual(cleared.messaging,created.messaging);
});

test('persona knows shared-memory and nickname rules; owner group assignment requires search, ownership and approval',async t=>{
 const f=fixture(t,'codex');
 f.service.upsert('owner',{id:'helper',name:'Helper',prompt:'Research role'});
 f.messaging.agentBindings=()=>[{id:'binding',channel:'dingtalk',profile:'corp:user'}];
 f.messaging.agentGroups=async(owner,id,binding,query)=>{assert.equal(owner,'owner');assert.equal(binding,'binding');return [{id:'group',name:'Team'}];};
 const assigned=[];f.messaging.assignGroupNickname=async(...args)=>{assigned.push(args);return {nickname:'Owner & Helper'};};
 f.service.submit('owner','first',{requestId:'assign-helper',text:'把 Helper 加入 Team 群'});await tick();
 assert.equal(f.calls.length,0,'group management uses owner tool runtime, not CLI-only prompt');
 const run=f.pending[0];assert.match(run.input.prompt,/分身的分身/);assert.match(run.input.prompt,/同一个第二大脑/);assert.match(run.input.prompt,/search_agent_groups/);
 await assert.rejects(run.executeTool('assign_agent_group',{agentId:'helper',binding:'binding',group:'invented'}),/搜索/);
 await run.executeTool('search_agent_groups',{binding:'binding',query:'Team'});
 await assert.rejects(run.executeTool('assign_agent_group',{agentId:'foreign',binding:'binding',group:'group'}),/不存在/);
 const action=run.executeTool('assign_agent_group',{agentId:'helper',binding:'binding',group:'group'});await tick();assert.equal(assigned.length,0);
 const pending=f.service.read('owner','first').job.pending[0];f.service.respond('owner','first',{id:pending.id,decision:'accept'});
 assert.deepEqual(await action,{nickname:'Owner & Helper'});assert.equal(assigned[0][1],'helper');run.resolve('Assigned');await tick();
});

test('group work approvals surface destination, preserve owner history and support cancellation',async t=>{
 const f=fixture(t);let cancelled=false;
 const controller=new AbortController(),request={owner:'owner',agentId:'first',root:fs.realpathSync(f.home),channel:'dingtalk',account:'corp:user',group:'group',message:'write report',tool:'write_file',args:{path:'report.md',content:'draft'},cancel:()=>{cancelled=true;}};
 const pending=f.service.approveGroupWork(request,controller.signal);await tick();
 const view=f.service.read('owner','first');assert.equal(view.messages.length,0);assert.equal(view.job.state,'waiting');assert.equal(view.job.pending[0].params.group,'group');assert.match(view.job.pending[0].params.notice,/角色范围外/);
 f.service.respond('owner','first',{id:view.job.pending[0].id,decision:'accept'});await pending;assert.equal(f.service.read('owner','first').job.state,'done');assert.equal(cancelled,false);
 const second=f.service.approveGroupWork(request,controller.signal);await tick();await f.service.cancel('owner','first');await assert.rejects(second,/拒绝|取消|Cancelled/);assert.equal(cancelled,true);
});

test('role agents autonomously write external repo paths; explicit scope exceptions still wait for approval',async t=>{
 const f=fixture(t);const repo=fs.mkdtempSync(path.join(os.tmpdir(),'role-repo-'));t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
 f.service.upsert('owner',{id:'writer',name:'Writer',prompt:'Maintain docs. May write '+repo+'/docs; ask outside that path.',root:f.home,executor:'keepwork'});
 f.service.submit('owner','writer',{requestId:'role-write',text:'Update docs'});const run=f.pending[0];
 assert.match(run.input.prompt,/默认具备写文件/);assert.match(run.input.prompt,/requireApproval:true/);
 const target=path.join(repo,'docs/new.md');await run.executeTool('write_file',{path:target,content:'autonomous'});assert.equal(fs.readFileSync(target,'utf8'),'autonomous');assert.equal(f.service.read('owner','writer').job.pending?.length||0,0);
 const outside=path.join(repo,'other.md'),pending=run.executeTool('write_file',{path:outside,content:'approved',requireApproval:true,approvalReason:'Outside docs role'});await tick();assert.equal(fs.existsSync(outside),false);
 const approval=f.service.read('owner','writer').job.pending[0];assert.equal(approval.params.reason,'Outside docs role');f.service.respond('owner','writer',{id:approval.id,decision:'accept'});await pending;assert.equal(fs.readFileSync(outside,'utf8'),'approved');
 await run.executeTool('run_terminal',{cwd:repo,command:'git diff -- docs'});assert.equal(f.calls.at(-1).root,fs.realpathSync(repo));
 const denied=run.executeTool('write_file',{path:outside,content:'no',requireApproval:true});await tick();const ask=f.service.read('owner','writer').job.pending[0];f.service.respond('owner','writer',{id:ask.id,decision:'decline'});await assert.rejects(denied,/拒绝/);assert.equal(fs.readFileSync(outside,'utf8'),'approved');run.resolve('done');await tick();
});
test('native role agent uses craft while explicit questions still surface to owner',async t=>{
 const f=fixture(t,'codex');f.service.upsert('owner',{id:'writer',name:'Writer',prompt:'Write docs; ask outside docs.',executor:'codex'});
 f.service.submit('owner','writer',{requestId:'native-role',text:'Update docs'});await tick();
 assert.equal(f.calls[0].input.mode,'craft');assert.equal(f.calls[1].input.mode,'craft');assert.match(f.calls[1].input.text,/requestUserInput/);
 f.callbacks.get('native')({session:{status:'waiting',pending:[{id:'outside',method:'item/tool/requestUserInput',params:{questions:[{id:'scope',question:'May I change another repo?'}]}}]}});assert.equal(f.service.read('owner','writer').job.state,'waiting');
 f.callbacks.get('native')({session:{status:'completed',items:[{type:'agentMessage',text:'waiting for scope approval'}]}});await tick();
});

test('new custom agent follows owner default brain; rebinding is deferred during group work',async t=>{
 const f=fixture(t),brain=path.join(f.home,'owner-brain');fs.mkdirSync(brain);
 f.service.upsert('owner',{id:'default-persona',name:'Owner',root:brain});f.service.upsert('owner',{id:'child',name:'Child',prompt:'Role'});
 assert.equal(f.service.read('owner','child').root,fs.realpathSync(brain));
 f.messaging.isAgentBusy=(owner,id)=>owner==='owner'&&id==='child';assert.equal(f.service.read('owner','child').groupWorkActive,true);
 assert.throws(()=>f.service.upsert('owner',{id:'child',name:'Child',prompt:'Role',root:f.home}),/群任务/);
 f.messaging.isAgentBusy=()=>false;f.service.upsert('owner',{id:'child',name:'Child',prompt:'Role',root:f.home});assert.equal(f.service.read('owner','child').root,fs.realpathSync(f.home));
});

test('nickname-discoverable custom agents reject separator and reply-marker names even with messaging disabled',t=>{
 const f=fixture(t);for(const name of ['A & B','A＆B','A【B】','A\nB'])assert.throws(()=>f.service.upsert('owner',{id:'bad-name',name,prompt:'role',messaging:{version:1,enabled:false,groups:[]}}),/名称/);
});
