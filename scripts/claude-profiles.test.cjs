const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {ClaudeProfiles}=require('../src/core/claudeProfiles.ts');
const fixture=path.join(__dirname,'fixtures/fake-claude.cjs');
const profile=(overrides={})=>({name:'Test provider',baseUrl:'https://gateway.example.test/anthropic',authType:'authToken',secret:'fixture-provider-secret',model:'provider-default',sonnetModel:'provider-sonnet',opusModel:'provider-opus',haikuModel:'provider-haiku',...overrides});
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-profiles-')),file=path.join(dir,'claude-profiles-v1.json');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,file,store:new ClaudeProfiles(file)};
}
function add(store,overrides={}){store.create(profile(overrides));return store.snapshot().profiles.at(-1);}

test('Claude provider profiles persist separately, expose only write-only credentials and retain omitted secrets',t=>{
 const {store,file}=setup(t);
 assert.deepEqual(store.snapshot(),{version:1,activeProfileId:null,profiles:[]});
 const saved=add(store);
 assert.equal(saved.name,'Test provider');assert.equal(saved.hasSecret,true);
 assert.equal('secret' in saved,false);assert.ok(saved.id);
 store.activate(saved.id);
 store.update(saved.id,{name:'Renamed provider',model:'updated-model'});
 const restored=new ClaudeProfiles(file);
 assert.equal(restored.snapshot().activeProfileId,saved.id);
 assert.equal(restored.snapshot().profiles[0].name,'Renamed provider');
 assert.equal(restored.environment({}).ANTHROPIC_AUTH_TOKEN,'fixture-provider-secret');
 assert.equal(restored.environment({}).ANTHROPIC_MODEL,'updated-model');
 assert.ok(!JSON.stringify(restored.snapshot()).includes('fixture-provider-secret'));
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
 store.update(saved.id,{secret:'fixture-replacement-secret'});
 assert.equal(new ClaudeProfiles(file).environment({}).ANTHROPIC_AUTH_TOKEN,'fixture-replacement-secret');
 assert.throws(()=>store.remove(saved.id));
 store.activate(null);store.remove(saved.id);
 assert.deepEqual(new ClaudeProfiles(file).snapshot(),{version:1,activeProfileId:null,profiles:[]});
});

test('Claude provider activation isolates auth/model environment and native mode preserves inherited settings',t=>{
 const {store}=setup(t);
 const inherited={PATH:'/fixture/bin',HTTP_PROXY:'http://127.0.0.1:9123',ANTHROPIC_API_KEY:'fixture-inherited-key',ANTHROPIC_AUTH_TOKEN:'fixture-inherited-token',CLAUDE_CODE_OAUTH_TOKEN:'fixture-inherited-oauth',CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR:'10',ANTHROPIC_BASE_URL:'https://old.example.test',ANTHROPIC_MODEL:'old-model',ANTHROPIC_DEFAULT_MODEL:'old-default',ANTHROPIC_DEFAULT_FABLE_MODEL:'old-fable',ANTHROPIC_DEFAULT_SONNET_MODEL:'old-sonnet',ANTHROPIC_DEFAULT_OPUS_MODEL:'old-opus',ANTHROPIC_DEFAULT_HAIKU_MODEL:'old-haiku',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',CLAUDE_CODE_USE_FOUNDRY:'1',CLAUDE_CODE_USE_ANTHROPIC_AWS:'1',CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD:'1',CLAUDE_CODE_USE_MANTLE:'1',anthropic_auth_token:'fixture-lowercase-old-token'};
 assert.deepEqual(store.environment(inherited),inherited);
 const first=add(store);store.activate(first.id);
 const token=store.environment(inherited);
 assert.equal(token.ANTHROPIC_AUTH_TOKEN,'fixture-provider-secret');assert.ok(!token.ANTHROPIC_API_KEY);assert.ok(!token.CLAUDE_CODE_OAUTH_TOKEN);assert.ok(!token.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR);assert.equal(token.anthropic_auth_token,undefined);
 assert.equal(token.ANTHROPIC_BASE_URL,'https://gateway.example.test/anthropic');
 assert.equal(token.ANTHROPIC_MODEL,'provider-default');assert.equal(token.ANTHROPIC_DEFAULT_SONNET_MODEL,'provider-sonnet');assert.equal(token.ANTHROPIC_DEFAULT_OPUS_MODEL,'provider-opus');assert.equal(token.ANTHROPIC_DEFAULT_HAIKU_MODEL,'provider-haiku');
 for(const name of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE'])assert.notEqual(token[name],'1');
 assert.ok(!token.ANTHROPIC_DEFAULT_MODEL);assert.ok(!token.ANTHROPIC_DEFAULT_FABLE_MODEL);
 assert.equal(token.HTTP_PROXY,inherited.HTTP_PROXY);assert.equal(token.PATH,inherited.PATH);assert.equal(inherited.ANTHROPIC_AUTH_TOKEN,'fixture-inherited-token');
 const second=add(store,{name:'API key gateway',authType:'apiKey',secret:'fixture-api-key',model:'',sonnetModel:'',opusModel:'',haikuModel:''});store.activate(second.id);
 const key=store.environment(inherited);
 assert.equal(key.ANTHROPIC_API_KEY,'fixture-api-key');assert.ok(!key.ANTHROPIC_AUTH_TOKEN);
 for(const name of ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'])assert.ok(!key[name]);
 store.activate(null);assert.deepEqual(store.environment(inherited),inherited);
});

test('Claude provider launch overrides native model settings without placing credentials in command arguments',t=>{
 const {store}=setup(t),saved=add(store,{model:''});store.activate(saved.id);
 const launch=store.launch({ANTHROPIC_AUTH_TOKEN:'fixture-old-token'});
 try{
  assert.equal(launch.args[0],'--settings');assert.ok(!JSON.stringify(launch.args).includes('fixture-provider-secret'));
  const settings=JSON.parse(fs.readFileSync(launch.args[1],'utf8'));
  assert.deepEqual(Object.keys(settings),['env','model','apiKeyHelper']);assert.equal(settings.model,'default');assert.equal(settings.apiKeyHelper,'');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'fixture-provider-secret');
  assert.ok(!settings.env.ANTHROPIC_MODEL);assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'provider-sonnet');
 }finally{launch.cleanup();}
 assert.equal(fs.existsSync(launch.args[1]),false);
 store.activate(null);assert.deepEqual(store.launch({PATH:'fixture'}).args,[]);
});

test('Claude provider validation rejects malformed or unsupported configuration without changing saved profiles',t=>{
 const {store}=setup(t);const saved=add(store),original=store.snapshot();
 const invalid=[{name:''},{baseUrl:'file:///private/tmp/gateway'},{baseUrl:'https://user:fixture-url-secret@example.test'},{baseUrl:'https://example.test/?key=fixture-url-secret'},{baseUrl:'https://example.test/#fixture-url-secret'},{authType:'oauth'},{secret:''},{secret:'fixture-secret\nheader'},{model:'model\u0000suffix'},{env:{NODE_OPTIONS:'--require /tmp/code.cjs'}}];
 for(const patch of invalid){
  assert.throws(()=>store.create(profile(patch)),error=>!error.message.includes('fixture-url-secret')&&!error.message.includes('fixture-secret'));
  assert.deepEqual(store.snapshot(),original);
 }
 assert.throws(()=>store.activate('missing-provider'));
 assert.throws(()=>store.update('missing-provider',{name:'New'}));
 assert.throws(()=>store.remove('missing-provider'));
 assert.throws(()=>store.update(saved.id,{secret:'fixture-secret\nheader'}));
 assert.deepEqual(store.snapshot(),original);
});

test('Unreadable or corrupted Claude profile storage fails explicitly instead of silently discarding credentials',t=>{
 const {file}=setup(t);fs.writeFileSync(file,'{broken-json');
 assert.throws(()=>new ClaudeProfiles(file).snapshot());
 assert.equal(fs.readFileSync(file,'utf8'),'{broken-json');
});

test('Claude profile create and update reject an oversized UTF-8 store while preserving reloadable credentials',t=>{
 const {store,file}=setup(t),large=profile({secret:'密'.repeat(4096)});
 let rejected=false;
 for(let i=0;i<50;i++){
  const before=store.snapshot(),bytes=fs.existsSync(file)?fs.readFileSync(file):null;
  const state=bytes?JSON.parse(bytes.toString('utf8')):{version:1,revision:0,activeProfileId:null,profiles:[]};
  const candidate={...state,revision:state.revision+1,profiles:[...state.profiles,{id:'0'.repeat(36),...large}]};
  if(Buffer.byteLength(JSON.stringify(candidate),'utf8')<=512_000){store.create(large);continue;}
  assert.throws(()=>store.create(large));
  assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);
  assert.deepEqual(new ClaudeProfiles(file).snapshot(),before);rejected=true;break;
 }
 assert.equal(rejected,true,'valid individual profiles must reach the byte limit before the 50-profile count limit');
 const small=add(store,{secret:'small-fixture-secret'}),before=store.snapshot(),bytes=fs.readFileSync(file);
 assert.throws(()=>store.update(small.id,{secret:large.secret}));
 assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);
 const restored=new ClaudeProfiles(file);assert.deepEqual(restored.snapshot(),before);
 restored.activate(small.id);assert.equal(restored.environment({}).ANTHROPIC_AUTH_TOKEN,'small-fixture-secret');
 assert.ok(fs.statSync(file).size<=512_000);assert.deepEqual(fs.readdirSync(path.dirname(file)),[path.basename(file)]);
});

async function finished(adapter,id){
 for(let i=0;i<100;i++){
  const thread=(await adapter.call('thread/read',{threadId:id})).thread;
  if(thread.turns.length)return thread;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('Fixture Claude turn did not finish');
}

test('Claude harness applies selected profiles to new processes, preserves live sessions and restores selection after restart',async t=>{
 const {dir}=setup(t),cache=path.join(dir,'cache'),log=path.join(dir,'profile-launches.jsonl');
 const {ClaudeHarness}=require('../src/core/claudeHarness.ts');
 const make=()=>new ClaudeHarness(cache,process.execPath,[fixture,'--log-profile-env='+log,'--models-from-profile','--auth-status','--auth-from-profile']);
 const adapter=make();let restored;
 t.after(()=>{adapter.close();restored?.close();});
 const firstConfig=await adapter.call('config/create',profile()),first=firstConfig.profiles[0];
 await adapter.call('config/activate',{profileId:first.id});
 const a=(await adapter.call('thread/start',{cwd:dir,roots:[dir]})).thread;
 await adapter.call('turn/start',{threadId:a.id,input:[{type:'text',text:'hello'}]});await finished(adapter,a.id);
 assert.equal((await adapter.call('account/read')).account.type,'apiKey');
 const secondConfig=await adapter.call('config/create',profile({name:'Second',authType:'apiKey',secret:'fixture-second-secret',model:'second-model',sonnetModel:'',opusModel:'',haikuModel:''})),second=secondConfig.profiles.at(-1);
 await adapter.call('config/activate',{profileId:second.id});
 assert.ok(!(await adapter.call('model/list')).data.some(model=>model.id==='provider-default'),'previous provider model cache is not reused');
 await adapter.call('turn/start',{threadId:a.id,input:[{type:'text',text:'same live connection'}]});
 const b=(await adapter.call('thread/start',{cwd:dir,roots:[dir]})).thread;
 const models=(await adapter.call('model/list')).data;
 assert.ok(models.some(model=>model.id==='second-model'));
 assert.ok(!models.some(model=>model.id==='provider-default'));
 const launches=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const nativeLaunches=launches().filter(row=>row.argv.includes('--input-format'));
 assert.equal(nativeLaunches.length,2,'switching does not restart or replay the existing Claude session');
 assert.equal(nativeLaunches[0].env.ANTHROPIC_AUTH_TOKEN,'fixture-provider-secret');
 assert.equal(nativeLaunches[1].env.ANTHROPIC_API_KEY,'fixture-second-secret');
 assert.ok(!nativeLaunches[1].env.ANTHROPIC_AUTH_TOKEN);
 assert.equal(nativeLaunches[1].env.ANTHROPIC_MODEL,'second-model');
 assert.ok(!nativeLaunches[1].env.ANTHROPIC_DEFAULT_SONNET_MODEL);
 for(const row of nativeLaunches){
  assert.ok(!JSON.stringify(row.argv).includes('fixture-provider-secret'));assert.ok(!JSON.stringify(row.argv).includes('fixture-second-secret'));
  assert.deepEqual(row.settingsKeys,['env','model','apiKeyHelper']);assert.equal(row.apiKeyHelper,'');
  if(process.platform!=='win32')assert.equal(row.settingsMode,0o600);
 }
 const accountLaunch=launches().find(row=>row.argv.includes('auth'));
 assert.equal(nativeLaunches[0].model,'provider-default');assert.equal(nativeLaunches[1].model,'second-model');
 assert.equal(accountLaunch.env.ANTHROPIC_AUTH_TOKEN,'fixture-provider-secret');
 assert.ok(!fs.readFileSync(path.join(cache,a.id+'.json'),'utf8').includes('fixture-provider-secret'));
 adapter.close();restored=make();
 assert.equal((await restored.call('config/read')).activeProfileId,second.id);
 await restored.call('thread/resume',{threadId:a.id});
 const resumed=launches().filter(row=>row.argv.includes('--resume='+a.id)).at(-1);
 assert.ok(resumed);assert.equal(resumed.env.ANTHROPIC_API_KEY,'fixture-second-secret');
 await restored.call('config/activate',{profileId:null});
 const c=(await restored.call('thread/start',{cwd:dir,roots:[dir]})).thread;
 const native=launches().find(row=>row.argv.includes('--session-id='+c.id));
 assert.ok(!native.argv.includes('--settings'),'native mode retains the legacy CLI settings path');
 assert.ok(!(await restored.call('model/list')).data.some(model=>model.id==='second-model'));
 assert.notEqual(b.id,c.id);
});

test('Claude configuration HTTP contract preserves legacy account queries and invalidates cached identity on provider changes',async t=>{
 const {dir}=setup(t),{Readable}=require('node:stream');
 const {ClaudeHarness}=require('../src/core/claudeHarness.ts'),{AgentSessions}=require('../src/core/agentSessions.ts');
 const {handleAgentHttp}=require('../src/mcp/agentHttp.ts');
 const adapter=new ClaudeHarness(path.join(dir,'cache'),process.execPath,[fixture,'--auth-status','--auth-from-profile']);
 const manager=new AgentSessions(path.join(dir,'sessions.json'),undefined,{claude:adapter});t.after(()=>manager.close());
 async function request(pathname,method='GET',body){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.headers={origin:'http://127.0.0.1:8089','x-agent-owner':'fixture-owner-key-12345678901234567890','content-type':'application/json'};
  const result={headers:{}};
  const res={headersSent:false,setHeader(name,value){result.headers[name.toLowerCase()]=value;},writeHead(status,headers){this.headersSent=true;result.status=status;Object.assign(result.headers,headers);},end(body){result.body=JSON.parse(body);}};
  await handleAgentHttp(req,res,new URL(pathname,'http://127.0.0.1:8089'),manager);return result;
 }
 const native=await request('/agents/backends?backend=claude');assert.equal(native.status,200);assert.equal(native.body.claude.account.email,'claude@example.test');
 const empty=await request('/agents/claude/config');assert.equal(empty.status,200);assert.equal(empty.headers['cache-control'],'no-store');assert.equal(empty.body.version,1);
 const created=await request('/agents/claude/config/profiles','POST',profile());assert.equal(created.status,200);
 assert.ok(!JSON.stringify(created.body).includes('fixture-provider-secret'));const id=created.body.profiles[0].id;
 const active=await request('/agents/claude/config/activate','POST',{profileId:id});assert.equal(active.status,200);
 const custom=await request('/agents/backends?backend=claude');assert.equal(custom.body.claude.account.type,'apiKey');assert.equal(custom.body.claude.account.email,undefined);
 const edited=await request('/agents/claude/config/profiles/'+id,'PATCH',{name:'Updated'});assert.equal(edited.status,200);assert.equal(edited.body.profiles[0].hasSecret,true);
 assert.equal((await request('/agents/claude/config/profiles/'+id,'DELETE')).status,400);
 for(const body of [{},null,[],{profileId:id,unknown:true}])assert.equal((await request('/agents/claude/config/activate','POST',body)).status,400);
 assert.equal((await request('/agents/claude/config/profiles/'+id,'PATCH',{id:'other'})).status,400);
 assert.equal((await request('/agents/claude/config/profiles/'+id+'/extra','PATCH',{name:'Must reject'})).status,404);
 assert.equal((await request('/agents/claude/config/activate','POST',{profileId:null})).status,200);
 const restored=await request('/agents/backends?backend=claude');assert.equal(restored.body.claude.account.email,'claude@example.test');
 assert.equal((await request('/agents/claude/config/profiles/'+id,'DELETE')).status,200);
 assert.deepEqual((await request('/agents/claude/config')).body,{version:1,activeProfileId:null,profiles:[]});
});
