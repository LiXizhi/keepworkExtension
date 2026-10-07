const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {AgentSessions,AGENT_BACKENDS}=require('../src/core/agentSessions.ts');
const {AcpHarness}=require('../src/core/acpHarness.ts');
const {CodexHarness}=require('../src/core/codexHarness.ts');
const {ClaudeHarness}=require('../src/core/claudeHarness.ts');
const {AGENT_CLI}=require('../src/core/agentCliBackends.ts');
const claudeFixture=path.join(__dirname,'fixtures/fake-claude.cjs');
const codexFixture=path.join(__dirname,'fixtures/fake-codex-session.cjs');
const {cliCommand}=require('../src/core/agentCliProcess.ts');
const {handleAgentHttp}=require('../src/mcp/agentHttp.ts');
for (const backend of AGENT_BACKENDS) test(`${backend}: versioned AIChat context and scoped MCP survive two turns and reload without persisting capability`, async t => {
 const {manager, dir, file, owner, adapters} = setup(t);
 const adapter = adapters[backend], calls = [], original = adapter.call.bind(adapter);
 adapter.call = (method, params) => { calls.push({method, params}); return original(method, params); };
 const context = {pageId:'page',generation:'gen',instructions:'base prompt; selected skill; //.brain/',revision:'v1',tools:[]};
 manager.toolBridge.register(owner,'context-chat',context);
 const session = await manager.create(owner,{backend,conversationId:'context-chat',roots:[],cloudPrimary:true,contextVersion:1});
 const start = calls.find(c=>c.method==='thread/start').params;
 assert.ok(fs.statSync(start.cwd).isDirectory()); assert.ok(start.cwd.includes('agent-workspaces'));
 const descriptor = backend === 'codex' ? start.config.mcp_servers.keepwork_aichat : start.mcpServers[0];
 assert.ok(descriptor.command); assert.ok(descriptor.args.includes('-e'));
 assert.equal(session.context.version,1); assert.equal(session.context.revision,'v1'); assert.equal(session.context.pageId,'page'); assert.equal(session.context.workspace.authorized,false);
 assert.ok(!JSON.stringify(session.context).includes('KEEPWORK_AICHAT_CAPABILITY'));
 await manager.turn(session.id,owner,{requestId:'context-one',text:'first user message'});
 assert.equal((await done(manager,session.id,owner)).status,'completed');
 manager.toolBridge.register(owner,'context-chat',{...context,revision:'v2',instructions:'changed skill; same spaces'});
 await manager.turn(session.id,owner,{requestId:'context-two',text:'second user message'});
 assert.equal((await done(manager,session.id,owner)).status,'completed');
 const turns=calls.filter(c=>c.method==='turn/start');assert.equal(turns.length,2);
 assert.match(turns[0].params.input[0].text, /revision="v1"/);assert.match(turns[1].params.input[0].text,/changed skill/);
 const capability = backend === 'codex' ? descriptor.env.KEEPWORK_AICHAT_CAPABILITY : descriptor.env.find(e=>e.name==='KEEPWORK_AICHAT_CAPABILITY').value;
 manager.close();
 for(const name of fs.readdirSync(dir,{recursive:true}).filter(n=>n.endsWith('.json'))) assert.ok(!fs.readFileSync(path.join(dir,name),'utf8').includes(capability),name);
 const replacement=backend==='codex'?new CodexHarness(process.execPath,[codexFixture]):backend==='claude'?new ClaudeHarness(path.join(dir,backend),process.execPath,[claudeFixture]):new AcpHarness(backend,path.join(dir,backend),process.execPath,[fixture]);
 const restarted=new AgentSessions(file,undefined,{[backend]:replacement});t.after(()=>restarted.close());
 await restarted.read(session.id,owner);
 await assert.rejects(restarted.turn(session.id,owner,{requestId:'expired',text:'cannot run before reconnection'}),/Reconnect/);
 restarted.toolBridge.register(owner,'context-chat',{...context,pageId:'reconnected'});
 await restarted.turn(session.id,owner,{requestId:'restored',text:'continue'});
 assert.equal((await done(restarted,session.id,owner)).status,'completed');
});
const fixture=path.join(__dirname,'fixtures/fake-acp.cjs');
for (const backend of ['workbuddy', 'codebuddy']) test(`${backend}: process cwd follows each workspace after discovery, concurrent turns and restart`, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'buddy-workspaces-'));
 const roots=['primary 中文','other repo'].map(name=>{const root=path.join(dir,name);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'workspace-marker.txt'),name);return root;});
 const file=path.join(dir,'registry.json'), owner='cwd-test';
 const make=()=>new AcpHarness(backend,path.join(dir,'cache'),process.execPath,[path.join(__dirname,'fixtures/fake-buddy-cwd.cjs')]);
 const adapter=make(),manager=new AgentSessions(file,undefined,{[backend]:adapter});t.after(()=>manager.close());
 await manager.status(backend,{owner,conversationId:'probe',cwd:roots[0]});
 const sessions=await Promise.all(roots.map((root,i)=>manager.create(owner,{backend,conversationId:'cwd-'+i,roots:[root]})));
 const inspect=async(m,s,index,requestId)=>{
   await m.turn(s.id,owner,{requestId,text:'Report native working directory'});
   const snapshot=await done(m,s.id,owner);
   const reply=JSON.parse(snapshot.items.filter(item=>item.type==='agentMessage').at(-1).text);
   const canonical=value=>process.platform==='win32'?value.toLowerCase():value;
   assert.equal(canonical(reply.cwd),canonical(roots[index]),'CLI startup cwd must be the selected local workspace');
   assert.equal(canonical(reply.sessionCwd),canonical(roots[index]));assert.equal(reply.marker,path.basename(roots[index]));
   return reply.pid;
 };
 const pids=await Promise.all(sessions.map((s,i)=>inspect(manager,s,i,'first')));
 assert.notEqual(pids[0],pids[1],'different workspaces must not share process-global context');
 adapter.refreshCapabilities();
 assert.equal(await inspect(manager,sessions[0],0,'continue'),pids[0],'refresh and continuation reuse the live session process');
 manager.close();
 const restarted=new AgentSessions(file,undefined,{[backend]:make()});t.after(()=>restarted.close());
 await Promise.all(sessions.map(s=>restarted.read(s.id,owner)));
 await Promise.all(sessions.map((s,i)=>inspect(restarted,s,i,'resumed')));
});
async function done(manager,id,owner) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline) {
   const s=await manager.read(id,owner);
   if(!['starting','running','waiting','uncertain'].includes(s.status))return s;
   await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('turn did not finish');
}
function setup(t,args=[]) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-backends-'));
 const file=path.join(dir,'registry.json');
 const adapters=Object.fromEntries(AGENT_BACKENDS.map(backend=>[backend,backend==='codex'?new CodexHarness(process.execPath,[codexFixture,...args]):backend==='claude'?new ClaudeHarness(path.join(dir,backend),process.execPath,[claudeFixture,...args]):new AcpHarness(backend,path.join(dir,backend),process.execPath,[fixture,...args])]));
 const manager=new AgentSessions(file,undefined,adapters);
 t.after(()=>{manager.close();});
 return {dir,file,manager,adapters,owner:'fixture-owner'};
}
for(const backend of AGENT_BACKENDS) test(`${backend}: shared API status, create, stream, duplicate prevention, ownership and archive`,async t=>{
 const {manager,dir,owner}=setup(t);
 const statuses=await manager.backends();assert.deepEqual(Object.keys(statuses),[...AGENT_BACKENDS]);assert.equal(statuses[backend].available,true);
 const s=await manager.create(owner,{backend,conversationId:'chat',roots:[dir]});assert.equal(s.backend,backend);
 const seen=[];const off=manager.subscribe(s.id,owner,event=>seen.push(event));
 await manager.turn(s.id,owner,{requestId:'one',text:'hello'});
 await manager.turn(s.id,owner,{requestId:'one',text:'hello'});
 const result=await done(manager,s.id,owner);off();assert.equal(result.status,'completed');
 assert.ok(seen.some(e=>e.session.status==='running'));
 assert.ok(result.items.some(i=>i.type==='agentMessage'&&i.text));
 if(backend!=='codex')assert.ok(result.items.some(i=>i.text==='中文😀'));
 await assert.rejects(manager.read(s.id,'different'),/not found/);
 assert.equal((await manager.create(owner,{backend,conversationId:'chat',roots:[dir]})).id,s.id);
 await manager.update(s.id,owner,{title:'renamed',archived:true});
 assert.equal((await manager.read(s.id,owner)).title,'renamed');
 await manager.update(s.id,owner,{archived:false});
});
test('backend IDs scope idempotency, native thread collisions, event routing and process failures',async t=>{
 const {manager,dir,owner,adapters}=setup(t);
 const a=await manager.create(owner,{backend:'workbuddy',conversationId:'same',roots:[dir]});
 const b=await manager.create(owner,{backend:'copilot',conversationId:'same',roots:[dir]});
 assert.notEqual(a.id,b.id);assert.equal(a.threadId,b.threadId);
 await manager.turn(a.id,owner,{requestId:'a',text:'wait'});await manager.turn(b.id,owner,{requestId:'b',text:'hello'});
 assert.equal((await done(manager,b.id,owner)).status,'completed');assert.equal((await manager.read(a.id,owner)).status,'running');
 await manager.interrupt(a.id,owner);assert.equal((await done(manager,a.id,owner)).status,'interrupted');
 adapters.workbuddy.emit('exit');assert.equal((await manager.read(b.id,owner)).status,'completed');
 await assert.rejects(manager.create(owner,{backend:'arbitrary',conversationId:'x',roots:[dir]}),/Unsupported/);
});
for(const backend of AGENT_BACKENDS.filter(b=>b!=='codex')) test(`${backend}: permissions, interrupt and daemon restart preserve history without resending`,async t=>{
 const {manager,dir,file,owner}=setup(t);
 const s=await manager.create(owner,{backend,conversationId:'x',roots:[dir]});
 await manager.turn(s.id,owner,{requestId:'permission',text:'permission'});
 const states=[];const off=manager.subscribe(s.id,owner,e=>states.push(e.session));
 const completed=await done(manager,s.id,owner);off();
 assert.equal(completed.pending.length,0);assert.ok(states.every(s=>s.status!=='waiting'),'Full access must not wait for tool permission');
 const result=await done(manager,s.id,owner);assert.ok(result.items.some(i=>i.text?.includes(backend==='claude'?'"behavior":"allow"':'"optionId":"yes"')));
 manager.close();
 const adapter=backend==='claude'?new ClaudeHarness(path.join(dir,backend),process.execPath,[claudeFixture]):new AcpHarness(backend,path.join(dir,backend),process.execPath,[fixture]);
 const restarted=new AgentSessions(file,undefined,{[backend]:adapter});t.after(()=>restarted.close());
 const restored=await restarted.read(s.id,owner);assert.deepEqual(restored.items,result.items);
 await restarted.turn(s.id,owner,{requestId:'after-restart',text:'hello'});assert.equal((await done(restarted,s.id,owner)).status,'completed');
});
test('ACP availability does not pretend authentication; native auth rejection and unsupported resume surface clearly',async t=>{
 const {manager,dir,owner}=setup(t,['--auth-required']);
 assert.equal((await manager.status('copilot')).authenticated,null);
 assert.equal((await manager.login('copilot')).command,'copilot login');
 await assert.rejects(manager.create(owner,{backend:'copilot',conversationId:'auth',roots:[dir]}),/Authentication/);
 const adapter=new AcpHarness('workbuddy',path.join(dir,'no-load'),process.execPath,[fixture,'--no-load']);t.after(()=>adapter.close());
 const s=await adapter.call('thread/start',{cwd:dir});adapter.close();
 await new Promise(r=>setTimeout(r,200));
 await assert.rejects(adapter.call('thread/resume',{threadId:s.thread.id}),/cannot resume/);
});
test('Windows npm launcher resolves to argument-only Node execution, preserving spaces and shell syntax',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli paths '));
 const script=path.join(dir,'entry.js');fs.writeFileSync(script,'');
 fs.writeFileSync(path.join(dir,'copilot.cmd'),'"%dp0%\\entry.js" %*');
 const args=['--acp','text with $() & spaces'];const command=cliCommand(path.join(dir,'copilot.cmd'),args,'win32');
 assert.deepEqual(command,{executable:process.execPath,args:[script,...args]});
});
test('HTTP backends and creation select all providers; login is explicit and unsupported providers rejected',async t=>{
 const {manager,dir}=setup(t);
 const http=require('node:http');const server=http.createServer((req,res)=>handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/agents/`,headers={Origin:'http://localhost:3000','X-Agent-Owner':'a'.repeat(32),'Content-Type':'application/json'};
 const statuses=await fetch(url+'backends',{headers}).then(r=>r.json());assert.deepEqual(Object.keys(statuses),[...AGENT_BACKENDS]);
 for(const backend of AGENT_BACKENDS){const s=await fetch(url+'sessions',{method:'POST',headers,body:JSON.stringify({backend,conversationId:backend,roots:[dir]})}).then(r=>r.json());assert.equal(s.backend,backend);}
 assert.equal((await fetch(url+'login',{method:'POST',headers,body:JSON.stringify({backend:'workbuddy'})}).then(r=>r.json())).command,'codebuddy /login');
});
test('verification reports every provider and never counts probe-only availability as real success',async t=>{
 const {verify}=require('../skills/agent-cli-verify/scripts/verify.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-report-'));
 const http=require('node:http');const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({codex:{available:true},workbuddy:{available:false},copilot:{available:true},future:{available:true}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const report=await verify(`http://127.0.0.1:${server.address().port}`,{probeOnly:true,reportFile:path.join(dir,'report.json')});
 assert.deepEqual(report.results.map(r=>r.backend),[...AGENT_BACKENDS,'future']);assert.equal(report.passed,false);
 assert.equal(report.results[1].status,'unavailable');assert.equal(report.results[0].status,'not_tested');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8')).passed,false);
 await assert.rejects(verify('https://example.com'),/loopback/);
});

test('packaged verification catalogue matches every runtime backend',()=>{assert.deepEqual(require('../skills/agent-cli-verify/references/backends.json'),[...AGENT_BACKENDS]);});

test('native model discovery requiring authentication marks the connected CLI as needing login', async t => {
 const {EventEmitter}=require('node:events');
 class Adapter extends EventEmitter { async call(method){if(method==='account/read')return {authUnknown:true};throw new Error('Authentication required');} close(){} }
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-auth-status-')),adapter=new Adapter();
 const manager=new AgentSessions(path.join(dir,'registry'),adapter,{cursor:adapter});t.after(()=>{manager.close();fs.rmSync(dir,{recursive:true,force:true});});
 const result=await manager.status('cursor');assert.equal(result.available,true);assert.equal(result.authenticated,false);assert.equal(result.authState,'required');assert.equal(result.modelsError,'Authentication required');
});

test('installation inventory discovers executable paths without calling any native adapter', async t => {
 const {EventEmitter}=require('node:events');
 class Adapter extends EventEmitter { call(){throw new Error('Inventory must not start a native CLI');} close(){} }
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cli-inventory-'));
 const adapter=new Adapter(),manager=new AgentSessions(path.join(dir,'registry'),adapter,{codex:adapter});
 const previous=process.env.KEEPWORK_CODEX_PATH;process.env.KEEPWORK_CODEX_PATH=__filename;
 t.after(()=>{ if(previous===undefined)delete process.env.KEEPWORK_CODEX_PATH;else process.env.KEEPWORK_CODEX_PATH=previous; manager.close();fs.rmSync(dir,{recursive:true,force:true}); });
 const result=manager.inventory();assert.deepEqual(Object.keys(result),[...AGENT_BACKENDS]);
 assert.equal(result.codex.available,true);assert.equal(result.codex.probe,'executable');assert.equal(result.codex.cli.path,__filename);
 const http=require('node:http'),server=http.createServer((req,res)=>handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const response=await fetch(`http://127.0.0.1:${server.address().port}/agents/backends?probe=executable`,{headers:{Origin:'http://localhost:3000','X-Agent-Owner':'a'.repeat(32)}});
 assert.equal(response.status,200);assert.equal((await response.json()).codex.cli.path,__filename);
});

test('MCP skill discovery returns both the canonical setup skill and its complete installation reference', async () => {
 const {registerAgentGuide}=require('../src/mcp/agentGuide.ts'),resources=[];
 registerAgentGuide({registerResource(name,uri,metadata,read){resources.push({name,uri,read});}});
 assert.equal(resources.length,AGENT_BACKENDS.length+3);
 for(const resource of resources) {
  const result=await resource.read(new URL(resource.uri));
  const relative=resource.uri.replace('keepwork://skills/agent-cli-verify/','');
  assert.equal(result.contents[0].uri,resource.uri);
  assert.equal(result.contents[0].text,fs.readFileSync(path.join(__dirname,'../skills/agent-cli-verify',relative),'utf8'));
 }
});
test('Cursor question and plan extension requests require and preserve explicit user decisions',async t=>{
 const {manager,dir,owner}=setup(t);const s=await manager.create(owner,{backend:'cursor',conversationId:'cursor-input',roots:[dir]});
 await manager.turn(s.id,owner,{requestId:'question',text:'cursor-question'});
 let snap;for(let i=0;i<100;i++){snap=await manager.read(s.id,owner);if(snap.pending.length)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(snap.status,'waiting');assert.equal(snap.pending[0].params.questions[0].question,'Choose?');
 assert.throws(()=>manager.respond(s.id,owner,{id:snap.pending[0].id,answers:{q:'not an option'}}),/Choose one/);
 manager.respond(s.id,owner,{id:snap.pending[0].id,answers:{q:'Yes'}});snap=await done(manager,s.id,owner);assert.ok(snap.items.some(i=>i.text?.includes('"selectedOptionIds":["yes"]')));
 await manager.turn(s.id,owner,{requestId:'plan',text:'cursor-plan'});
 for(let i=0;i<100;i++){snap=await manager.read(s.id,owner);if(snap.pending.length)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(snap.status,'waiting');manager.respond(s.id,owner,{id:snap.pending[0].id,decision:'decline'});snap=await done(manager,s.id,owner);assert.ok(snap.items.some(i=>i.text?.includes('"outcome":"rejected"')));
});
test('ACP configOptions model discovery and selection uses the provider configuration ID',async t=>{
 const {manager,dir,owner}=setup(t,['--config-options']);const s=await manager.create(owner,{backend:'qwen',conversationId:'config',roots:[dir],model:'fixture'});
 assert.equal((await manager.status('qwen')).models[0].id,'fixture');
 await manager.turn(s.id,owner,{requestId:'model',text:'hello',model:'fixture'});assert.equal((await done(manager,s.id,owner)).status,'completed');
});

test('targeted HTTP status does not start or wait for an unrelated stalled CLI', async t => {
 const {EventEmitter}=require('node:events');const calls=[];
 class Adapter extends EventEmitter { async call(method){calls.push(method);return method==='account/read'?{account:{}}:{data:[{id:'quick'}]};} close(){} }
 const quick=new Adapter(),slow=new Adapter();slow.call=()=>{throw new Error('Unrelated CLI must not start');};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'targeted-status-'));
 const manager=new AgentSessions(path.join(dir,'registry'),quick,{codex:quick,gemini:slow});t.after(()=>{manager.close();fs.rmSync(dir,{recursive:true,force:true});});
 const http=require('node:http'),server=http.createServer((req,res)=>handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const result=await fetch(`http://127.0.0.1:${server.address().port}/agents/backends?backend=codex`,{headers:{Origin:'http://localhost:3000','X-Agent-Owner':'a'.repeat(32)},signal:AbortSignal.timeout(1000)}).then(r=>r.json());
 assert.deepEqual(Object.keys(result),['codex']);assert.equal(result.codex.models[0].id,'quick');assert.deepEqual(calls,['account/read','model/list']);
});

test('ACP discovers grouped models and effort before a prompt, reuses the preview, and applies model-dependent native effort', async t => {
 const {manager,dir,owner}=setup(t,['--config-options']);
 const scope={owner,cwd:dir,conversationId:'catalog'};
 const unbound=await manager.status('copilot',{owner,conversationId:'unbound'});
 assert.deepEqual(unbound.models.map(m=>m.id),['fixture','fast']);
 assert.equal(manager.list(owner).length,0);
 let info=await manager.status('copilot',scope);
 assert.deepEqual(info.models.map(m=>m.id),['fixture','fast']);
 assert.deepEqual(info.models[0].supportedReasoningEfforts.map(e=>e.reasoningEffort),['low','medium','high']);
 assert.equal(info.models[0].defaultReasoningEffort,'medium');assert.equal(manager.list(owner).length,0);
 const adapter=manager.adapters.copilot,preview=adapter.catalogs.get(owner+':catalog').thread;
 assert.equal(preview.turns.length,0);
 const s=await manager.create(owner,{backend:'copilot',conversationId:'catalog',roots:[dir],model:'fixture'});
 assert.equal(s.threadId,preview.id);assert.equal(adapter.catalogs.has(owner+':catalog'),false);
 await manager.turn(s.id,owner,{requestId:'effort',text:'hello',model:'fixture',effort:'high'});
 assert.equal((await done(manager,s.id,owner)).status,'completed');
 info=await manager.status('copilot',{owner,sessionId:s.id});assert.equal(info.models[0].defaultReasoningEffort,'high');
 info=await manager.status('copilot',{owner,sessionId:s.id,model:'fast'});
 assert.equal(info.models.find(m=>m.id==='fast').isDefault,true);assert.ok(!info.models.some(m=>m.supportedReasoningEfforts));
 await assert.rejects(manager.status('copilot',{owner:'different',sessionId:s.id}),/not found/);
 await assert.rejects(manager.turn(s.id,owner,{requestId:'unsupported-effort',text:'hello',model:'fast',effort:'high'}),/does not expose reasoning effort/);
 assert.equal((await manager.read(s.id,owner)).lastSubmission.state,'rejected');
});

test('daemon capabilities are shared across status requests and invalidated by provider events or explicit refresh', async t => {
 const {EventEmitter}=require('node:events');const calls=[];
 class Adapter extends EventEmitter { async call(method){calls.push(method);return method==='account/read'?{account:{}}:{data:[{id:'warm'}]};} close(){} }
 const adapter=new Adapter(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'warm-status-'));
 const manager=new AgentSessions(path.join(dir,'registry'),adapter,{codex:adapter});t.after(()=>{manager.close();fs.rmSync(dir,{recursive:true,force:true});});
 await Promise.all(Array.from({length:12},()=>manager.status('codex')));
 assert.deepEqual(calls,['account/read','model/list']);
 await manager.status('codex',{owner:'new-owner',conversationId:'new-chat'});assert.equal(calls.length,2);
 adapter.emit('notification',{method:'model/updated',params:{}});await manager.status('codex');assert.equal(calls.filter(m=>m==='model/list').length,2);
 adapter.emit('exit');await manager.status('codex');assert.equal(calls.filter(m=>m==='account/read').length,2);
 await manager.status('codex',{refresh:true});assert.equal(calls.filter(m=>m==='account/read').length,3);
});

for (const backend of ['workbuddy', 'copilot', 'cursor']) test(`${backend}: drafts share model discovery; refresh and turns preserve discovery and session PIDs`, async t => {
 const {manager,dir,owner,adapters}=setup(t,['--config-options']);const adapter=adapters[backend],calls=[];
 const rpc=adapter.rpc.bind(adapter);adapter.rpc=(method,...args)=>{calls.push(method);return rpc(method,...args);};
 const scopes=Array.from({length:8},(_,i)=>({owner,cwd:dir,conversationId:'draft-'+i}));
 const infos=await Promise.all(scopes.map(s=>manager.status(backend,s)));
 assert.ok(infos.every(i=>i.models.length===2));assert.equal(calls.filter(m=>m==='initialize').length,1);assert.equal(calls.filter(m=>m==='session/new').length,1);
 const pid=adapter.child.pid;
 await manager.status(backend,{owner:'second-owner',cwd:dir,conversationId:'other'});
 assert.equal(calls.filter(m=>m==='session/new').length,1);
 const s=await manager.create(owner,{backend,conversationId:'draft-0',roots:[dir],model:'fixture'});
 const sessionAdapter=adapter.scoped.get(s.threadId)||adapter,sessionPid=sessionAdapter.child.pid,sessionCalls=[];
 if(sessionAdapter!==adapter){const sessionRpc=sessionAdapter.rpc.bind(sessionAdapter);sessionAdapter.rpc=(method,...args)=>{sessionCalls.push(method);return sessionRpc(method,...args);};}
 for(const id of ['one','two']){await manager.turn(s.id,owner,{requestId:id,text:'hello',model:'fixture',effort:'high'});assert.equal((await done(manager,s.id,owner)).status,'completed');}
 await manager.status(backend,{owner,sessionId:s.id,refresh:true});
 assert.equal(adapter.child.pid,pid);assert.equal(calls.filter(m=>m==='initialize').length,1);assert.equal(calls.filter(m=>m==='session/load').length,0);
 assert.equal(sessionAdapter.child.pid,sessionPid);
 assert.equal((sessionAdapter===adapter?calls:sessionCalls).filter(m=>m==='session/prompt').length,2);
 await manager.status(backend,{...scopes[1],refresh:true});assert.equal(adapter.child.pid,pid);assert.equal(calls.filter(m=>m==='session/new').length,2);
});
