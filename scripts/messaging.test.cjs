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
    m.require = id => Object.hasOwn(mocks,id) ? mocks[id] : (id.startsWith('./messaging') || id === './headless') ? load(path.basename(id),mocks) : require(id);
    m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file); return m.exports;
}
const policy = load('messagingPolicy');
const message = (id='1', conversation='dm', sender='sender') => ({type:'user_im_message_receive_o2o_all',message_id:id,conversation_id:conversation,sender_open_dingtalk_id:sender,content:'课程怎么学习',create_time:Date.now()+1000});
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-messaging-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const root=path.join(dir,'brain');fs.mkdirSync(path.join(root,'public'),{recursive:true});fs.writeFileSync(path.join(root,'public','lesson.md'),'课程学习计划：先读教材，再练习。');
    const logins=[], exits=[], events=[], sent=[], cards=[], updates=[], pending=[]; let conflict=false, failure=false, active=0, max=0, connectionFailures=0, statusChecks=0;
    class BeforeSubmission extends Error {}
    const serviceModule=load('messaging',{
        './aichatPresence':{latestAichatClient:()=>null},
        './messagingDingtalk':{loginDws:async(root,profile)=>{logins.push({root,profile});},dws:async(args)=>{statusChecks++;if(connectionFailures-->0)throw Error('temporary connection reset');if(args[0]==='profile')return {currentProfile:'corp:user',profiles:[{corpId:'corp',userId:'user'}]};return {identity:{corp_id:'corp',user_id:'user',open_dingtalk_id:'owner'},bus:{live:{consumers:conflict?[{}]:[]}}};},listenDws:async(_r,_p,_c,event,exit)=>{events.push(event);exits.push(exit);return()=>{};},DingTalkDelivery:class{async create(){return '';}async update(...args){updates.push(args);}async send(...args){sent.push(args);}}},
        './messagingExecutor':{BeforeSubmission,messagingExecutorChoice:()=>({backend:'copilot',model:''}),restrictedCliAnswer:async()=>{throw new BeforeSubmission();},MessagingWorkers:class{answer(input,signal){active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{const end=()=>{active--;failure?reject(Error('unknown')):resolve('课程学习答案');};pending.push({input,end});signal.addEventListener('abort',()=>{active--;reject(Error('cancelled'));},{once:true});});}close(){}}},
    });
    const createService=()=>{const instance=new serviceModule.MessagingService(path.join(dir,'state'),8089);t.after(()=>instance.close());return instance;};
    const service=createService();
    const binding=service.configure({root,profile:'corp:user',config:{...policy.defaultMessageConfig(),knowledge:['public']},prompt:policy.DEFAULT_PROMPT});
    return {service,createService,binding,root,events,exits,logins,sent,pending,updates,cards,get statusChecks(){return statusChecks;},set connectionFailures(v){connectionFailures=v;},get max(){return max;},set conflict(v){conflict=v;},set failure(v){failure=v;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('dashboard messages track processing and replies in memory only, newest first and capped at 500',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    f.events[0](message('diagnostic'));await tick();
    let row=f.service.dashboardMessages()[0];
    assert.equal(row.state,'running');assert.equal(row.text,'课程怎么学习');assert.equal(row.channel,'dingtalk');
    assert.equal(row.relevant,true);assert.equal(row.kind,'direct');
    assert.equal('receipt' in row,false);assert.equal('agentOwner' in row,false);
    f.pending[0].end();await tick();
    row=f.service.dashboardMessages()[0];assert.equal(row.state,'done');assert.match(row.reply,/课程学习答案/);
    const receiptFile=JSON.parse(fs.readFileSync(path.join(path.dirname(f.root),'state',f.binding.id+'.json'),'utf8'));
    assert.doesNotMatch(JSON.stringify(receiptFile),/课程学习答案|课程怎么学习|recentMessages/);
    f.events[0](message('diagnostic'));assert.equal(f.service.dashboardMessages().length,1,'duplicate delivery is omitted');
    for(let i=0;i<505;i++)f.events[0]({...message('ignored-'+i,'dm','owner'),content:'x'.repeat(9000)});
    const rows=f.service.dashboardMessages();assert.equal(rows.length,500);
    assert.equal(rows[0].state,'ignored');assert.equal(rows[0].reason,'self');assert.equal(rows[0].text.length,8000);
    assert.equal(rows[0].relevant,false);
    assert.equal(rows.some(r=>r.id===row.id),false,'oldest entry is evicted');
    rows[0].text='changed';assert.equal(f.service.dashboardMessages()[0].text.length,8000,'snapshots cannot mutate history');
    f.service.close();assert.deepEqual(f.createService().dashboardMessages(),[],'restart does not load persisted inbox into diagnostics');
});

test('dashboard relevance includes mentions and matching groups but excludes unrelated groups and echoes',async t=>{
    const f=fixture(t);f.service.configure({root:f.root,profile:'corp:user',config:{...policy.defaultMessageConfig(),groups:['group'],keywords:['课程']},prompt:policy.DEFAULT_PROMPT});
    await f.service.start(f.binding.id);
    f.events[0]({...message('unrelated','group'),type:'user_im_message_receive_group',content:'普通聊天'});
    assert.equal(f.service.dashboardMessages()[0].relevant,false);
    f.events[0]({...message('matching','group'),type:'user_im_message_receive_group'});
    assert.equal(f.service.dashboardMessages()[0].relevant,true);
    f.events[0]({...message('mention'),type:'user_im_message_receive_at'});
    assert.equal(f.service.dashboardMessages()[0].relevant,true);
    f.events[0]({...message('echo'),content:'【AI 代答】测试'});
    assert.equal(f.service.dashboardMessages()[0].relevant,false);
    f.service.close();await tick();
});

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
    const f=fixture(t);f.conflict=true;await assert.rejects(f.service.start(f.binding.id),/已有个人消息桥/);assert.equal(f.events.length,0);assert.equal(f.service.view(f.binding.id).status,'reconnecting');
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

test('messaging reuses one headless browser across concurrent and sequential jobs, isolates and cleans contexts', async () => {
    const browsers=[], contexts=[], urls=[]; let launches=0;
    const {MessagingWorkers}=load('messagingExecutor',{
        './acpHarness':{}, './agentCliProcess':{}, './aichatPresence':{},
        './headless':{resolveBrowser:()=>'/fixture/browser'},
        'playwright-core':{chromium:{launch:async options=>{
            launches++; assert.equal(options.headless,true);
            await tick();
            const browser=new EventEmitter(); browser.close=async()=>{browser.closed=true;browser.emit('disconnected');};
            browser.newContext=async()=>{
                const page=new EventEmitter();page.goto=async url=>{urls.push(url);};
                const context={closed:false,newPage:async()=>page,close:async()=>{context.closed=true;page.emit('close');}};
                contexts.push(context);return context;
            };
            browsers.push(browser);return browser;
        }}},
    });
    const workers=new MessagingWorkers(8089), input={prompt:'rule',question:'q',knowledge:'',history:[],brain:'brain'};
    const login={url:'https://keepwork.com/chat',token:'fixture-login',baseURL:''};
    const start=controller=>workers.answer(input,controller.signal,login);
    const a=new AbortController(),b=new AbortController();
    const first=start(a),second=start(b);
    await tick();await tick();assert.equal(launches,1);assert.equal(contexts.length,2);
    const owner='12345678-1234-1234-1234-123456789abc';
    const key=new URL(urls[0]).hash.slice(1);workers.claim(key,owner);workers.result(key,owner,'done');assert.equal(await first,'done');assert.equal(contexts[0].closed,true);
    b.abort();await assert.rejects(second,/Cancelled/);assert.equal(contexts[1].closed,true);assert.ok(!browsers[0].closed);
    const third=start(new AbortController());await tick();assert.equal(launches,1);
    browsers[0].emit('disconnected');await assert.rejects(third,/disconnected/);assert.equal(contexts[2].closed,true);
    const fourth=start(new AbortController());await tick();await tick();assert.equal(launches,2);
    workers.close();await assert.rejects(fourth,/Service stopped/);await tick();assert.equal(browsers[1].closed,true);
    await assert.rejects(start(new AbortController()),/Service stopped/);
});

test('shutdown during browser launch closes the late browser without creating a worker', async () => {
    let release,closed=false;
    const {MessagingWorkers}=load('messagingExecutor',{
        './acpHarness':{},'./agentCliProcess':{},'./aichatPresence':{},'./headless':{resolveBrowser:()=>'/fixture/browser'},
        'playwright-core':{chromium:{launch:()=>new Promise(resolve=>{release=()=>resolve({on(){},close:async()=>{closed=true;},newContext(){assert.fail('no context after shutdown');}});})}},
    });
    const workers=new MessagingWorkers(8089);
    const pending=workers.answer({history:[]},new AbortController().signal,{url:'https://keepwork.com/chat',token:'fixture',baseURL:''});
    workers.close();await assert.rejects(pending,/Service stopped/);release();await tick();assert.equal(closed,true);
});

test('real headless browser completes sequential worker handshakes and retains the browser', {timeout:30000}, async t => {
    const {resolveBrowser}=load('headless');
    if(!resolveBrowser()){t.skip('System Edge/Chrome unavailable');return;}
    const {MessagingWorkers,messagingWorkerHtml}=load('messagingExecutor',{'./acpHarness':{},'./agentCliProcess':{},'./aichatPresence':{}});
    const http=require('node:http');let workers;
    const server=http.createServer(async(req,res)=>{
        try {
            const route=req.url.split('?')[0];
            if(route==='/messaging/worker'){res.setHeader('Content-Type','text/html');res.end(messagingWorkerHtml);return;}
            if(route==='/fixture'){
                res.setHeader('Content-Type','text/html');res.end(`<script>
                const channel='aichat.external-tool.v1',nonce=new URLSearchParams(location.hash.slice(1)).get('messagingNonce');
                addEventListener('message',e=>{if(e.data.type==='host:messaging-task')parent.postMessage({channel,nonce,type:'tool:messaging-result',text:'fixture answer'},location.origin);});
                parent.postMessage({channel,nonce,type:'tool:messaging-ready'},location.origin);
                </script>`);return;
            }
            const key=(req.headers.authorization||'').replace('Bearer ',''),owner=req.headers['x-agent-owner'];
            let body='';for await(const chunk of req)body+=chunk;
            res.setHeader('Content-Type','application/json');
            if(route==='/messaging/worker/claim')res.end(JSON.stringify(workers.claim(key,owner)));
            else if(route==='/messaging/worker/result'){const result=JSON.parse(body);workers.result(key,owner,result.text,result.error);res.end('{}');}
            else {res.statusCode=404;res.end('{}');}
        }catch{res.statusCode=500;res.end('{}');}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    workers=new MessagingWorkers(server.address().port);
    t.after(async()=>{workers.close();if(workers.browser)await (await workers.browser).close();await new Promise(resolve=>server.close(resolve));});
    const login={url:`http://127.0.0.1:${server.address().port}/fixture`,token:'fixture-only',baseURL:''};
    const input={prompt:'',question:'',knowledge:'',history:[],brain:''};
    assert.equal(await workers.answer(input,new AbortController().signal,login),'fixture answer');
    const browser=await workers.browser;
    assert.equal(await workers.answer(input,new AbortController().signal,login),'fixture answer');
    assert.equal(await workers.browser,browser);assert.ok(browser.isConnected());
});


test('connectAgent reuses current CLI account and saved rules, starts once and preserves binding',async t=>{
    const f=fixture(t);let profiles=0;
    f.service.profiles=async()=>{profiles++;return [{id:'corp:user',current:true},{id:'other:user',current:false}];};
    const first=await f.service.connectAgent('owner','default-persona',f.root,'Persona prompt');
    assert.equal(first.listening,true);assert.equal(first.autoReply,true);assert.equal(first.agentId,'default-persona');
    assert.deepEqual(f.service.rules(first.id).config.knowledge,['public']);
    const again=await f.service.connectAgent('owner','default-persona',f.root,'Persona prompt');
    assert.equal(again.id,first.id);assert.equal(f.events.length,1);assert.equal(profiles,1);
    await assert.rejects(f.service.connectAgent('another','default-persona',f.root,'Other'),/其他分身/);
});
test('empty public selection allows personal-event replies without reading any brain files',async t=>{
    const f=fixture(t);
    f.service.configure({root:f.root,profile:'corp:user',config:policy.defaultMessageConfig(),prompt:policy.DEFAULT_PROMPT});
    f.service.profiles=async()=>[{id:'corp:user',current:true}];
    const connected=await f.service.connectAgent('owner','default-persona',f.root,'Persona prompt');
    assert.equal(connected.listening,true);
    f.events[0](message('no-knowledge'));await tick();
    assert.equal(f.pending[0].input.knowledge,'');
    f.pending[0].end();await tick();assert.equal(f.sent.length,1);
});


test('MCP retries initial failures every five minutes with no early checks or message replay',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const f=fixture(t);f.connectionFailures=6;
    f.service.profiles=async()=>[{id:'corp:user',current:true}];
    const result=await f.service.connectAgent('owner','default-persona',f.root,'Persona');
    assert.equal(result.status,'reconnecting');assert.equal(result.needsRepair,false);
    for(let attempt=0;attempt<6;attempt++){
        const checks=f.statusChecks;
        t.mock.timers.tick(299999);await tick();assert.equal(f.statusChecks,checks,'no retry before five minutes');
        t.mock.timers.tick(1);await tick();assert.equal(f.statusChecks,checks+1);
    }
    assert.equal(f.statusChecks,7);assert.equal(f.events.length,1);
    assert.equal(f.service.view(f.binding.id).status,'listening');
    assert.equal(f.service.view(f.binding.id).nextRetryAt,null);
    assert.equal(f.pending.length,0);assert.equal(f.sent.length,0);
});
test('disconnect recovery is single-flight and explicit stop cancels recovery',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const f=fixture(t);await f.service.start(f.binding.id);
    f.exits[0]();f.exits[0]();assert.equal(f.service.view(f.binding.id).status,'reconnecting');
    t.mock.timers.tick(300000);await tick();assert.equal(f.events.length,2);
    f.exits[1]();f.service.stop(f.binding.id);
    t.mock.timers.tick(600000);await tick();assert.equal(f.events.length,2);
    assert.equal(f.service.view(f.binding.id).status,'stopped');
});
test('restart restores enabled disk bindings without AIChat and waits for an existing listener to exit',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const f=fixture(t);await f.service.start(f.binding.id);
    const paused=f.service.configure({root:f.root,profile:'corp:paused',config:policy.defaultMessageConfig(),prompt:policy.DEFAULT_PROMPT});
    f.service.close();f.conflict=true;
    const restored=f.createService();restored.resume();await tick();
    assert.equal(restored.view(f.binding.id).status,'reconnecting');
    assert.equal(restored.view(f.binding.id).enabled,true);
    assert.equal(restored.view(f.binding.id).needsRepair,false);
    assert.equal(restored.view(paused.id).enabled,false);
    assert.equal(f.events.length,1,'does not displace the previous listener');
    t.mock.timers.tick(300000);await tick();
    assert.equal(f.events.length,1,'only checks occupancy while another listener exists');
    f.conflict=false;t.mock.timers.tick(300000);await tick();
    assert.equal(restored.view(f.binding.id).listening,true);
    assert.equal(f.events.length,2);
    assert.equal(restored.view(paused.id).status,'stopped');
    assert.equal(f.logins.length,0);assert.equal(f.pending.length,0);assert.equal(f.sent.length,0);
    restored.stop(f.binding.id);restored.close();
    const stopped=f.createService();stopped.resume();await tick();
    assert.equal(stopped.view(f.binding.id).status,'stopped','explicit stop survives another restart');
    assert.equal(f.events.length,2);
});
test('authorization and missing CLI need repair; transient transport failures remain automatic',()=>{
    const {messagingNeedsRepair}=load('messaging',{'./aichatPresence':{latestAichatClient:()=>null},'./messagingExecutor':{}});
    assert.equal(messagingNeedsRepair(Error('DWS CLI unavailable')),true);
    assert.equal(messagingNeedsRepair({message:'DWS rejected the operation',detail:{code:'invalid_grant'}}),true);
    assert.equal(messagingNeedsRepair(Error('Listener disconnected')),false);
});


test('initial profile discovery retries read-only failures before asking AI for repair',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const f=fixture(t);f.connectionFailures=2;
    const connecting=f.service.connectAgent('owner','default-persona',f.root,'Persona');
    await tick();t.mock.timers.tick(1000);await tick();t.mock.timers.tick(2000);await tick();
    assert.equal((await connecting).listening,true);assert.equal(f.statusChecks,4);
});


test('explicit native authorization is single-flight and reconnects without model work',async t=>{
 const f=fixture(t);
 await f.service.connectAgent('owner','default-persona',f.root,'Persona');
 assert.equal(f.logins.length,0);
 await Promise.all([f.service.loginAgent('owner','default-persona',f.root,'Persona'),f.service.loginAgent('owner','default-persona',f.root,'Persona')]);
 assert.equal(f.logins.length,1);assert.equal(f.logins[0].profile,'corp:user');assert.equal(f.logins[0].root,f.root);
 assert.equal(f.service.view(f.binding.id).listening,true);assert.equal(f.pending.length,0);
});


test('native authorization uses CLI browser flow with scoped profile and discards credential output',async()=>{
 const calls=[];let code=0,drains=0;
 const {loginDws}=load('messagingDingtalk',{
  'node:fs':{...fs,existsSync:()=>true,statSync:()=>({isFile:()=>true})},
  'node:child_process':{spawn:(exe,args,options)=>{calls.push({args,options});const c=new EventEmitter();c.stdout={resume(){drains++;}};c.stderr={resume(){drains++;}};c.kill=()=>{};process.nextTick(()=>c.emit('close',code));return c;}}
 });
 await loginDws(os.tmpdir(),'corp:user');assert.deepEqual(calls[0].args,['auth','login','--profile','corp:user']);
 assert.equal(calls[0].options.shell,false);assert.equal(drains,2);
 code=1;await assert.rejects(loginDws(os.tmpdir()),/cancelled or failed/);
});


test('Feishu persisted binding owns polling, inbox, delivery and cached status independently of DingTalk',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-feishu-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'brain');fs.mkdirSync(root);let checks=0,stops=0,receive;const sent=[];
 const module=load('messaging',{
  './aichatPresence':{latestAichatClient:()=>null},
  './messagingFeishu':{feishuIdentity:async()=>{checks++;return {id:'app:person',self:'person'};},pollFeishu:async(_r,_p,_f,onMessage,_error,onPoll)=>{receive=onMessage;onPoll(Date.now());return()=>stops++;},FeishuDelivery:class{async create(){return '';}async send(...args){sent.push(args);}}},
  './messagingExecutor':{messagingExecutorChoice:()=>({backend:'aichat'}),MessagingWorkers:class{async answer(){return 'fixture answer';}close(){}}}
 });
 const home=path.join(dir,'state'),service=new module.MessagingService(home,8089);t.after(()=>service.close());
 const b=await service.connectFeishuAgent('owner','agent',root,'prompt');assert.equal(b.listening,true);assert.equal(b.transport,'polling');assert.equal(b.pollIntervalMs,600000);assert.ok(b.lastPollAt);assert.equal(b.channel,'feishu');
 const before=checks;for(let i=0;i<5;i++)service.agentBindings('owner','agent');await service.connectFeishuAgent('owner','agent',root,'prompt');assert.equal(checks,before);
 receive({id:'message',conversation:'chat',sender:'peer',text:'hello',time:Date.now(),kind:'direct'});await tick();await tick();assert.equal(sent.length,1);
 receive({id:'message',conversation:'chat',sender:'peer',text:'hello',time:Date.now(),kind:'direct'});await tick();assert.equal(sent.length,1);
 assert.equal(service.inboxView('owner','agent',b.id).conversations.length,1);
 service.close();assert.ok(stops);const resumed=new module.MessagingService(home,8089);t.after(()=>resumed.close());resumed.resume();await tick();await tick();assert.equal(resumed.view(b.id).listening,true);
 resumed.stop(b.id);assert.equal(resumed.view(b.id).status,'stopped');
});

test('Feishu searches one recent page per tick, never lists chats, and resumes pagination after failure',async t=>{
 const {pollFeishu}=load('messagingFeishu');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-feishu-search-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'cursor.json');fs.writeFileSync(file,JSON.stringify({since:Date.now()-86400000,chats:{old:1}}));
 const rows=[],calls=[];let fail=false;
 const call=async args=>{if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'self'}}};
 calls.push(args);assert.equal(args[1],'+messages-search');assert.equal(args.includes('--page-all'),false);assert.equal(args[args.indexOf('--page-size')+1],'50');
 const start=Date.parse(args[args.indexOf('--start')+1]),end=Date.parse(args[args.indexOf('--end')+1]);assert.ok(end-start<=660000);
 if(fail)throw Error('temporary disconnect');
 return {data:{messages:[{message_id:args.includes('--page-token')?'two':'one',chat_id:'chat',chat_type:'p2p',sender:{id:'peer'},msg_type:'text',content:'hello',create_time:end-1000}],has_more:!args.includes('--page-token'),page_token:'next'}};
 };
 let stop=await pollFeishu(dir,'app:self',file,m=>rows.push(m),()=>{},()=>{},call,60000);stop();
 assert.equal(calls.length,1);assert.deepEqual(rows.map(m=>m.id),['one']);const saved=fs.readFileSync(file,'utf8');assert.equal(JSON.parse(saved).window.token,'next');
 fail=true;await assert.rejects(pollFeishu(dir,'app:self',file,m=>rows.push(m),()=>{},()=>{},call),/temporary/);assert.equal(fs.readFileSync(file,'utf8'),saved);
 fail=false;stop=await pollFeishu(dir,'app:self',file,m=>rows.push(m),()=>{},()=>{},call,60000);stop();
 assert.equal(calls.at(-1)[calls.at(-1).indexOf('--page-token')+1],'next');assert.deepEqual(rows.map(m=>m.id),['one','two']);assert.equal(JSON.parse(fs.readFileSync(file)).window,undefined);
});

test('Feishu rejects bot-only auth and identity changes before any message request',async()=>{
 const {feishuIdentity,pollFeishu}=load('messagingFeishu');
 await assert.rejects(feishuIdentity('.',undefined,async()=>({appId:'app',identities:{bot:{status:'ready',verified:true}}})),/login required/);
 await assert.rejects(feishuIdentity('.','app:self',async()=>({appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'other'}}})),/identity does not match/);
});

test('every AI reply segment retains echo marker and stays within DWS byte limit',async()=>{
    const sent=[];
    const {DingTalkDelivery}=load('messagingDingtalk',{
        'node:fs':{...fs,existsSync:()=>true,statSync:()=>({isFile:()=>true})},
        'node:child_process':{spawn:(_exe,args)=>{sent.push(args[args.indexOf('--text')+1]);const c=new EventEmitter();c.stdout=new EventEmitter();c.stdout.setEncoding=()=>{};c.stderr={resume(){}};c.stdin={end(){}};process.nextTick(()=>{c.stdout.emit('data','{}');c.emit('close',0);});return c;}},
    });
    const answer='课程🙂'.repeat(2000);
    await new DingTalkDelivery('.', 'corp:user').send(policy.incoming(message()),'reply','【AI 代答】'+answer);
    assert.ok(sent.length>1);assert.ok(sent.every(s=>s.startsWith('【AI 代答】')&&Buffer.byteLength(s)<=6000));
    assert.equal(sent.map(s=>s.slice('【AI 代答】'.length)).join(''),answer);
});


test('DingTalk self mentions use events, deduplicate and suppress echoes and ordinary self messages',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    const event={...message('own','group-dm','owner'),type:'user_im_message_receive_at'};
    f.events[0]({...event,type:'user_im_message_receive_group'});await tick();
    assert.equal(f.pending.length,0);
    f.events[0](event);f.events[0](event);await tick();
    assert.equal(f.pending.length,1);f.pending[0].end();await tick();
    assert.equal(f.sent.length,1);assert.equal(f.sent[0][0].kind,'mention');
    assert.equal(f.sent[0][0].conversation,'group-dm');
    f.events[0]({...event,message_id:'echo',content:f.sent[0][2]});
    f.events[0]({...event,message_id:'old',create_time:1});
    f.events[0](message('self-dm','dm','owner'));await tick();
    assert.equal(f.pending.length,1);
    f.service.stop(f.binding.id);f.events[0]({...event,message_id:'after-stop'});await tick();
    assert.equal(f.pending.length,1);
});

test('self mention exception is explicit and does not allow ordinary self group or direct messages',()=>{
    const config=policy.defaultMessageConfig(),m={...policy.incoming(message()),sender:'owner',kind:'mention'};
    assert.equal(policy.trigger(m,config,0,'owner',true),'reply');
    assert.equal(policy.trigger(m,config,0,'owner',false),'self');
    for(const kind of ['group','direct'])assert.equal(policy.trigger({...m,kind},config,0,'owner',true),'self');
    assert.equal(policy.trigger({...m,text:'【AI 代答】reply'},config,0,'owner',true),'echo');
});
