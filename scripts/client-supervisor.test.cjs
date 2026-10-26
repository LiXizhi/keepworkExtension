const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../src/core/clientSupervisor.ts'),m=new Module(file,module);
m.require=id=>id.startsWith('./')?{}:require(id);
m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {ClientSupervisor,processChannels,desktopClients,CLIENT_POLL_MS}=m.exports;
test('Windows and macOS main processes match exactly, excluding helpers and misleading names',()=>{
 assert.deepEqual(processChannels('win32','DingTalk.exe\r\nFeishu.exe'),{dingtalk:true,feishu:true});
 assert.deepEqual(processChannels('win32','Lark.exe'),{dingtalk:false,feishu:true});
 for(const output of ['/Applications/DingTalk.app/Contents/MacOS/DingTalk\n/Applications/Feishu.app/Contents/MacOS/Feishu','/Users/u/Applications/DingTalk.app/Contents/MacOS/DingTalk\n/Applications/Lark.app/Contents/MacOS/Lark'])assert.deepEqual(processChannels('darwin',output),{dingtalk:true,feishu:true});
 assert.deepEqual(processChannels('win32','FakeDingTalk.exe\nDingTalkHelper.exe\nLarkHelper.exe'),{dingtalk:false,feishu:false});
 assert.deepEqual(processChannels('darwin','/Applications/DingTalk.app/Contents/Frameworks/DingTalk Helper\n/Applications/Lark.app/Contents/MacOS/Lark Helper'),{dingtalk:false,feishu:false});
});
test('unsupported platforms fail closed',async()=>assert.match((await desktopClients('linux')).error,/不支持/));
function fixture(){
 const rows=['dingtalk','feishu'].map(channel=>({id:channel,channel,profile:channel+':user',root:'.',enabled:true,status:'stopped'}));
 rows.push({...rows[0],id:'manual-stop',enabled:false});
 let running=true,authorized=true,guard,checks=0,stored={},gate;
 const calls=[];
 const service={list:()=>rows.map(r=>({...r})),setStartGuard:g=>guard=g,suspend:(id,status='waiting-client')=>{calls.push('suspend:'+id);rows.find(r=>r.id===id).status=status;},start:async id=>{const r=rows.find(r=>r.id===id);if((await guard(r))===true){calls.push('start:'+id);r.status='listening';}}};
 const supervisor=new ClientSupervisor(service,{readConfigFile:()=>stored,writeConfigFile:v=>stored={...stored,...v},desktopClients:async()=>({dingtalk:running,feishu:running,error:''}),cliAuthorized:async()=>{checks++;if(gate)await gate;if(authorized instanceof Error)throw authorized;return authorized;}});
 return {supervisor,rows,calls,get checks(){return checks;},get stored(){return stored;},set running(v){running=v;},set authorized(v){authorized=v;},set gate(v){gate=v;}};
}
test('default on; both channels suspend/resume, never enable manually stopped binding; config persists',async()=>{
 const f=fixture();assert.equal(f.supervisor.snapshot().enabled,true);assert.equal(CLIENT_POLL_MS,300000);
 await f.supervisor.poll();assert.deepEqual(f.calls,['start:dingtalk','start:feishu']);
 const beforeAbsent=f.checks;f.running=false;await f.supervisor.poll();assert.equal(f.checks,beforeAbsent,'no auth checks without client');assert.equal(f.rows[0].enabled,true);assert.equal(f.rows[0].status,'waiting-client');
 f.running=true;f.authorized=false;await f.supervisor.poll();assert.equal(f.rows[1].status,'needs-authorization');
 f.authorized=true;await f.supervisor.poll();assert.equal(f.rows[1].status,'listening');
 f.running=false;await f.supervisor.poll();await f.supervisor.configure(false);assert.deepEqual(f.stored,{autoFollowImClients:false});assert.equal(f.rows[0].status,'listening');
 await f.supervisor.configure(true);assert.equal(f.rows[0].status,'waiting-client');assert.equal(f.calls.some(x=>x.endsWith('manual-stop')),false);
 f.supervisor.close();
});
test('manual Stop and shutdown during an auth check cannot restart bindings; overlapping polls coalesce',async()=>{
 const f=fixture();let release;f.gate=new Promise(r=>release=r);
 const first=f.supervisor.poll();assert.equal(first,f.supervisor.poll());await new Promise(r=>setImmediate(r));
 f.rows[0].enabled=false;f.rows[1].enabled=false;release();await first;assert.deepEqual(f.calls,[]);
 f.rows[0].enabled=true;f.gate=new Promise(r=>release=r);const pending=f.supervisor.poll();await new Promise(r=>setImmediate(r));f.supervisor.close();release();await pending;assert.deepEqual(f.calls,[]);
});

test('Feishu authorization failures remain distinct from absent clients and recover after authorization',async()=>{
 const f=fixture();
 f.authorized=Error('Feishu login required');await f.supervisor.poll();assert.equal(f.rows[1].status,'needs-authorization');
 f.authorized=Error('Feishu CLI timed out');await f.supervisor.poll();assert.equal(f.rows[1].status,'authorization-error');
 f.running=false;await f.supervisor.poll();assert.equal(f.rows[1].status,'waiting-client');
 f.running=true;f.authorized=true;await f.supervisor.poll();assert.equal(f.rows[1].status,'listening');
 f.supervisor.close();
});
