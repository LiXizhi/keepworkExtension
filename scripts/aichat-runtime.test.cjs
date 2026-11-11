const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(process.env.PERSONA_EXECUTION_PROOF&&f.endsWith(path.join('core','personas.ts'))?process.env.PERSONA_EXECUTION_PROOF:f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {createMcpAgentRuntime,keepworkRuntimeRequest}=require('../src/core/aichatRuntime.ts');
const {Personas}=require('../src/core/personas.ts');
const {rememberAichatClient,noteAichatSessionClosed}=require('../src/core/aichatPresence.ts');
const {AichatWorkspaceFiles}=require('../src/core/aichatWorkspaceFiles.ts');
const crypto=require('node:crypto');
const next=()=>new Promise(r=>setImmediate(r));
const response=value=>new Response(JSON.stringify(value),{status:200});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Timed out waiting for fixture');}
function fixture(t,fetchImpl){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'aichat-runtime-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
    const capability=crypto.randomBytes(24).toString('hex'),origin='https://keepwork.com',owner=crypto.createHash('sha256').update(origin+'\0'+capability).digest('hex');
    rememberAichatClient({sessionId:capability,owner:capability,origin,url:origin+'/chat',token:'fixture-secret'});noteAichatSessionClosed(capability);
    const sessions={workspaceFiles:new AichatWorkspaceFiles(path.join(home,'drafts')),list:()=>[],create:async()=>{throw Error('native init failed');}};
    const messaging={setAgentRootResolver(){},setPersonaLookup(){},watch:()=>()=>{},setAgentPrompt(){},agentBindings:()=>[],workers:{answer(){throw Error('Browser worker must not launch');}}};
    const service=new Personas(home,sessions,messaging,(login,execute,options)=>createMcpAgentRuntime(login,execute,{...options,fetch:fetchImpl}));t.after(()=>service.close());
    service.upsert(owner,{id:'persona',name:'test',root:home,executor:'keepwork'});
    return {service,owner,home,sessions};
}
test('persona streams one root draft before completion, replaces tool turns and commits only a validated final answer',async t=>{
    const sources=[];
    const f=fixture(t,async()=>new Response(new ReadableStream({start(controller){sources.push(controller);}}),{headers:{'content-type':'text/event-stream'}}));
    const send=(index,value)=>sources[index].enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));
    f.service.submit(f.owner,'persona',{requestId:'streamed',text:'list files'});
    await until(()=>sources.length===1);
    let own=0,other=0;const stop=f.service.watch(f.owner,()=>own++,()=>{}),stopOther=f.service.watch('other',()=>other++,()=>{});t.after(stop);t.after(stopOther);
    send(0,{result:'正在核对'});
    await until(()=>f.service.read(f.owner,'persona').job.output?.text==='正在核对');
    const partial=f.service.read(f.owner,'persona');
    assert.equal(partial.job.state,'running');assert.equal(partial.messages.length,1);assert.equal(partial.unread,0);assert.ok(own>0);assert.equal(other,0);
    assert.throws(()=>f.service.read('other','persona'),/不存在/);
    // Neither streamed arguments nor a claimed receipt can execute a partial call.
    send(0,{tool_calls_delta:[{index:0,function:{name:'list_dir',arguments:'{"path":'}}]});
    await next();assert.equal(f.service.read(f.owner,'persona').messages.length,1);assert.equal(sources.length,1);
    send(0,{tool_calls:[call('list','list_dir',{path:'.'})],stop_reason:'tool_calls'});sources[0].close();
    await until(()=>sources.length===2);
    assert.equal(f.service.read(f.owner,'persona').job.output?.text,'','A new model iteration replaces its draft');
    send(1,{result:'目录已核对'});
    await until(()=>f.service.read(f.owner,'persona').job.output?.text==='目录已核对');
    assert.equal(f.service.read(f.owner,'persona').messages.length,1);
    send(1,{stop_reason:'stop'});sources[1].close();
    await until(()=>f.service.read(f.owner,'persona').job.state==='done');
    const final=f.service.read(f.owner,'persona');
    assert.equal(final.job.output,undefined);assert.equal(final.messages.length,2);assert.equal(final.messages.at(-1).id,'streamed-answer');
    assert.equal(final.messages.at(-1).text,'目录已核对');assert.deepEqual(final.messages.at(-1).execution,{source:'keepwork-runtime',requested:1,returned:1});
    f.service.submit(f.owner,'persona',{requestId:'streamed',text:'list files'});assert.equal(sources.length,2,'Legacy retry keeps request identity');
});
test('cancelled and failed previews stay incomplete, never enter history, and late tokens cannot overwrite a new task',async t=>{
    const sources=[];let requests=[];
    const f=fixture(t,async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(new ReadableStream({start(controller){sources.push(controller);}}),{headers:{'content-type':'text/event-stream'}});});
    const send=(index,value)=>sources[index].enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));
    f.service.submit(f.owner,'persona',{requestId:'cancelled',text:'first'});await until(()=>sources.length===1);
    send(0,{result:'未完成的私有草稿'});await until(()=>!!f.service.read(f.owner,'persona').job.output);
    await f.service.cancel(f.owner,'persona');await next();
    let state=f.service.read(f.owner,'persona');assert.equal(state.job.state,'cancelled');assert.equal(state.job.output.text,'未完成的私有草稿');assert.equal(state.messages.length,1);
    f.service.submit(f.owner,'persona',{requestId:'failed',text:'second'});await until(()=>sources.length===2);
    assert.doesNotMatch(JSON.stringify(requests[1]),/未完成的私有草稿/);
    assert.equal(f.service.read(f.owner,'persona').job.output,undefined);
    try{send(0,{result:'late old text',stop_reason:'stop'});}catch{/* Cancel closes the old reader. */}
    send(1,{result:'失败前的部分正文'});await until(()=>!!f.service.read(f.owner,'persona').job.output);
    sources[1].close();await until(()=>f.service.read(f.owner,'persona').job.state==='error');
    state=f.service.read(f.owner,'persona');assert.equal(state.job.output.text,'失败前的部分正文');assert.equal(state.messages.length,2);assert.equal(state.unread,0);assert.equal(requests.length,2);
    const restarted=new Personas(f.home,f.sessions,{setAgentRootResolver(){},watch:()=>()=>{},setAgentPrompt(){},agentBindings:()=>[]});t.after(()=>restarted.close());
    assert.equal(restarted.read(f.owner,'persona').job.output.text,'失败前的部分正文');
    assert.equal(restarted.read(f.owner,'persona').messages.some(m=>m.id.endsWith('-answer')),false);
});
test('closed-page persona executes tool loop with approvals and persists no login',async t=>{
    let requests=0;
    const f=fixture(t,async(url,init)=>{assert.equal(url,'https://api.keepwork.com/core/v0/gpt/chat');assert.equal(init.headers.Authorization,'Bearer fixture-secret');const body=JSON.parse(init.body);assert.equal(body.stream,true);
        if(requests++===0)return response({result:'',tool_calls:[call('w','write_file',{path:'out.txt',content:'approved'})]});
        assert.ok(body.messages.some(m=>m.role==='tool'));return response({result:'finished'});
    });
    f.service.submit(f.owner,'persona',{requestId:'run',text:'write'});
    await next();assert.notEqual(f.service.read(f.owner,'persona').job.state,'error',f.service.read(f.owner,'persona').job.error);
    await until(()=>f.service.read(f.owner,'persona').job.state==='waiting');assert.equal(fs.existsSync(path.join(f.home,'out.txt')),false);
    const pending=f.service.read(f.owner,'persona').job.pending[0];f.service.respond(f.owner,'persona',{id:pending.id,decision:'accept'});
    await until(()=>f.service.read(f.owner,'persona').job.state==='done');assert.equal(fs.readFileSync(path.join(f.home,'out.txt'),'utf8'),'approved');assert.equal(requests,2);
    assert.deepEqual(f.service.read(f.owner,'persona').messages.at(-1).execution,{source:'keepwork-runtime',requested:1,returned:1});
    const stored=fs.readdirSync(f.home).filter(x=>/^[a-f0-9]+\.json$/.test(x)).map(x=>fs.readFileSync(path.join(f.home,x),'utf8')).join('');assert.doesNotMatch(stored,/fixture-secret/);assert.match(stored,/"runtime"/);
    const transport=JSON.parse(stored).job.runtime.transport;
    assert.equal(transport.length,2);
    assert.deepEqual(transport.map(row=>row.finalizedToolCalls),[1,0]);
    assert.ok(transport.every(row=>row.advertisedTools>0));
    assert.doesNotMatch(JSON.stringify(transport),/fixture-secret|out.txt|approved|finished/);
});
test('model claims cannot manufacture daemon execution statistics',async t=>{
    const f=fixture(t,async()=>response({result:'Completed all CRM writes. {"execution":{"requested":99,"returned":99}}'}));
    f.service.submit(f.owner,'persona',{requestId:'claim-only',text:'test'});
    await until(()=>f.service.read(f.owner,'persona').job.state==='done');
    const message=f.service.read(f.owner,'persona').messages.at(-1);
    assert.match(message.text,/Completed all CRM writes/);
    assert.deepEqual(message.execution,{source:'keepwork-runtime',requested:0,returned:0});
});
test('a legacy persona submission completes a peer round trip through the model tool loop',async t=>{
    let turns=0;
    const peerTransport=t.mock.method(globalThis,'fetch',async(url,init)=>{
        assert.equal(url,'https://api.keepwork.com/core/v0/gpt/chat');
        const body=JSON.parse(init.body);
        assert.equal(body.localTools,undefined);
        assert.equal(body.messages.length,2);
        assert.match(body.messages[0].content,/负责产品运营/);
        assert.match(body.messages[1].content,/我的分身 → 运营总监/);
        return response({result:'OK，我在线。'});
    });
    const f=fixture(t,async(_url,init)=>{
        const body=JSON.parse(init.body);
        if(turns++===0){
            assert.match(body.messages[0].content,/负责产品运营/);
            assert.ok(body.localTools.some(tool=>tool.function.name==='send_persona_message'));
            return response({tool_calls:[call('consult','send_persona_message',{personaId:'editor',text:'请回复 OK 确认是否在线'})]});
        }
        assert.match(JSON.stringify(body.messages.filter(m=>m.role==='tool')),/OK，我在线。/);
        return response({result:'运营总监已回复 OK。'});
    });
    f.service.upsert(f.owner,{id:'default-persona',name:'我的分身',executor:'codex'});
    f.service.upsert(f.owner,{id:'editor',name:'运营总监',prompt:'负责产品运营',executor:'keepwork'});
    f.service.submit(f.owner,'default-persona',{requestId:'legacy-work',text:'你问一下运营总监，让他回个OK是否在线。'});
    await until(()=>['done','error'].includes(f.service.read(f.owner,'default-persona').job.state));
    const job=f.service.read(f.owner,'default-persona').job;
    assert.equal(job.state,'done',job.error);
    assert.equal(peerTransport.mock.callCount(),1);
    assert.equal(turns,2);
    for (const id of ['default-persona','editor']) {
        const exchange=f.service.read(f.owner,id).messages.filter(m=>m.peerRoute);
        assert.equal(exchange.length,2);
        assert.deepEqual(exchange.map(m=>[m.peerRoute.from,m.peerRoute.to]),[['我的分身','运营总监'],['运营总监','我的分身']]);
        assert.match(exchange[0].text,/确认是否在线/);
        assert.match(exchange[1].text,/OK，我在线/);
        const file=crypto.createHash('sha256').update(f.owner+'\0'+id).digest('hex')+'.json';
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,file))).messages.filter(m=>m.peerRoute),exchange);
    }
    assert.equal(f.service.read(f.owner,'editor').messages.at(-1).text,'OK，我在线。');
    assert.equal(f.service.read(f.owner,'default-persona').messages.at(-1).text,'运营总监已回复 OK。');
});
test('failed tool results are counted as returns, never as business success',async t=>{
    let requests=0;
    const f=fixture(t,async()=>requests++===0?response({tool_calls:[call('missing','read_file',{path:'missing-file.txt'})]}):response({result:'Model claims success despite missing file'}));
    f.service.submit(f.owner,'persona',{requestId:'failed-tool',text:'test'});
    await until(()=>f.service.read(f.owner,'persona').job.state==='done');
    assert.deepEqual(f.service.read(f.owner,'persona').messages.at(-1).execution,{source:'keepwork-runtime',requested:1,returned:1});
    assert.equal(fs.existsSync(path.join(f.home,'missing-file.txt')),false);
});
test('daemon schedules use runtime without page; cancel prevents a late tool',async t=>{
    let release,requests=0;const f=fixture(t,async()=>{requests++;return new Promise(r=>{release=r;});});
    f.service.schedule(f.owner,'persona',{id:'daily',title:'daily',prompt:'task',time:'09:00',timezone:'UTC',enabled:true});const scheduled=f.service.read(f.owner,'persona').schedules[0];f.service.tick(scheduled.next);await until(()=>requests===1);
    await f.service.cancel(f.owner,'persona');release(response({tool_calls:[call('x','write_file',{path:'late.txt',content:'no'})]}));await next();assert.equal(fs.existsSync(path.join(f.home,'late.txt')),false);assert.equal(f.service.read(f.owner,'persona').job.state,'cancelled');
});
test('native pre-submission fallback uses runtime; missing owner never borrows login',async t=>{
    let requests=0;const f=fixture(t,async()=>{requests++;return response({result:'fallback'});});f.service.upsert(f.owner,{id:'persona',name:'test',root:f.home,executor:'codex'});
    f.service.submit(f.owner,'persona',{requestId:'fallback',text:'go'});await until(()=>f.service.read(f.owner,'persona').job.state==='done');assert.equal(requests,1);
    f.service.upsert('different-owner',{id:'other',name:'other',root:f.home,executor:'keepwork'});f.service.submit('different-owner','other',{requestId:'missing',text:'go'});await until(()=>f.service.read('different-owner','other').job.state==='needs-login');assert.equal(requests,1);
});
test('expired credentials and unsafe API origins do not leak or retry',async()=>{
    let requests=0;await assert.rejects(keepworkRuntimeRequest({token:'secret',baseURL:'https://api.keepwork.com/core/v0'},{messages:[]},async()=>{requests++;return new Response('',{status:401});}),/登录/);assert.equal(requests,1);
    await assert.rejects(keepworkRuntimeRequest({token:'secret',baseURL:'https://evil.example/core/v0'},{},async()=>{throw Error('must not fetch');}),/origin/);
});
test('workspace aliases, skills and custom teams use daemon providers with bounded grants',async t=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'team-runtime-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'.github/skills/review'),{recursive:true});fs.writeFileSync(path.join(home,'AGENTS.md'),'workspace rule');fs.writeFileSync(path.join(home,'.github/skills/review/SKILL.md'),'Review carefully');
    let root=0,child=0;const snapshots=[];const files=new AichatWorkspaceFiles(path.join(home,'drafts'));
    const runtime=createMcpAgentRuntime({token:'fixture',baseURL:''},async()=>{throw Error('unexpected external tool');},{workspaceFiles:files,persist:s=>snapshots.push(s),fetch:async(_url,init)=>{
        const body=JSON.parse(init.body),system=body.messages[0].content;
        assert.match(system,/workspace rule/);
        if(system.includes('reviewer')){assert.match(system,/Review carefully/);if(child++===0)return response({tool_calls:[call('read','workspace_file',{operation:'read',path:'//.brain/AGENTS.md'})]});return response({result:'review done'});}
        return root++===0?response({tool_calls:[call('delegate','runSubAgent',{member:'reviewer',prompt:'review'})]}):response({result:'team done'});
    }});runtime.registerWorkspaces('owner','team',{username:'fixture',primaryId:'brain',spaces:[{id:'brain',type:'local',root:home,aliases:['.brain']}]});
    const answer=await runtime.answer({id:'team-run',owner:'owner',workspaceId:'team',root:home,prompt:'leader',question:'go',history:[],tools:[],members:{reviewer:{prompt:'reviewer',skills:['review']}}},new AbortController().signal);
    assert.equal(answer,'team done');assert.ok(snapshots.some(s=>s.parentId==='team-run'));runtime.close();
});

test('persona prompt and current second brain reach interactive, scheduled and fallback runs; clearing drops the old grant',async t=>{
    const requests=[];let readNext=false;
    const f=fixture(t,async(_url,init)=>{
        const body=JSON.parse(init.body);requests.push(body);
        if(readNext){readNext=false;return response({tool_calls:[call('brain-read','workspace_file',{operation:'read',path:'//.brain/AGENTS.md'})]});}
        return response({result:'completed'});
    });
    const first=path.join(f.home,'brain-one'),second=path.join(f.home,'brain-two');
    for(const [folder,rule] of [[first,'BRAIN_ONE_RULE'],[second,'BRAIN_TWO_RULE']]){fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'AGENTS.md'),rule);}
    const configure=(root,prompt,executor='keepwork')=>f.service.upsert(f.owner,{id:'persona',name:'test',root,prompt,executor});
    const submit=async id=>{f.service.submit(f.owner,'persona',{requestId:id,text:'follow my brain instructions'});await until(()=>['done','error'].includes(f.service.read(f.owner,'persona').job.state));const job=f.service.read(f.owner,'persona').job;assert.equal(job.state,'done',job.error);};
    const system=()=>requests.at(-1).messages[0].content;
    configure(first,'PERSONA_PROMPT_ONE');readNext=true;await submit('first-brain');
    assert.match(system(),/PERSONA_PROMPT_ONE/);assert.match(system(),/BRAIN_ONE_RULE/);assert.ok(system().includes(fs.realpathSync(first)));
    assert.match(system(),/\/\/\.brain\//);
    assert.ok(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('BRAIN_ONE_RULE')));
    configure(second,'PERSONA_PROMPT_TWO');await submit('changed-brain');
    assert.match(system(),/PERSONA_PROMPT_TWO/);assert.match(system(),/BRAIN_TWO_RULE/);assert.doesNotMatch(system(),/BRAIN_ONE_RULE|PERSONA_PROMPT_ONE/);assert.ok(system().includes(fs.realpathSync(second)));
    f.service.schedule(f.owner,'persona',{id:'daily-brain',prompt:'scheduled task',time:'09:00',timezone:'UTC',enabled:true});
    f.service.tick(f.service.read(f.owner,'persona').schedules[0].next);await until(()=>f.service.read(f.owner,'persona').job.state==='done');
    assert.match(system(),/PERSONA_PROMPT_TWO/);assert.match(system(),/BRAIN_TWO_RULE/);
    configure(second,'PERSONA_FALLBACK_PROMPT','codex');await submit('fallback-brain');assert.match(system(),/PERSONA_FALLBACK_PROMPT/);assert.match(system(),/BRAIN_TWO_RULE/);
    configure('','PROMPT_WITHOUT_BRAIN');
    const runOwner=crypto.createHash('sha256').update(f.owner+'\0persona').digest('hex');assert.equal(f.sessions.workspaceFiles.snapshot(runOwner,'persona').authorized,false);
    await submit('cleared-brain');assert.match(system(),/PROMPT_WITHOUT_BRAIN/);assert.doesNotMatch(system(),/BRAIN_TWO_RULE|brain-two/);
    assert.equal(requests.at(-1).localTools.some(t=>t.function.name==='workspace_file'),false);
});

test('role workspace writes run autonomously and model-declared scope exceptions request approval',async t=>{
 let turn=0;
 const f=fixture(t,async(_url,init)=>{
  const body=JSON.parse(init.body);const tool=body.localTools.find(t=>t.function.name==='workspace_file');assert.equal(tool.function.parameters.properties.requireApproval.type,'boolean');
  if(turn++===0)return response({tool_calls:[call('inside','workspace_file',{operation:'write',path:'inside.md',content:'in scope'})]});
  if(turn===2)return response({tool_calls:[call('outside','workspace_file',{operation:'write',path:'outside.md',content:'exception',requireApproval:true,approvalReason:'Outside role'})]});
  return response({result:'done'});
 });
 f.service.upsert(f.owner,{id:'persona',name:'Role writer',root:f.home,executor:'keepwork',prompt:'Write inside.md; ask outside it.'});
 f.service.submit(f.owner,'persona',{requestId:'role-runtime',text:'Write files'});
 await until(()=>f.service.read(f.owner,'persona').job.state==='waiting');assert.equal(fs.readFileSync(path.join(f.home,'inside.md'),'utf8'),'in scope');assert.equal(fs.existsSync(path.join(f.home,'outside.md')),false);
 const ask=f.service.read(f.owner,'persona').job.pending[0];assert.equal(ask.params.requireApproval,true);f.service.respond(f.owner,'persona',{id:ask.id,decision:'accept'});
 await until(()=>f.service.read(f.owner,'persona').job.state==='done');assert.equal(fs.readFileSync(path.join(f.home,'outside.md'),'utf8'),'exception');
});
