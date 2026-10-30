const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {NativeCliHistory}=require('../src/core/nativeCliHistory.ts');
const {AcpHarness}=require('../src/core/acpHarness.ts');
const {ClaudeHarness}=require('../src/core/claudeHarness.ts');
const {AgentSessions}=require('../src/core/agentSessions.ts');
const fixture=path.join(__dirname,'fixtures/fake-acp.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function transcript(dir,id='same-thread',claude=false){const project=path.join(dir,'projects','encoded');fs.mkdirSync(project,{recursive:true});const rows=[{sessionId:id,cwd:dir,type:claude?'user':'message',role:'user',...(claude?{message:{role:'user',content:'from terminal'}}:{content:[{type:'input_text',text:'from terminal'}]})},{sessionId:id,cwd:dir,type:claude?'assistant':'message',role:'assistant',...(claude?{message:{role:'assistant',content:[{type:'text',text:'native answer'}]}}:{content:[{type:'output_text',text:'native answer'}]})}];fs.writeFileSync(path.join(project,id+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return project;}
test('native project history discovers Buddy and Claude messages without reading settings or nested agent logs',async t=>{
 const dir=setup(t),project=transcript(dir);transcript(dir,'claude-thread',true);
 fs.writeFileSync(path.join(dir,'credentials.json'),'must not read');
 fs.mkdirSync(path.join(project,'subagents'));fs.writeFileSync(path.join(project,'subagents','hidden.jsonl'),'{}');
 fs.writeFileSync(path.join(project,'broken.jsonl'),'not json');
 const store=new NativeCliHistory('workbuddy',path.join(dir,'projects'));
 const list=await store.list();assert.equal(list.data.length,2);assert.ok(list.data.every(r=>r.name==='from terminal'));
 for(const row of list.data){const read=await store.read(row.id);assert.equal(read.turns[0].items.length,2);assert.equal(read.turns[0].items[1].text,'native answer');}
 await assert.rejects(store.read('../credentials'),/Invalid/);
 const external=path.join(dir,'external.jsonl');fs.writeFileSync(external,fs.readFileSync(path.join(project,'same-thread.jsonl')));
 fs.unlinkSync(path.join(project,'same-thread.jsonl'));fs.symlinkSync(external,path.join(project,'same-thread.jsonl'));
 await assert.rejects(store.read('same-thread'),/outside/);
});
test('WorkBuddy native session sends to original ID, owns correct cwd, and does not call session/new',async t=>{
 const dir=setup(t);transcript(dir);
 const previous=process.env.CODEBUDDY_CONFIG_DIR;process.env.CODEBUDDY_CONFIG_DIR=dir;t.after(()=>{if(previous===undefined)delete process.env.CODEBUDDY_CONFIG_DIR;else process.env.CODEBUDDY_CONFIG_DIR=previous;});
 const log=path.join(dir,'rpc.log'),adapter=new AcpHarness('workbuddy',path.join(dir,'cache'),process.execPath,[fixture,'--log='+log]);
 const manager=new AgentSessions(path.join(dir,'registry.json'),undefined,{workbuddy:adapter});t.after(()=>manager.close());
 assert.equal((await manager.nativeCatalog('owner',undefined,'workbuddy')).sessions.length,1);
 const s=await manager.nativeSession('owner','same-thread','workbuddy');assert.equal(s.items.length,2);assert.equal(fs.existsSync(log),false);
 await assert.rejects(manager.nativeSession('other','same-thread','codebuddy'),/unavailable/);
 await manager.turn(s.id,'owner',{requestId:'continue-native',text:'next'});
 for(let i=0;i<50;i++){if((await manager.read(s.id,'owner')).status==='completed')break;await new Promise(r=>setTimeout(r,20));}
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(!calls.some(c=>c.method==='session/new'));
 const load=calls.find(c=>c.method==='session/load');assert.equal(load.params.sessionId,'same-thread');assert.equal(load.params.cwd,fs.realpathSync(dir));
 assert.equal(calls.filter(c=>c.method==='session/prompt').length,1);
});
test('ACP discovery is capability gated, replays native history and continues without creating a replacement',async t=>{
 const dir=setup(t),log=path.join(dir,'rpc.log');
 const adapter=new AcpHarness('qwen',path.join(dir,'cache'),process.execPath,[fixture,'--native-list','--native-cwd='+dir,'--log='+log]);t.after(()=>adapter.close());
 const result=await adapter.call('thread/list');assert.equal(result.data[0].id,'same-thread');
 const read=await adapter.call('thread/native/read',{threadId:'same-thread'});assert.equal(read.thread.turns[0].items[0].content[0].text,'historical user');assert.equal(read.thread.turns[0].items[1].text,'historical assistant');
 await adapter.call('thread/resume',{threadId:'same-thread'});await adapter.call('turn/start',{threadId:'same-thread',input:[{type:'text',text:'continue'}]});
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(!calls.some(c=>c.method==='session/new'));assert.equal(calls.filter(c=>c.method==='session/load').length,1);
 const unsupported=new AcpHarness('kimi',path.join(dir,'no-list'),process.execPath,[fixture]);t.after(()=>unsupported.close());
 await assert.rejects(unsupported.call('thread/list'),/unsupported/);
});
test('Claude native history attaches with native resume flag without booting the CLI',async t=>{
 const dir=setup(t);transcript(dir,'claude-thread',true);const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=dir;t.after(()=>{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;});
 const adapter=new ClaudeHarness(path.join(dir,'cache'),'/not-installed');t.after(()=>adapter.close());
 assert.equal((await adapter.call('thread/list')).data.length,1);
 const {thread}=await adapter.call('thread/native/read',{threadId:'claude-thread'});assert.equal(thread.native,true);assert.equal(thread.cwd,dir);assert.equal(thread.turns[0].items.length,2);
});
