const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
const {EventEmitter}=require('node:events');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {agentAccountDisplay}=require('../src/core/agentAccount.ts');
const {AgentSessions,AGENT_BACKENDS}=require('../src/core/agentSessions.ts');
const {ClaudeHarness}=require('../src/core/claudeHarness.ts');
test('account display whitelists bounded metadata and never forwards native credentials',()=>{
 assert.deepEqual(agentAccountDisplay({email:' person@example.test\n',username:'person',accessToken:'secret',nested:{token:'secret'}}),{email:'person@example.test',username:'person'});
 assert.equal(agentAccountDisplay({type:'cli',token:'secret'}),undefined);
 assert.deepEqual(agentAccountDisplay({type:'apiKey',key:'secret',email:'stale@example.test'}),{type:'apiKey'});
 assert.equal(agentAccountDisplay({name:'x'.repeat(1000)}).name.length,254);
});
for(const backend of AGENT_BACKENDS)test(`${backend} status exposes only display identity and refresh removes stale accounts`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account-status-'));let value={account:{email:'old@example.test',token:'secret'}};
 class Adapter extends EventEmitter {async call(method){return method==='account/read'?value:{data:[]};}close(){}}
 const manager=new AgentSessions(path.join(dir,'sessions.json'),undefined,{[backend]:new Adapter()});
 t.after(()=>{manager.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.deepEqual((await manager.status(backend)).account,{email:'old@example.test'});
 value={account:{username:'new-user',refreshToken:'secret'}};
 assert.deepEqual((await manager.status(backend,{refresh:true})).account,{username:'new-user'});
 value={account:null};const signedOut=await manager.status(backend,{refresh:true});assert.equal(signedOut.authenticated,false);assert.equal(signedOut.account,undefined);
 assert.ok(!JSON.stringify(signedOut).includes('secret'));
});
for(const mode of ['signed-in','signed-out','old-cli'])test(`Claude native account status: ${mode}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-account-'));
 const adapter=new ClaudeHarness(dir,process.execPath,[path.join(__dirname,'fixtures/fake-claude.cjs'),...(mode==='old-cli'?[]:['--auth-status']),...(mode==='signed-out'?['--signed-out']:[])]);
 t.after(()=>{adapter.close();fs.rmSync(dir,{recursive:true,force:true});});
 const result=await adapter.call('account/read');
 if(mode==='signed-in'){assert.equal(result.account.email,'claude@example.test');assert.equal(result.probe,'native-auth');}
 if(mode==='signed-out')assert.equal(result.account,null);
 if(mode==='old-cli')assert.equal(result.authUnknown,true);
 assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPOSE'));
});
