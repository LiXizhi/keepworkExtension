const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {ClaudeHarness}=require('../src/core/claudeHarness.ts'),{AgentSessions}=require('../src/core/agentSessions.ts');
const fixture=path.join(__dirname,'fixtures/fake-claude.cjs');
function setup(t,args=[]){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-native-')),file=path.join(dir,'registry.json');
 const adapter=new ClaudeHarness(path.join(dir,'cache'),process.execPath,[fixture,...args]);
 const manager=new AgentSessions(file,undefined,{claude:adapter});
 t.after(()=>{manager.close();});return{dir,file,manager,adapter,owner:'owner'};
}
async function wait(manager,s,owner,status){for(let i=0;i<100;i++){const snap=await manager.read(s.id,owner);if(status?snap.status===status:!['starting','running','waiting','uncertain'].includes(snap.status))return snap;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out');}
test('Claude streamed text is reconciled with final blocks without duplicate content',async t=>{
 const {manager,dir,owner}=setup(t);const s=await manager.create(owner,{backend:'claude',conversationId:'x',roots:[dir]});
 await manager.turn(s.id,owner,{requestId:'one',text:'stream'});const snap=await wait(manager,s,owner);
 assert.equal(snap.status,'completed');assert.deepEqual(snap.items.filter(i=>i.type==='agentMessage').map(i=>i.text),['中文😀']);
});
test('Claude approval decline, user answers, interruption and process crash produce observable states',async t=>{
 const {manager,dir,owner}=setup(t);const s=await manager.create(owner,{backend:'claude',conversationId:'x',roots:[dir]});
 await manager.turn(s.id,owner,{requestId:'deny',text:'permission'});let snap=await wait(manager,s,owner,'waiting');
 assert.ok(!snap.pending[0].params.command.includes('SECRET_NOT_IN_CACHE'));
 manager.respond(s.id,owner,{id:snap.pending[0].id,decision:'decline'});assert.equal((await wait(manager,s,owner)).status,'failed');
 await manager.turn(s.id,owner,{requestId:'question',text:'question'});snap=await wait(manager,s,owner,'waiting');
 manager.respond(s.id,owner,{id:snap.pending[0].id,answers:{0:'yes'}});snap=await wait(manager,s,owner);assert.equal(snap.status,'completed');assert.ok(snap.items.some(i=>i.text?.includes('"Choose?":"yes"')));
 await manager.turn(s.id,owner,{requestId:'interrupt',text:'wait'});await manager.interrupt(s.id,owner);assert.equal((await wait(manager,s,owner)).status,'interrupted');
 await manager.turn(s.id,owner,{requestId:'crash',text:'crash'});assert.equal((await wait(manager,s,owner)).status,'failed');
});
test('Claude processes keep separate sessions, selected roots and native resume IDs across restart',async t=>{
 const {manager,dir,file,owner}=setup(t);const log=path.join(dir,'argv.jsonl');manager.close();
 const make=()=>new ClaudeHarness(path.join(dir,'cache'),process.execPath,[fixture,'--log='+log]);
 const first=new AgentSessions(file,undefined,{claude:make()});t.after(()=>first.close());
 const reference=path.join(dir,'reference');fs.mkdirSync(reference);
 const a=await first.create(owner,{backend:'claude',conversationId:'a',roots:[dir,reference]}),b=await first.create(owner,{backend:'claude',conversationId:'b',roots:[dir]});
 await first.turn(a.id,owner,{requestId:'a',text:'hello'});await first.turn(b.id,owner,{requestId:'b',text:'wait'});
 assert.equal((await wait(first,a,owner)).status,'completed');assert.equal((await first.read(b.id,owner)).status,'running');
 await first.interrupt(b.id,owner);await wait(first,b,owner);first.close();
 const restored=new AgentSessions(file,undefined,{claude:make()});t.after(()=>restored.close());
 const snap=await restored.read(a.id,owner);assert.ok(snap.items.some(i=>i.type==='agentMessage'));
 assert.equal((await restored.turn(a.id,owner,{requestId:'a',text:'hello'})).submission.state,'accepted');
 const args=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(args.length,3);assert.ok(args[0].includes('--add-dir'));assert.ok(args[0].includes(reference.toLowerCase())||args[0].includes(reference));
 assert.ok(args[2].includes('--resume='+a.threadId));assert.ok(args.every(a=>!a.includes('--dangerously-skip-permissions')));
});
test('Claude executable availability does not claim authentication and startup error result rejects promptly',async t=>{
 const {manager,dir,owner}=setup(t,['--startup-result-error']);const status=await manager.status('claude');assert.equal(status.available,true);assert.equal(status.authenticated,null);assert.equal(status.probe,'executable');
 await assert.rejects(manager.create(owner,{backend:'claude',conversationId:'auth',roots:[dir]}),/Authentication required/);
});
