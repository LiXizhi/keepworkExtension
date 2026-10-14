const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {AntigravityHarness}=require('../src/core/antigravityHarness.ts');
const {resolveAgentCli}=require('../src/core/agentCliProcess.ts');
const fixture=path.join(__dirname,'fixtures/fake-antigravity.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-harness-'));const adapters=[];const make=()=>{const a=new AntigravityHarness(path.join(dir,'cache'),process.execPath,[fixture]);adapters.push(a);return a;};const a=make();t.after(async()=>{for(const adapter of adapters)adapter.close();await new Promise(r=>setTimeout(r,200));await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return {a,dir,make};}
async function turn(a,id,text){const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture turn timed out')),5000);const listener=m=>{if(m.method==='turn/completed'&&m.params.threadId===id){clearTimeout(timer);a.off('notification',listener);resolve(m.params.turn);}};a.on('notification',listener);});await a.call('turn/start',{threadId:id,input:[{type:'text',text}]});return done;}
test('native agy discovery ignores legacy Gemini override and finds the Windows install directory',t=>{
 const {dir}=setup(t);const bin=path.join(dir,'agy/bin');fs.mkdirSync(bin,{recursive:true});const exe=path.join(bin,'agy.exe');fs.writeFileSync(exe,'');
 assert.equal(resolveAgentCli('gemini',[],undefined,{platform:'win32',home:dir,pathDirs:[],env:{LOCALAPPDATA:dir,KEEPWORK_GEMINI_PATH:path.join(dir,'obsolete-gemini.exe')}}).path,exe);
});
test('Antigravity emits native models, reuses its stream for two turns and resumes the exact native conversation',async t=>{
 const {a,dir,make}=setup(t);assert.equal((await a.call('account/read')).account.type,'cli');assert.deepEqual((await a.call('model/list')).data.map(m=>m.id),['native-model','fast-model']);
 const {thread}=await a.call('thread/start',{cwd:dir});assert.equal((await turn(a,thread.id,'inspect')).status,'completed');
 let saved=(await a.call('thread/read',{threadId:thread.id})).thread;const inspect=JSON.parse(saved.turns[0].items.find(i=>i.type==='agentMessage').text);
 await turn(a,thread.id,'inspect');saved=(await a.call('thread/read',{threadId:thread.id})).thread;assert.equal(JSON.parse(saved.turns[1].items.find(i=>i.type==='agentMessage').text).pid,inspect.pid);
 const nativeId=saved.nativeId;a.close();const b=make();t.after(()=>b.close());await b.call('thread/resume',{threadId:thread.id});await turn(b,thread.id,'inspect');
 const next=(await b.call('thread/read',{threadId:thread.id})).thread;assert.equal(next.nativeId,nativeId);assert.equal(next.turns.length,3);const resumed=JSON.parse(next.turns[2].items.find(i=>i.type==='agentMessage').text);assert.ok(resumed.args.includes(nativeId));
});
test('scoped MCP config never modifies user workspace or persists capabilities; plan switches native flags',async t=>{
 const {a,dir}=setup(t);const servers=[{name:'keepwork_aichat',command:'node',args:['proxy.cjs'],env:[{name:'KEEPWORK_AICHAT_CAPABILITY',value:'secret-fixture'}]}];
 const {thread}=await a.call('thread/start',{cwd:dir,roots:[dir],mcpServers:servers});await a.call('thread/mode/set',{threadId:thread.id,mode:'plan',model:'native-model'});await turn(a,thread.id,'inspect');
 const saved=(await a.call('thread/read',{threadId:thread.id})).thread;const data=JSON.parse(saved.turns[0].items.find(i=>i.type==='agentMessage').text);assert.equal(data.hasCapability,true);assert.ok(data.args.includes('plan'));assert.ok(data.args.includes('--add-dir'));assert.notEqual(data.cwd,dir);assert.ok(!fs.existsSync(path.join(dir,'.agents')));
 assert.equal(data.mcp.mcpServers.keepwork_aichat.command,'node');assert.ok(!fs.readFileSync(path.join(data.cwd,'.agents/mcp_config.json'),'utf8').includes('secret-fixture'));assert.ok(!fs.readFileSync(path.join(dir,'cache',thread.id+'.json'),'utf8').includes('secret-fixture'));
});
test('legacy Gemini history remains readable but is never sent to agy',async t=>{
 const {a,dir}=setup(t);fs.mkdirSync(path.join(dir,'cache'),{recursive:true});fs.writeFileSync(path.join(dir,'cache','old-gemini.json'),JSON.stringify({id:'old-gemini',cwd:dir,turns:[{items:[{text:'saved history'}]}]}));
 assert.equal((await a.call('thread/read',{threadId:'old-gemini'})).thread.turns[0].items[0].text,'saved history');assert.equal((await a.call('thread/resume',{threadId:'old-gemini'})).thread.id,'old-gemini');await assert.rejects(a.call('turn/start',{threadId:'old-gemini',input:[{type:'text',text:'do not send'}]}),/start a new Antigravity chat/);
});
test('tool output, Unicode, native denial, crashes and interruption terminate observably without replay',async t=>{
 const {a,dir}=setup(t);const {thread}=await a.call('thread/start',{cwd:dir});await turn(a,thread.id,'hello');const saved=(await a.call('thread/read',{threadId:thread.id})).thread;assert.equal(saved.turns[0].items.find(i=>i.type==='agentMessage').text,'中文😀');assert.equal(saved.turns[0].items.find(i=>i.type==='mcpToolCall').result,'read result');
 assert.equal((await turn(a,thread.id,'denied')).status,'failed');assert.equal((await turn(a,thread.id,'crash')).status,'failed');
 const started=new Promise(resolve=>{const listener=m=>{if(m.method==='turn/started'){a.off('notification',listener);resolve();}};a.on('notification',listener);});const waiting=turn(a,thread.id,'wait');await started;await a.call('turn/interrupt',{threadId:thread.id});assert.equal((await waiting).status,'interrupted');assert.equal(saved.turns.length,4);
 await assert.rejects(a.call('turn/start',{threadId:thread.id,input:[{type:'image'}]}),/text input only/);
});
