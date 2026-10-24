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
    m.require = id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (id.startsWith('./')) {
            if (id.endsWith('.cjs')) return require(path.resolve(path.dirname(file),id));
            const base = path.basename(id).replace(/\.ts$/, '');
            if (fs.existsSync(path.resolve(__dirname, '../src/core', base + '.ts'))) return load(base, mocks);
        }
        return require(id);
    };
    m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file); return m.exports;
}
const policy = load('messagingPolicy');
const message = (id='1', conversation='dm', sender='sender') => ({type:'user_im_message_receive_o2o_all',message_id:id,conversation_id:conversation,sender_open_dingtalk_id:sender,content:'课程怎么学习',create_time:Date.now()+1000});
function fixture(t, channel = 'dingtalk') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-messaging-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const root=path.join(dir,'brain');fs.mkdirSync(path.join(root,'public'),{recursive:true});fs.writeFileSync(path.join(root,'public','lesson.md'),'课程学习计划：先读教材，再练习。');
    const logins=[], exits=[], events=[], sent=[], cards=[], updates=[], pending=[]; let remoteRows=null, contextError=false, answerText='课程学习答案'; let conflict=false, failure=false, active=0, max=0, connectionFailures=0, statusChecks=0;
    class BeforeSubmission extends Error {}
    const serviceModule=load('messaging',{
        './messagingFeishu':{feishuContext:load('messagingFeishu').feishuContext,feishuConversation:async(_r,_p,target)=>{if(contextError)throw Error('history unavailable');return structuredClone(remoteRows || [target]);},feishuIdentity:async()=>({id:'corp:user',self:'owner'}),pollFeishu:async(_r,_p,_f,event)=>{events.push(event);return()=>{};},FeishuDelivery:class{async create(){cards.push('created');return 'test-card';}async send(...args){sent.push(args);}}},
        './aichatPresence':{latestAichatClient:()=>null,latestAichatBrainRoot:()=>root},
        './messagingDingtalk':{dingtalkConversation:async(_r,_p,target)=>{if(contextError)throw Error('history unavailable');return structuredClone(remoteRows || [target]);},loginDws:async(root,profile)=>{logins.push({root,profile});},dws:async(args)=>{statusChecks++;if(connectionFailures-->0)throw Error('temporary connection reset');if(args[0]==='profile')return {currentProfile:'corp:user',profiles:[{corpId:'corp',userId:'user'}]};return {identity:{corp_id:'corp',user_id:'user',open_dingtalk_id:'owner'},bus:{live:{consumers:conflict?[{}]:[]}}};},listenDws:async(_r,_p,_c,event,exit)=>{events.push(event);exits.push(exit);return()=>{};},DingTalkDelivery:class{async create(){cards.push('created');return 'test-card';}async update(...args){updates.push(args);}async send(...args){sent.push(args);}}},
        './messagingExecutor':{BeforeSubmission,messagingExecutorChoice:()=>({backend:'copilot',model:''}),restrictedCliAnswer:async()=>{throw new BeforeSubmission();},MessagingWorkers:class{answer(input,signal){active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{const end=()=>{active--;failure?reject(Error('unknown')):resolve(answerText);};pending.push({input,end});signal.addEventListener('abort',()=>{active--;reject(Error('cancelled'));},{once:true});});}close(){}}},
    });
    const createService=()=>{const instance=new serviceModule.MessagingService(path.join(dir,'state'),8089);t.after(()=>instance.close());return instance;};
    const service=createService();
    const binding=service.configure({channel,root,profile:'corp:user',config:{...policy.defaultMessageConfig(),knowledge:['public']},prompt:policy.DEFAULT_PROMPT});
    return {set remoteRows(v){remoteRows=v;},set contextError(v){contextError=v;},set answerText(v){answerText=v;},service,createService,binding,root,events,exits,logins,sent,pending,updates,cards,get statusChecks(){return statusChecks;},set connectionFailures(v){connectionFailures=v;},get max(){return max;},set conflict(v){conflict=v;},set failure(v){failure=v;}};
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
test('dedup and per-conversation serialization with fresh conversation context',async t=>{
    const f=fixture(t);await f.service.start(f.binding.id);
    f.events[0](message('1'));f.events[0](message('1'));f.events[0](message('2'));
    await tick();assert.equal(f.pending.length,1);f.pending[0].end();await tick();await tick();assert.equal(f.pending.length,2);assert.equal(f.pending[1].input.history.length,1);f.pending[1].end();await tick();
    f.events[0](message('3','dm','different'));await tick();assert.equal(f.pending[2].input.history.length,1);f.pending[2].end();await tick();
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

test('selected agent CLI answers in the second brain with tools and is not replaced by another CLI', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-agent-reply-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const brain = path.join(dir, 'brain'); fs.mkdirSync(brain);
    const { restrictedCliAnswer, setMessagingAgentRunner, runMessagingAgentTurn, BeforeSubmission } = load('messagingExecutor', {
        './acpHarness': {}, './config': {}, './aichatPresence': {},
        './agentCliProcess': { resolveAgentCli: backend => { if (backend !== 'codex') throw Error('missing'); return {}; } },
    });
    let ran;
    setMessagingAgentRunner(async backend => { ran = backend; return 'cli-answer'; });
    const input = { prompt: 'rule', question: 'q', knowledge: 'public', history: [], brain: 'label', root: brain };
    assert.equal(await restrictedCliAnswer(dir, { ...policy.defaultMessageConfig(), executor: 'codex', model: 'chosen' }, input, new AbortController().signal), 'cli-answer');
    assert.equal(ran, 'codex');
    setMessagingAgentRunner(null);
    await assert.rejects(restrictedCliAnswer(dir, { ...policy.defaultMessageConfig(), executor: 'workbuddy' }, input, new AbortController().signal), BeforeSubmission);
    const sessions = {
        async create(owner, value) { this.created = { owner, value }; return { id: 'session' }; },
        subscribe(_id, _owner, fn) { fn({ session: { status: 'idle', pending: [], items: [{ type: 'agentMessage', text: 'too early' }] } }); this.fn = fn; return () => { this.unsubscribed = true; }; },
        async turn(_id, _owner, value) { this.turnInput = value; this.fn({ session: { status: 'running', pending: [{ id: 7, method: 'item/permissions/requestApproval' }], items: [] } }); this.fn({ session: { status: 'completed', pending: [], items: [{ type: 'reasoning', text: 'secret' }, { type: 'agentMessage', text: 'hello' }] } }); },
        respond(_id, _owner, value) { this.decision = value; },
        async interrupt() { this.interrupted = true; },
        async update(_id, _owner, value) { this.removed = value.remove; },
    };
    assert.equal(await runMessagingAgentTurn(sessions, dir, 'codex', 'chosen', input, new AbortController().signal), 'hello');
    assert.equal(sessions.created.value.mode, 'craft');
    assert.deepEqual(sessions.created.value.roots, [fs.realpathSync(brain)]);
    assert.equal(sessions.decision.decision, 'accept');
    assert.equal(sessions.turnInput.mode, 'craft');
    assert.equal(sessions.removed, true);
    assert.match(sessions.turnInput.text, /public/);
    assert.match(sessions.turnInput.text, /全部工具/);
    assert.doesNotMatch(sessions.turnInput.text, /secret|too early|没有工具权限/);
    await assert.rejects(runMessagingAgentTurn({ ...sessions, async create() { throw Error('CLI down'); } }, dir, 'codex', '', input, new AbortController().signal), BeforeSubmission);
});

test('Feishu replies use the persona agent CLI, while a client persona is answered by its own client', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-channel-reply-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'brain'); fs.mkdirSync(root);
    let backend = 'keepwork', own = { url: 'https://keepwork.com/chat', token: 'own-token', baseURL: '' }, anyClient = { url: 'https://keepwork.com/chat', token: 'any-token', baseURL: '' }, remembered = null, cliFails = false, receive;
    const cliCalls = [], cliInputs = [], clientLogins = [], workerInputs = [], sent = [];
    class BeforeSubmission extends Error {}
    const module = load('messaging', {
        './aichatPresence': { latestAichatClient: owner => owner === 'owner' ? own : remembered, anyAichatClient: () => anyClient, latestAichatBrainRoot: () => root },
        './messagingFeishu': { feishuContext: load('messagingFeishu').feishuContext, feishuConversation: async (_r, _p, target) => [target], feishuIdentity: async () => ({ id: 'app:person', self: 'person' }), pollFeishu: async (_r, _p, _f, onMessage) => { receive = onMessage; return () => {}; }, FeishuDelivery: class { async create() { return ''; } async send(...args) { sent.push(args); } } },
        './messagingExecutor': { BeforeSubmission, messagingExecutorChoice: () => ({ backend: 'copilot', model: '' }), restrictedCliAnswer: async (_home, config, input) => { cliCalls.push(config.executor); cliInputs.push(input); if (cliFails) throw new BeforeSubmission('unavailable'); return '来自 ' + config.executor; }, MessagingWorkers: class { async answer(input, _signal, login) { workerInputs.push(input); clientLogins.push(login || null); return '客户端回复'; } close() {} } },
    });
    const service = new module.MessagingService(path.join(dir, 'state'), 8089);
    t.after(() => service.close());
    service.setPersonaLookup(() => ({ backend, model: backend === 'codex' ? 'gpt-5.4' : '' }));
    const connected = await service.connectFeishuAgent('owner', 'agent', root, 'prompt');
    const serving = () => service.view(connected.id).serving;
    const deliver = async text => { receive({ id: 'm-' + sent.length + '-' + cliCalls.length, conversation: 'chat', sender: 'peer', text, time: Date.now() + 1000, kind: 'direct' }); for (let i = 0; i < 20 && sent.length === before; i++) await tick(); };
    let before = 0;
    await deliver('client persona');
    assert.deepEqual(cliCalls, []);
    assert.equal(clientLogins[0].token, 'own-token');
    assert.equal(workerInputs[0].root, fs.realpathSync(root));
    assert.deepEqual(workerInputs[0].tools.map(tool => tool.function.name), ['read_file', 'list_dir', 'write_file', 'run_terminal']);
    assert.equal(serving().server, 'client');
    assert.equal(serving().model, 'keepwork-pro');
    assert.equal(serving().active, false);
    assert.match(sent[0][2], /客户端回复/);
    backend = 'codex'; before = sent.length;
    await deliver('agent cli');
    assert.deepEqual(cliCalls, ['codex']);
    assert.equal(cliInputs[0].root, fs.realpathSync(root));
    assert.equal(cliInputs[0].tools.length, 4);
    assert.equal(clientLogins.length, 1);
    assert.equal(serving().server, 'cli');
    assert.equal(serving().executor, 'codex');
    assert.equal(serving().model, 'gpt-5.4');
    assert.equal(serving().next, null);
    assert.match(sent[1][2], /来自 codex/);
    cliFails = true; own = null; before = sent.length;
    await deliver('fallback client');
    assert.deepEqual(cliCalls, ['codex', 'codex']);
    assert.equal(clientLogins[1].token, 'any-token');
    anyClient = null; remembered = null; before = sent.length;
    await deliver('headless');
    assert.equal(clientLogins.at(-1), null);
    assert.equal(workerInputs.at(-1).root, fs.realpathSync(root));
    assert.equal(workerInputs.at(-1).tools.length, 4);
    assert.equal(serving().server, 'headless');
    assert.equal(serving().model, 'keepwork-pro');
    assert.equal(serving().next.server, 'cli');
    assert.equal(serving().next.model, 'gpt-5.4');
    backend = 'aichat'; own = { url: 'https://keepwork.com/chat', token: 'own-token', baseURL: '' }; anyClient = { url: 'https://keepwork.com/chat', token: 'any-token', baseURL: '' }; before = sent.length;
    await deliver('own client again');
    assert.deepEqual(cliCalls, ['codex', 'codex', 'codex']);
    assert.equal(clientLogins.at(-1).token, 'own-token');
});


test('IM brain tools stay inside the second brain', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-brain-tools-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'brain'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'note.txt'), 'inside');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
    const { messagingBrainTool } = load('messaging', {
        './aichatPresence': {},
        './messagingExecutor': { MessagingWorkers: class { close() {} } },
    });
    const signal = new AbortController().signal;
    assert.equal(await messagingBrainTool(root, 'read_file', { path: 'note.txt' }, signal), 'inside');
    await assert.rejects(messagingBrainTool(root, 'read_file', { path: '../secret.txt' }, signal), /outside/);
    assert.deepEqual(await messagingBrainTool(root, 'write_file', { path: 'out.txt', content: 'saved' }, signal), { written: true });
    assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'saved');
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
    const shared=await f.service.connectAgent('another','default-persona',f.root,'Other');
    assert.equal(shared.id,first.id);assert.equal(f.events.length,1);assert.equal(profiles,1);
    assert.equal(shared.agentOwner,'owner');assert.equal(shared.agentPrompt,'Persona prompt');
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
    const {messagingNeedsRepair}=load('messaging',{'./aichatPresence':{latestAichatClient:()=>null,latestAichatBrainRoot:()=>root},'./messagingExecutor':{}});
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
  './aichatPresence':{latestAichatClient:()=>null,latestAichatBrainRoot:()=>root},
  './messagingFeishu':{feishuContext:load('messagingFeishu').feishuContext,feishuConversation:async(_r,_p,target)=>[target],feishuIdentity:async()=>{checks++;return {id:'app:person',self:'person'};},pollFeishu:async(_r,_p,_f,onMessage,_error,onPoll)=>{receive=onMessage;onPoll(Date.now());return()=>stops++;},FeishuDelivery:class{async create(){return '';}async send(...args){sent.push(args);}}},
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

test('bot identities and automated cards/notices are ignored by channel policy',()=>{
 const {feishuIncoming}=load('messagingFeishu');
 for(const text of ['  @owner 【AI 代答】answer','[interactiveCard]','@owner 暂不支持解析「interactiveCard」类型的消息。']){
  assert.equal(policy.trigger(policy.incoming({...message(),content:text}),policy.defaultMessageConfig(),0,'owner'),'echo');
  const row=feishuIncoming({message_id:'f',sender:{id:'peer'},create_time:Date.now(),msg_type:'text',content:JSON.stringify({text})},{chat_id:'chat',chat_mode:'p2p'},'owner');
  assert.equal(policy.trigger(row,policy.defaultMessageConfig(),0,'owner'),'echo');
 }
 for(const type of ['app','bot','robot']){
  assert.equal(policy.trigger(policy.incoming({...message(),sender_type:type}),policy.defaultMessageConfig(),0,'owner'),'echo');
  assert.equal(feishuIncoming({message_id:'f',sender:{id:'bot',sender_type:type},create_time:Date.now(),msg_type:'text',content:'hello'},{chat_id:'chat',chat_mode:'p2p'},'owner'),null);
 }
});

for(const channel of ['dingtalk','feishu'])test(channel+' throttles after six replies without pausing, survives restart and resumes by timer',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t,channel);f.service.bindAgent('owner','agent',f.binding.id);await f.service.start(f.binding.id);
 const event=(id,conversation='dm',sender='peer')=>channel==='feishu'?{id,conversation,sender,text:'question',time:now+1000,kind:'direct'}:message(id,conversation,sender);
 for(let i=0;i<6;i++){f.events.at(-1)(event('fast-'+i));await tick();f.pending[i].end();await tick();}
 f.events.at(-1)(event('waiting','dm','different-sender'));await tick();
 assert.equal(f.pending.length,6);assert.equal(f.service.view(f.binding.id).active,0);
 assert.equal(f.service.inboxView('owner','agent',f.binding.id,'dm').paused,false);
 assert.equal(f.service.dashboardMessages()[0].reason,'auto-reply-rate-limit');
 f.service.close();const resumed=f.createService();await resumed.start(f.binding.id);
 f.events.at(-1)(event('after-restart'));await tick();assert.equal(f.pending.length,6);
 f.events.at(-1)(event('other','other-chat'));await tick();assert.equal(f.pending.length,7);f.pending[6].end();await tick();
 now+=240000;t.mock.timers.tick(240000);await tick();
 assert.equal(f.pending.length,8);f.pending[7].end();await tick();
 assert.equal(f.sent.length,8);assert.equal(resumed.view(f.binding.id).queued,0);
 resumed.stop(f.binding.id);
});

test('ten-minute conversation deadline overrides hourly cap without dropping or bursting queued replies',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t);f.service.bindAgent('owner','agent',f.binding.id);await f.service.start(f.binding.id);
 f.service.box(f.binding.id).autoReplyTimes={dm:Array(20).fill(now)};
 f.service.inboxAction('owner','agent',f.binding.id,'dm','resume');
 f.events[0](message('over-hour'));await tick();assert.equal(f.pending.length,0);
 f.events[0](message('over-hour-next'));await tick();
 now+=599999;t.mock.timers.tick(599999);await tick();assert.equal(f.pending.length,0);
 now+=1;t.mock.timers.tick(1);await tick();assert.equal(f.pending.length,1);
 f.pending[0].end();await tick();assert.equal(f.sent.length,1);
 assert.equal(f.service.view(f.binding.id).queued,1);
 assert.equal(f.service.box(f.binding.id).autoReplyTimes.dm.length,21);
 now+=600000;t.mock.timers.tick(600000);await tick();assert.equal(f.pending.length,2);
 f.pending[1].end();await tick();assert.equal(f.sent.length,2);
 assert.equal(f.service.view(f.binding.id).queued,0);
});

test('rate policy preserves burst, minute floor, rolling hourly cap and idle recovery',()=>{
 const {nextAutoReplyAt}=load('messaging',{'./aichatPresence':{},'./messagingExecutor':{}});
 const now=10000000;
 assert.equal(nextAutoReplyAt(Array(5).fill(now),now),now);
 assert.equal(nextAutoReplyAt(Array(6).fill(now),now),now+240000);
 assert.equal(nextAutoReplyAt(Array(6).fill(now),now+600000),now+600000);
 assert.equal(nextAutoReplyAt(Array(20).fill(now),now+600000),now+3600000);
 assert.equal(nextAutoReplyAt(Array(20).fill(now),now+3600000),now+3600000);
 let times=[];let current=now;
 for(let i=0;i<100;i++){
  current=nextAutoReplyAt(times,current);
  assert.ok(times.filter(time=>time>current-3600000).length<20);
  if(i>=6)assert.ok(current-times.at(-1)>=60000);
  times.push(current);
 }
});


test('Feishu uses all participants including own posts, retains self posts without replying, and supports silent output',async t=>{
 const f=fixture(t,'feishu');await f.service.start(f.binding.id);
 const now=Date.now()+1000;
 const own={id:'own',conversation:'dm',sender:'owner',text:'我接入了第二大脑',time:now,kind:'direct'};
 const target={...own,id:'peer',sender:'peer',text:'这个太牛了',time:now+1};
 f.remoteRows=[own,{...own,id:'third',sender:'third',text:'另一位参与者'},target];
 f.events[0](own);await tick();assert.equal(f.pending.length,0);
 f.events[0](target);await tick();
 const history=JSON.stringify(f.pending[0].input.history);
 assert.match(history,/我接入了第二大脑/);assert.match(history,/本人（人类）/);assert.match(history,/另一位参与者/);
 f.answerText='(...)';f.pending[0].end();await tick();assert.equal(f.sent.length,0);
 assert.equal(f.service.view(f.binding.id).recent[0].reason,'模型判断无需回复');
});
for(const change of ['human','peer','failure','recall','local','edit'])test('Feishu withholds generated answer after '+change,async t=>{
 const f=fixture(t,'feishu');await f.service.start(f.binding.id);
 const target={id:'target',conversation:'dm',sender:'peer',text:'问题',time:Date.now()+1000,kind:'direct'};
 f.remoteRows=[target];f.events[0](target);await tick();assert.equal(f.pending.length,1);
 if(change==='failure')f.contextError=true;
 else if(change==='recall')f.remoteRows=[];
 else if(change==='edit')f.remoteRows=[{...target,text:'修改后的问题'}];
 else {const newer={...target,id:'new',sender:change==='peer'?'other':'owner',text:'已解释完毕',time:target.time+1};
  if(change==='local')f.events[0](newer);else f.remoteRows=[target,newer];}
 f.pending[0].end();await tick();await tick();assert.equal(f.sent.length,0);
});
test('Feishu unchanged conversation sends once and echoed AI does not trigger',async t=>{
 const f=fixture(t,'feishu');await f.service.start(f.binding.id);
 const target={id:'target',conversation:'dm',sender:'peer',text:'问题',time:Date.now()+1000,kind:'direct'};
 f.events[0](target);await tick();f.pending[0].end();await tick();await tick();assert.equal(f.sent.length,1);
 f.events[0]({...target,id:'echo',sender:'owner',text:'【AI 代答】答案',automated:true});await tick();assert.equal(f.pending.length,1);
});
test('Feishu conversation reader includes own, bot, media and thread messages in chronological order',async()=>{
 const {feishuConversation}=load('messagingFeishu');const calls=[];
 const row=(id,sender,time,extra={})=>({message_id:id,sender:{id:sender},create_time:time,msg_type:'text',content:id,...extra});
 const call=async args=>{calls.push(args);if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'owner'}}};
  return {ok:true,data:{messages:args.includes('+threads-messages-list')?[row('reply','owner',3000),row('target','peer',2000)]:[
   row('target','peer',2000,{thread_id:'omt_thread'}),row('own','owner',1000),row('bot','app',1500,{sender:{id:'app',sender_type:'bot'}}),row('image','owner',1600,{msg_type:'image',content:'![Image](key)'}),row('deleted','owner',1700,{deleted:true})]}};};
 const rows=await feishuConversation('.','app:owner',{id:'target',conversation:'chat',kind:'direct'},undefined,call);
 assert.deepEqual(rows.map(m=>m.id),['own','bot','image','target','reply']);assert.equal(rows[1].automated,true);
 assert.ok(calls[1].includes('chat'));assert.ok(calls[2].includes('omt_thread'));assert.ok(calls[1].includes('--no-reactions'));
});

for(const mode of ['missing','failure'])test('Feishu does not generate with '+mode+' initial context',async t=>{
 const f=fixture(t,'feishu');await f.service.start(f.binding.id);
 if(mode==='failure')f.contextError=true;else f.remoteRows=[];
 f.events[0]({id:'target',conversation:'dm',sender:'peer',text:'问题',time:Date.now()+1000,kind:'direct'});
 await tick();assert.equal(f.pending.length,0);assert.equal(f.sent.length,0);
});

for(const mode of ['silent','human','peer','edit','failure','unchanged'])test('DingTalk conversation context and preflight: '+mode,async t=>{
 const f=fixture(t);await f.service.start(f.binding.id);
 const now=Date.now()+1000,own={id:'own',conversation:'dm',sender:'owner',text:'本人已经解释了背景',time:now,kind:'direct'};
 const target={...own,id:'target',sender:'peer',text:'还有一个问题',time:now+1};
 f.remoteRows=[own,{...own,id:'third',sender:'third',text:'其他人的上下文'},target];
 f.events[0]({...message('own','dm','owner'),content:own.text,create_time:now});await tick();assert.equal(f.pending.length,0);
 f.events[0]({...message('target','dm','peer'),content:target.text,create_time:now+1});await tick();assert.equal(f.pending.length,1);
 assert.match(JSON.stringify(f.pending[0].input.history),/本人已经解释了背景/);
 assert.match(JSON.stringify(f.pending[0].input.history),/其他人的上下文/);
 if(mode==='silent')f.answerText='(...)';
 if(mode==='failure')f.contextError=true;
 if(mode==='edit')f.remoteRows=[own,{...target,text:'改过的问题'}];
 if(mode==='human'||mode==='peer')f.remoteRows=[own,target,{...target,id:'new',sender:mode==='human'?'owner':'other',text:'回答完毕',time:now+2}];
 f.pending[0].end();await tick();await tick();assert.equal(f.sent.length,mode==='unchanged'?1:0);
});
test('DingTalk reader verifies identity, normalizes own userId, deduplicates threads and rejects partial reads',async()=>{
 const {dingtalkConversation}=load('messagingDingtalk');const calls=[];let fail=false,identityChanged=false;
 const row=(id,sender,time,extra={})=>({messageId:id,senderId:sender,createTime:time,text:id,conversationId:'cid',...extra});
 const call=async args=>{calls.push(args);if(args[0]==='event')return {identity:{corp_id:'corp',user_id:identityChanged?'other':'user',open_dingtalk_id:'owner'}};
  return {contractVersion:'im.message-list.v1',complete:false,hasMore:true,failures:fail?[{error:'fixture'}]:[],messages:args.includes('+thread-replies')?[row('reply','user',3000)]:[row('target','peer',2000,{threadId:'thread'}),row('own','user',1000),row('bot','bot',1500,{senderType:'bot'})]};};
 const target={id:'target',conversation:'dm',sender:'peer',kind:'direct'};
 const rows=await dingtalkConversation('.','corp:user',target,undefined,call);
 assert.deepEqual(rows.map(m=>m.id),['own','bot','target','reply']);assert.equal(rows[0].sender,'owner');assert.equal(rows[1].automated,true);
 assert.ok(calls[1].includes('--open-dingtalk-id'));assert.ok(calls[2].includes('cid'));assert.ok(calls.every(args=>args.includes('corp:user')));
 fail=true;await assert.rejects(dingtalkConversation('.','corp:user',target,undefined,call),/不完整/);
 fail=false;identityChanged=true;const count=calls.length;await assert.rejects(dingtalkConversation('.','corp:user',target,undefined,call),/identity/);assert.equal(calls.length,count+1);
});



test('channels reject missing roots and never borrow a recent chat brain', async t => {
    const f=fixture(t);
    assert.throws(()=>f.service.configure({root:'',profile:'corp:user',config:policy.defaultMessageConfig(),prompt:policy.DEFAULT_PROMPT}),/directory required/);
    await assert.rejects(f.service.profiles(''),/directory required/);
    await assert.rejects(f.service.connectFeishuAgent('owner','agent','','prompt'),/directory required/);
    assert.deepEqual(f.service.channelRoots(),{});
});

for(const channel of ['dingtalk','feishu']) test(channel+' pins its brain, conflicts without side effects, and switches only with the expected old root',async t=>{
 const f=fixture(t,channel), next=path.join(path.dirname(f.root),'next');fs.mkdirSync(next);
 const connect=root=>channel==='feishu'?f.service.connectFeishuAgent('owner','agent',root,'prompt'):f.service.connectAgent('owner','agent',root,'prompt');
 const first=await connect(f.root);
 assert.equal(f.service.channelRoots()[channel],fs.realpathSync(f.root));
 await assert.rejects(connect(next),e=>e.code==='CHANNEL_OCCUPIED'&&e.occupiedRoot===fs.realpathSync(f.root)&&e.requestedRoot===fs.realpathSync(next)&&e.confirmationRequired);
 assert.equal(f.service.view(first.id).enabled,true);
 await assert.rejects(f.service.switchChannel(channel,next,'stale-root'),e=>e.code==='CHANNEL_OCCUPIED');
 assert.equal(f.service.view(first.id).enabled,true);
 await f.service.switchChannel(channel,next,fs.realpathSync(f.root));
 assert.equal(f.service.view(first.id).enabled,false);
 const second=await connect(next);assert.equal(second.root,fs.realpathSync(next));
 await assert.rejects(f.service.start(first.id),e=>e.code==='CHANNEL_OCCUPIED');
 f.service.stop(second.id);
 assert.equal(f.createService().channelRoots()[channel],fs.realpathSync(next),'restart and stop retain ownership');
});

test('concurrent different brains cannot both claim DingTalk and stale switch confirmation cannot steal it',async t=>{
 const f=fixture(t),next=path.join(path.dirname(f.root),'other');fs.mkdirSync(next);
 const results=await Promise.allSettled([f.service.connectAgent('owner','one',f.root,'prompt'),f.service.connectAgent('other','two',next,'prompt')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results[1].reason.code,'CHANNEL_OCCUPIED');
 const a=f.service.switchChannel('dingtalk',next,fs.realpathSync(f.root));
 await assert.rejects(f.service.connectAgent('third','three',f.root,'prompt'),/switch in progress/);
 await a;
 await assert.rejects(f.service.switchChannel('dingtalk',f.root,fs.realpathSync(f.root)),e=>e.code==='CHANNEL_OCCUPIED');
});


for(const channel of ['dingtalk','feishu'])test(channel+' shares one listener across chat owners at the same brain, persisting access without replacing the responder',async t=>{
 const f=fixture(t,channel);
 const connect=(service,owner,id,prompt)=>channel==='feishu'?service.connectFeishuAgent(owner,id,f.root,prompt):service.connectAgent(owner,id,f.root,prompt);
 const first=await connect(f.service,'first','main','Original prompt');
 const second=await connect(f.service,'second','other','Must not replace original');
 assert.equal(second.id,first.id);assert.equal(f.events.length,1);
 assert.equal(second.agentOwner,'first');assert.equal(second.agentPrompt,'Original prompt');
 assert.equal(f.service.agentBindings('second','other')[0].id,first.id);
 assert.doesNotThrow(()=>f.service.assertAgentBinding('second','other',first.id));
 assert.throws(()=>f.service.assertAgentBinding('stranger','other',first.id));
 await connect(f.service,'second','other','Repeated');assert.equal(f.service.view(first.id).peers.length,1);
 const restarted=f.createService();assert.equal(restarted.agentBindings('second','other')[0].id,first.id);
 f.service.detachAgent('second','other');assert.equal(f.service.view(first.id).listening,true);assert.equal(f.service.agentBindings('second','other').length,0);
 const otherRoot=path.join(path.dirname(f.root),'different');fs.mkdirSync(otherRoot);
 const different=channel==='feishu'?f.service.connectFeishuAgent('third','third',otherRoot,'x'):f.service.connectAgent('third','third',otherRoot,'x');
 await assert.rejects(different,e=>e.code==='CHANNEL_OCCUPIED');
});


for(const channel of ['dingtalk','feishu'])test(channel+' status is shared by current brain before Connect and follows live state without CLI probes',async t=>{
 const f=fixture(t,channel), roots=new Map([['first',f.root],['second',path.join(f.root,'.')],['foreign',path.dirname(f.root)]]);
 f.service.setAgentRootResolver(owner=>roots.get(owner)||'');
 await f.service.start(f.binding.id);
 const checks=f.statusChecks,events=f.events.length;
 const first=f.service.agentBindings('first','default-persona'),second=f.service.agentBindings('second','default-persona');
 assert.deepEqual(second,first);assert.equal(second[0].status,'listening');assert.equal(second[0].listening,true);
 assert.equal(f.service.agentBindings('foreign','default-persona').length,0);
 assert.equal(f.service.agentBindings('unknown','default-persona').length,0);
 assert.doesNotThrow(()=>f.service.assertAgentBinding('second','default-persona',f.binding.id));
 let notifications=0;const unwatch=f.service.watch(()=>notifications++,()=>{});
 f.service.stop(f.binding.id);
 assert.equal(f.service.agentBindings('first','default-persona')[0].status,'stopped');
 assert.equal(f.service.agentBindings('second','default-persona')[0].status,'stopped');assert.ok(notifications>0);
 assert.equal(f.statusChecks,checks);assert.equal(f.events.length,events);assert.equal(f.service.view(f.binding.id).peers,undefined);
 roots.set('second','');assert.equal(f.service.agentBindings('second','default-persona').length,0);
 assert.throws(()=>f.service.assertAgentBinding('second','default-persona',f.binding.id));
 unwatch();
});


test('persona snapshots and notifications agree across clients before either client connects',async t=>{
 const f=fixture(t);
 const {Personas}=load('personas',{'./aichatPresence':{latestAichatBrainRoot:()=>'',latestAichatClient:()=>null},'./terminal':{}});
 const personas=new Personas(path.join(path.dirname(f.root),'personas'),{},f.service);t.after(()=>personas.close());
 for(const owner of ['one','two'])personas.upsert(owner,{id:'default-persona',name:owner,root:f.root});
 let first=0,second=0;personas.watch('one',()=>first++,()=>{});personas.watch('two',()=>second++,()=>{});
 await f.service.start(f.binding.id);
 const checks=f.statusChecks;
 assert.deepEqual(personas.list('one')[0].channels,personas.read('two','default-persona').channels);
 assert.equal(personas.read('two','default-persona').channels[0].status,'listening');
 assert.ok(first>0&&second>0);first=second=0;
 f.service.stop(f.binding.id);
 assert.equal(personas.read('one','default-persona').channels[0].status,'stopped');
 assert.equal(personas.read('two','default-persona').channels[0].status,'stopped');assert.ok(first>0&&second>0);
 personas.upsert('two',{id:'default-persona',name:'two',root:''});
 assert.deepEqual(personas.read('two','default-persona').channels,[]);
 assert.equal(f.statusChecks,checks);assert.equal(f.service.view(f.binding.id).agentOwner,undefined);
});

test('shared channel snapshot places the live binding before old stopped profiles',async t=>{
 const f=fixture(t,'feishu');f.service.setAgentRootResolver(()=>f.root);
 const newer=f.service.configure({channel:'feishu',root:f.root,profile:'corp:new',config:policy.defaultMessageConfig(),prompt:policy.DEFAULT_PROMPT});
 await f.service.start(newer.id);
 const rows=f.service.agentBindings('new-client','default-persona');
 assert.equal(rows[0].id,newer.id);assert.equal(rows[0].listening,true);assert.equal(rows[1].status,'stopped');
});

for(const chatMode of ['p2p','group'])test('Feishu explicit self mention in '+chatMode+' reaches persona once without reply loops',async t=>{
 const f=fixture(t,'feishu');await f.service.start(f.binding.id);
 const {feishuIncoming}=load('messagingFeishu');
 const row={message_id:'self-request',sender:{id:'owner'},create_time:Date.now()+1000,msg_type:'text',content:'@本人 帮我整理思路',mentions:[{id:{open_id:'owner'}}]};
 const chat={chat_id:'self-chat',chat_mode:chatMode};
 const target=feishuIncoming(row,chat,'owner');
 assert.equal(target.kind,chatMode==='p2p'?'direct':'mention');
 assert.equal(target.mentionedSelf,true);
 for(const mentions of [[],[{id:'other'}]]) {
  f.events[0](feishuIncoming({...row,message_id:'ignored-'+mentions.length,create_time:row.create_time-100,mentions},chat,'owner'));
 }
 await tick();assert.equal(f.pending.length,0);
 f.events[0](target);f.events[0](target);await tick();assert.equal(f.pending.length,1);
 assert.match(f.pending[0].input.prompt,/本人明确 @本人/);
 f.pending[0].end();await tick();await tick();assert.equal(f.sent.length,1);
 assert.equal(f.sent[0][0].conversation,'self-chat');assert.equal(f.sent[0][0].id,'self-request');
 f.events[0](feishuIncoming({...row,message_id:'echo',content:f.sent[0][2]},chat,'owner'));
 await tick();assert.equal(f.pending.length,1);
 assert.equal(feishuIncoming({...row,mentions:[{id:'owner'}]},chat,'owner').mentionedSelf,true);
});
