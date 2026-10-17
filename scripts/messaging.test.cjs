const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
function load(name, mocks = {}) {
    const file = path.resolve(__dirname, '../src/core', name + '.ts');
    const m = new Module(file, module); m.filename = file; m.paths = module.paths;
    m.require = id => Object.hasOwn(mocks,id) ? mocks[id] : id.startsWith('./messaging') ? load(path.basename(id),mocks) : require(id);
    m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file); return m.exports;
}
const policy = load('messagingPolicy');
const message = (id='1', conversation='dm', sender='sender') => ({type:'user_im_message_receive_o2o_all',message_id:id,conversation_id:conversation,sender_open_dingtalk_id:sender,content:'课程怎么学习',create_time:Date.now()+1000});
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-messaging-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const root=path.join(dir,'brain');fs.mkdirSync(path.join(root,'public'),{recursive:true});fs.writeFileSync(path.join(root,'public','lesson.md'),'课程学习计划：先读教材，再练习。');
    const events=[], sent=[], cards=[], updates=[], pending=[]; let conflict=false, failure=false, active=0, max=0;
    class BeforeSubmission extends Error {}
    const serviceModule=load('messaging',{
        './aichatPresence':{latestAichatClient:()=>null},
        './messagingDingtalk':{dws:async()=>({identity:{corp_id:'corp',user_id:'user'},bus:{live:{consumers:conflict?[{}]:[]}}}),listenDws:async(_r,_p,_c,event,exit)=>{events.push(event);return()=>{};},DingTalkDelivery:class{async create(){return '';}async update(...args){updates.push(args);}async send(...args){sent.push(args);}}},
        './messagingExecutor':{BeforeSubmission,messagingExecutorChoice:()=>({backend:'copilot',model:''}),restrictedCliAnswer:async()=>{throw new BeforeSubmission();},MessagingWorkers:class{answer(input,signal){active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{const end=()=>{active--;failure?reject(Error('unknown')):resolve('课程学习答案');};pending.push({input,end});signal.addEventListener('abort',()=>{active--;reject(Error('cancelled'));},{once:true});});}close(){}}},
    });
    const service=new serviceModule.MessagingService(path.join(dir,'state'),8089);t.after(()=>service.close());
    const binding=service.configure({root,profile:'corp:user',config:{...policy.defaultMessageConfig(),knowledge:['public']},prompt:policy.DEFAULT_PROMPT});
    return {service,binding,root,events,sent,pending,updates,cards,get max(){return max;},set conflict(v){conflict=v;},set failure(v){failure=v;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('default keywords empty; trigger by event identity, not claimed sender names',()=>{
    const config=policy.defaultMessageConfig();assert.deepEqual(config.keywords,[]);
    const m=policy.incoming(message());assert.equal(policy.trigger(m,config,Date.now(),'owner'),'reply');
    assert.equal(policy.trigger({...m,kind:'group',text:'@所有人 请答复'},config,0,''),'not-triggered');
    assert.equal(policy.trigger({...m,time:1},config,2,''),'old');
    assert.equal(policy.trigger({...m,sender:'owner'},config,0,'owner'),'self');
    assert.equal(policy.trigger({...m,text:'【AI 代答】答复'},config,0,''),'echo');
    config.keywords=['小明'];config.groups=['allowed'];
    assert.equal(policy.trigger({...m,kind:'group',conversation:'allowed',text:'小明你好'},config,0,''),'reply');
    assert.equal(policy.trigger({...m,kind:'group',conversation:'other',text:'小明你好'},config,0,''),'not-triggered');
    assert.equal(policy.incoming({...message(),create_time:undefined}),null);
});
test('public knowledge rejects traversal, secret directories and symlink escapes',t=>{
    const f=fixture(t),config={...policy.defaultMessageConfig(),knowledge:['public']};
    for(const bad of ['..','notes/account','/etc','public/../private','.git','C:\\secret'])assert.throws(()=>policy.configValue({...config,knowledge:[bad]}));
    fs.mkdirSync(path.join(f.root,'private'));fs.writeFileSync(path.join(f.root,'private','secret.md'),'课程 secret');
    fs.symlinkSync(path.join(f.root,'private'),path.join(f.root,'public','link'),'junction');
    const result=policy.knowledgeContext(f.root,config,'课程学习');assert.match(result,/lesson.md/);assert.doesNotMatch(result,/secret/);
    assert.throws(()=>policy.knowledgeDirectory(f.root,'public/link'));
});
test('Unicode splitting stays under byte limit without corrupting characters',()=>{
    const text='课程🙂'.repeat(5000),parts=policy.splitReply(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>Buffer.byteLength(p)<=6000));
});
test('dedup and per-conversation serialization; participant history isolation',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    f.events[0](message('1'));f.events[0](message('1'));f.events[0](message('2'));
    await tick();assert.equal(f.pending.length,1);f.pending[0].end();await tick();await tick();assert.equal(f.pending.length,2);assert.equal(f.pending[1].input.history.length,2);f.pending[1].end();await tick();
    f.events[0](message('3','dm','different'));await tick();assert.equal(f.pending[2].input.history.length,0);f.pending[2].end();await tick();
    assert.equal(f.sent.length,3);assert.ok(f.service.view(f.binding.id).recent.every(r=>!Object.hasOwn(r,'text')));
});
test('parallelism and queue caps reject overflow',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    for(let i=0;i<6;i++)f.events[0](message(String(i),'c'+i));
    await tick();assert.equal(f.max,4);
    for(let i=0;i<25;i++)f.events[0](message('q'+i,'c0'));
    assert.ok(f.service.view(f.binding.id).recent.some(r=>r.state==='rejected'));
    f.service.stop(f.binding.id);await tick();assert.equal(f.sent.length,0);
});
test('existing consumer is not stolen, and start failure is visible',async t=>{
    const f=fixture(t);f.conflict=true;await assert.rejects(f.service.start(f.binding.id),/已有个人消息桥/);assert.equal(f.events.length,0);assert.equal(f.service.view(f.binding.id).status,'error');
});
test('invalid manually edited rules pause reception; no prompt is run',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);fs.writeFileSync(path.join(f.root,policy.RULE_DIR,'config.json'),'{broken');f.events[0](message());await tick();assert.equal(f.pending.length,0);assert.equal(f.service.view(f.binding.id).status,'error');
});
test('uncertain model result is never replayed; restart preserves receipt only',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);f.events[0](message());await tick();f.failure=true;f.pending[0].end();await tick();f.events[0](message());await tick();assert.equal(f.pending.length,1);assert.equal(f.sent.length,0);
    const state=JSON.parse(fs.readFileSync(path.join(path.dirname(f.root),'state',f.binding.id+'.json'),'utf8'));assert.equal(state.receipts.length,1);assert.doesNotMatch(JSON.stringify(state),/课程/);
});
test('DWS listener subscriptions do not subscribe all groups',()=>{
    const {listenerArgs}=load('messagingDingtalk');const c=policy.defaultMessageConfig();c.groups=['group'];assert.equal(listenerArgs(c).length,1);c.keywords=['名字'];assert.deepEqual(listenerArgs(c)[1],['event','consume','user_im_message_receive_group','--group','group','--flatten','-f','ndjson']);
});

test('card rejection falls back, uncertain creation does not, and send args never invoke a shell',async()=>{
    const calls=[];let payload={error:{code:'unsupported'}},code=1;
    const {DingTalkDelivery,DwsError}=load('messagingDingtalk',{
        'node:fs':{...fs,existsSync:()=>true,statSync:()=>({isFile:()=>true})},
        'node:child_process':{spawn:(exe,args,options)=>{calls.push({args,options});const c=new EventEmitter();c.stdout=new EventEmitter();c.stdout.setEncoding=()=>{};c.stderr={resume(){}};c.stdin={end(){}};process.nextTick(()=>{c.stdout.emit('data',typeof payload==='string'?payload:JSON.stringify(payload));c.emit('close',code);});return c;}},
    });
    const delivery=new DingTalkDelivery(os.tmpdir(),'corp:user'),m=policy.incoming(message());assert.equal(await delivery.create(m),'');
    payload='garbled';code=0;await assert.rejects(delivery.create(m),e=>e instanceof DwsError&&e.uncertain);
    payload={data:{bizId:'card'}};assert.equal(await delivery.create(m),'card');
    payload={ok:true};await delivery.send(m,'message-key','$(never execute) " 中文');
    const last=calls.at(-1);assert.equal(last.options.shell,false);assert.ok(last.args.includes('$(never execute) " 中文'));assert.ok(last.args.includes(m.sender));assert.ok(last.args.includes('message-key-0'));
});

test('worker capability is single-claim, owner-bound, cancelled and never persisted',async()=>{
    const {MessagingWorkers}=load('messagingExecutor',{
        './acpHarness':{},'./agentCliProcess':{},'./config':{readNotifyBridge:()=>null},
        './aichatPresence':{latestAichatClient:()=>({url:'https://keepwork.com/chat',token:'fixture-private-login',baseURL:''})},
    });
    const workers=new MessagingWorkers(8089);let url;workers.launch=async value=>{url=value;};
    const controller=new AbortController();const pending=workers.answer({prompt:'rule',question:'question',knowledge:'public',history:[],brain:'brain'},controller.signal);
    await tick();assert.doesNotMatch(url,/fixture-private-login/);const key=new URL(url).hash.slice(1),owner='12345678-1234-1234-1234-123456789abc';
    const claim=workers.claim(key,owner);assert.equal(claim.token,'fixture-private-login');assert.throws(()=>workers.claim(key,owner),/unavailable/);assert.throws(()=>workers.result(key,'wrong','answer'),/ownership/);
    workers.result(key,owner,'answer');assert.equal(await pending,'answer');assert.equal(workers.alive(key,owner),false);assert.throws(()=>workers.result(key,owner,'duplicate'),/ownership/);
    const aborted=workers.answer({prompt:'rule',question:'q',knowledge:'',history:[],brain:'brain'},controller.signal);controller.abort();await assert.rejects(aborted,/Cancelled/);workers.close();
});

test('manual rules are preserved when a new machine has no local binding',t=>{
    const f=fixture(t),custom='Custom second-brain prompt';fs.writeFileSync(path.join(f.root,policy.RULE_DIR,'SKILL.md'),custom);
    assert.equal(f.service.defaults(f.root).prompt,custom);assert.deepEqual(f.service.defaults(f.root).config.knowledge,['public']);
});

test('rules revoked while model is running withhold the old answer',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);f.events[0](message());await tick();
    fs.writeFileSync(path.join(f.root,policy.RULE_DIR,'config.json'),JSON.stringify(policy.defaultMessageConfig()));
    f.pending[0].end();await tick();assert.equal(f.sent.length,0);assert.match(f.service.view(f.binding.id).recent[0].reason,/Rules changed/);
});

test('ignored keyword event cannot suppress a later @me event for the same message',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    const event={...message('overlap','group'),type:'user_im_message_receive_group'};
    f.events[0](event);f.events[0]({...event,type:'user_im_message_receive_at'});await tick();assert.equal(f.pending.length,1);f.pending[0].end();await tick();assert.equal(f.sent.length,1);
});

test('global waiting cap is 100 independently of conversation caps',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);for(let i=0;i<115;i++)f.events[0](message(String(i),'group'+i));await tick();
    assert.equal(f.service.view(f.binding.id).queued,100);assert.equal(f.service.view(f.binding.id).active,4);assert.equal(f.service.view(f.binding.id).recent.filter(r=>r.state==='rejected').length,11);
    f.service.stop(f.binding.id);await tick();
});

test('service restart marks in-flight work unknown and ignores pre-start deliveries',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);f.events[0](message());await tick();
    f.service.close();await tick();
    const storedFile=path.join(path.dirname(f.root),'state',f.binding.id+'.json');const stored=JSON.parse(fs.readFileSync(storedFile,'utf8'));stored.receipts[0].state='running';fs.writeFileSync(storedFile,JSON.stringify(stored));
    const Service=f.service.constructor;const restarted=new Service(path.join(path.dirname(f.root),'state'),8089);t.after(()=>restarted.close());assert.equal(restarted.view(f.binding.id).recent[0].state,'unknown');
    assert.equal(restarted.view(f.binding.id).queued,0);await restarted.start(f.binding.id);f.events.at(-1)({...message('old'),create_time:Date.now()-10000});await tick();assert.equal(restarted.view(f.binding.id).recent[0].reason,'old');
});

test('Copilot restricted adapter denies tool requests and receives no workspace root',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-reader-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let launch,instance,submitted;
    class Adapter extends EventEmitter {
        constructor(...args){super();launch=args;instance=this;}
        async call(method,args){if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start'){submitted=args;this.emit('request',{id:1});process.nextTick(()=>this.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}}));return {turn:{id:'turn'}};}if(method==='thread/read')return{thread:{turns:[{items:[{type:'reasoning',text:'private reasoning'},{type:'agentMessage',text:'public answer'}]}]}};}
        respond(id,value){this.decision=value.decision;}close(){}
    }
    const {copilotAnswer}=load('messagingExecutor',{'./acpHarness':{AcpHarness:Adapter},'./agentCliProcess':{resolveAgentCli:()=>({})},'./aichatPresence':{},'./config':{}});
    const answer=await copilotAnswer(dir,policy.defaultMessageConfig(),{prompt:'rule',question:'question',knowledge:'approved excerpt',history:[],brain:'label'},new AbortController().signal);
    assert.equal(answer,'public answer');assert.equal(instance.decision,'decline');assert.ok(launch[3].includes('--no-custom-instructions'));assert.ok(launch[3].includes('--disable-builtin-mcps'));
    const manifest=fs.readFileSync(path.join(launch[1],'.github/agents',path.basename(launch[1])+'.agent.md'),'utf8');assert.match(manifest,/tools: \[\]/);
    assert.doesNotMatch(submitted.input[0].text,/private reasoning/);assert.ok(submitted.input[0].text.includes('approved excerpt'));
});


test('auto follows AIChat backend/model; unsupported default falls back before submission, never chooses Copilot', async()=>{
    const {messagingExecutorChoice,restrictedCliAnswer,BeforeSubmission}=load('messagingExecutor',{
        './acpHarness':{},'./agentCliProcess':{},'./config':{},
        './aichatPresence':{latestAichatClient:()=>({defaultExecutor:{backend:'workbuddy',model:'chosen-model'}})},
    });
    const config=policy.defaultMessageConfig();
    assert.deepEqual(messagingExecutorChoice(config),{backend:'workbuddy',model:'chosen-model'});
    for(const backend of ['codex','claude','cursor','qwen','gemini','kimi','trae','codebuddy','opencode','copilot']) {
        assert.deepEqual(messagingExecutorChoice(config,{backend,model:'saved'}),{backend,model:'saved'});
    }
    assert.deepEqual(messagingExecutorChoice(config,null),{backend:'keepwork',model:''});
    assert.deepEqual(messagingExecutorChoice({...config,executor:'copilot'}),{backend:'copilot',model:''});
    assert.deepEqual(messagingExecutorChoice({...config,model:'override'}),{backend:'workbuddy',model:'override'});
    await assert.rejects(restrictedCliAnswer('',{...config,executor:'workbuddy'},{},new AbortController().signal),BeforeSubmission);
});


test('Agent inbox is owner scoped; takeover aborts automatic reply and manual delivery stays idempotent after clear',async t=>{
    const f=fixture(t);f.service.bindAgent('owner','agent',f.binding.id);await f.service.start(f.binding.id);
    f.events[0](message('inbound'));await tick();assert.equal(f.pending.length,1);
    assert.throws(()=>f.service.inboxView('other','agent',f.binding.id),/不属于/);
    assert.equal(f.service.inboxView('owner','agent',f.binding.id).conversations[0].unread,1);
    await f.service.manualReply('owner','agent',f.binding.id,'dm','manual','本人回复');await tick();
    assert.equal(f.sent.length,1);assert.equal(f.sent[0][0].sender,'sender');assert.equal(f.sent[0][2],'本人回复');
    f.events[0](message('paused'));await tick();assert.equal(f.pending.length,1);
    f.service.inboxAction('owner','agent',f.binding.id,'dm','clear');await f.service.manualReply('owner','agent',f.binding.id,'dm','manual','本人回复');assert.equal(f.sent.length,1);
});

test('same channel identity cannot be attached to different Agent and deleting Agent stops only its binding',async t=>{
    const f=fixture(t);f.service.bindAgent('owner','first',f.binding.id);
    assert.throws(()=>f.service.bindAgent('owner','second',f.binding.id),/其他分身/);
    await f.service.start(f.binding.id);f.service.detachAgent('owner','first');assert.equal(f.service.view(f.binding.id).autoReply,false);assert.equal(f.service.view(f.binding.id).agentId,undefined);
    assert.ok(fs.existsSync(path.join(f.root,'public','lesson.md')));
});


test('same brain keeps independent Agent public reply rules',t=>{
    const f=fixture(t);f.service.bindAgent('owner','one',f.binding.id);
    f.service.configure({root:f.root,profile:'corp:user',config:{...policy.defaultMessageConfig(),knowledge:['public'],keywords:['姓名']},prompt:'one'});
    const two=f.service.configure({root:f.root,profile:'corp:other',config:{...policy.defaultMessageConfig(),knowledge:[]},prompt:'two'});f.service.bindAgent('owner','two',two.id);
    assert.equal(f.service.rules(f.binding.id).prompt,'one');assert.deepEqual(f.service.rules(f.binding.id).config.keywords,['姓名']);
    assert.equal(f.service.rules(two.id).prompt,'two');assert.deepEqual(f.service.rules(two.id).config.knowledge,[]);
});

test('owner worker capability grants only declared tools and deduplicates calls',async()=>{
    const {MessagingWorkers}=load('messagingExecutor',{'./acpHarness':{},'./agentCliProcess':{},'./config':{},'./aichatPresence':{latestAichatClient:()=>({url:'https://keepwork.com/chat',token:'fixture',baseURL:''})}});
    const workers=new MessagingWorkers(8089);let url,count=0;workers.launch=async value=>{url=value;};
    const pending=workers.answer({ownerTask:true,prompt:'owner',question:'q',knowledge:'',history:[],brain:'b',tools:[{function:{name:'read_file'}}]},new AbortController().signal,undefined,async()=>{count++;return 'result';});await tick();
    const key=new URL(url).hash.slice(1),owner='12345678-1234-1234-1234-123456789abc',call='12345678-1234-1234-1234-123456789def';workers.claim(key,owner);
    await assert.rejects(workers.tool(key,owner,call,'run_terminal',{}),/unavailable/);
    assert.deepEqual(await Promise.all([workers.tool(key,owner,call,'read_file',{}),workers.tool(key,owner,call,'read_file',{})]),['result','result']);assert.equal(count,1);
    await assert.rejects(workers.tool(key,owner,call,'read_file',{path:'changed'}),/reused/);
    workers.result(key,owner,'done');assert.equal(await pending,'done');workers.close();
});
