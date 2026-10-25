const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function load(name) {
 const file=path.resolve(__dirname,'../src/core',name+'.ts'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
 m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;
}
const {MessagingNicknames}=load('messagingNicknames');
function fixture(t,initial='username') {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'nickname-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const file=path.join(home,'nicknames.json'),calls=[],values=new Map();let fail=false;
 const target={channel:'dingtalk',account:'corp:user',group:'C',root:home,names:['B','A','A']};
 const key=t=>JSON.stringify([t.channel,t.account,t.group]);values.set(key(target),initial);
 const adapter={read:async t=>({nickname:values.get(key(t))??'',name:'username'}),write:async(t,nickname)=>{calls.push(nickname);values.set(key(t),nickname);if(fail)throw Error('unknown');}};
 return {target,calls,adapter,file,manager:new MessagingNicknames(file,adapter),values,key,set fail(v){fail=v;}};
}
test('group nickname aggregates names once, renames/removes agents and restores original',async t=>{
 const f=fixture(t,'username & human');
 assert.equal(await f.manager.sync(f.target),'username & human & A & B');
 await f.manager.sync(f.target);assert.equal(f.calls.length,1,'same desired state does not write');
 await f.manager.sync({...f.target,names:['New A','B']});assert.equal(f.calls.at(-1),'username & human & B & New A');
 await f.manager.sync({...f.target,names:['B']});assert.equal(f.calls.at(-1),'username & human & B');
 await f.manager.sync({...f.target,names:[]});assert.equal(f.calls.at(-1),'username & human');
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),{});
});
test('empty nickname uses account name and restores an empty nickname',async t=>{
 const f=fixture(t,'');await f.manager.sync(f.target);assert.equal(f.calls[0],'username & A & B');
 await f.manager.sync({...f.target,names:[]});assert.equal(f.calls[1],'');
});
test('manual nickname edits and concurrent changes are never overwritten',async t=>{
 const f=fixture(t);await f.manager.sync(f.target);f.values.set(f.key(f.target),'My manual name');
 await assert.rejects(f.manager.sync({...f.target,names:[]}),/手动修改/);assert.equal(f.calls.length,1);
 const g=fixture(t);let reads=0;g.adapter.read=async()=>({nickname:++reads===1?'Original':'Changed',name:'username'});
 await assert.rejects(g.manager.sync(g.target),/已变化/);assert.equal(g.calls.length,0);
});
test('unknown writes are reconciled by read after restart without a repeated write',async t=>{
 const f=fixture(t);f.fail=true;await assert.rejects(f.manager.sync(f.target),/unknown/);assert.equal(f.calls.length,1);
 const restored=new MessagingNicknames(f.file,f.adapter);await restored.sync(f.target);assert.equal(f.calls.length,1);
 f.fail=false;await restored.sync({...f.target,names:[]});assert.equal(f.calls[1],'username');
});
test('account/group isolation, stale config and byte limit prevent unintended updates',async t=>{
 const f=fixture(t);await f.manager.sync(f.target,()=>false);assert.equal(f.calls.length,0);
 await assert.rejects(f.manager.sync({...f.target,names:['名'.repeat(110)]}),/300/);assert.equal(f.calls.length,0);
 await f.manager.sync(f.target);await f.manager.sync({...f.target,account:'other:user',names:['Other']});
 assert.equal(f.values.get(f.key(f.target)),'username & A & B');assert.equal(f.calls[1],'username & Other');
});
test('serialized settings changes leave the latest aggregate and never append names twice',async t=>{
 const f=fixture(t);await Promise.all([f.manager.sync(f.target),f.manager.sync({...f.target,names:['B']})]);assert.deepEqual(f.calls,['username & A & B','username & B']);
});
test('DingTalk nickname adapter reads self settings, restores empty values, and verifies account identity',async()=>{
 const {dingtalkNickname,setDingtalkNickname}=load('messagingDingtalk'),calls=[];
 const call=async args=>{calls.push(args);if(args[0]==='event')return {identity:{corp_id:'corp',user_id:'user',open_dingtalk_id:'self'}};
  if(args[0]==='contact')return {name:'username'};
  return {data:{items:[{openConversationId:'C',groupNick:''}]}};};
 assert.deepEqual(await dingtalkNickname('/brain','corp:user','C',call),{nickname:'',name:'username'});
 await setDingtalkNickname('/brain','corp:user','C','username & A & B',call);assert.ok(calls.at(-1).includes('username & A & B'));
 await setDingtalkNickname('/brain','corp:user','C','',call);assert.equal(calls.at(-1).includes('--nick'),false);
 await assert.rejects(setDingtalkNickname('/brain','other:user','C','new',call),/identity/);
 await assert.rejects(dingtalkNickname('/brain','corp:user','wrong',call),/无法确认/);
});
test('Feishu nickname adapter uses self-only user API and delete for restoring unset nickname',async()=>{
 const {feishuNickname,setFeishuNickname}=load('messagingFeishu'),calls=[];
 const call=async args=>{calls.push(args);if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'self'}}};
  if(args[0]==='contact')return {data:{name:'username'}};return {data:{nickname:''}};};
 assert.deepEqual(await feishuNickname('/brain','app:self','C',call),{nickname:'',name:'username'});
 await setFeishuNickname('/brain','app:self','C','username & A & B',call);assert.deepEqual(JSON.parse(calls.at(-1)[calls.at(-1).indexOf('--data')+1]),{nickname:'username & A & B'});
 assert.ok(calls.at(-1).includes('user'));await setFeishuNickname('/brain','app:self','C','',call);assert.equal(calls.at(-1)[2],'delete');
 await assert.rejects(setFeishuNickname('/brain','wrong:self','C','new',call),/identity/);
});

test('damaged recovery metadata never causes a second suffix or destructive restore',async t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'broken');const manager=new MessagingNicknames(f.file,f.adapter);
 await assert.rejects(manager.sync(f.target),/恢复记录/);assert.equal(f.calls.length,0);
});

test('owner conversational assignment preserves manual nickname slots, removes only target and avoids absent removal writes',async t=>{
 const f=fixture(t,'Ｕｓｅｒ & Human & A');
 await f.manager.edit(f.target,'B',false,()=>true);assert.equal(f.calls.at(-1),'Ｕｓｅｒ & Human & A & B');
 await f.manager.edit(f.target,'A',true,()=>true);assert.equal(f.calls.at(-1),'Ｕｓｅｒ & Human & B');
 const count=f.calls.length;await f.manager.edit(f.target,'Missing',true,()=>true);assert.equal(f.calls.length,count);
 await assert.rejects(f.manager.edit(f.target,'C',false,()=>false),/cancelled/);
});

test('owner nickname edits reconcile uncertain writes without duplicate mutation',async t=>{
 const f=fixture(t);f.fail=true;await assert.rejects(f.manager.edit(f.target,'A',false,()=>true),/unknown/);
 f.fail=false;const restored=new MessagingNicknames(f.file,f.adapter);
 assert.equal(await restored.edit(f.target,'A',false,()=>true),'username & A');assert.equal(f.calls.length,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),{});
});

test('settings synchronization deduplicates manual slots and preserves them after removal',async t=>{
 const f=fixture(t,'Owner & Ａ');await f.manager.sync({...f.target,names:['A','B']});assert.equal(f.calls.at(-1),'Owner & Ａ & B');
 await f.manager.sync({...f.target,names:[]});assert.equal(f.calls.at(-1),'Owner & Ａ');
});
test('conversational edits preserve settings recovery baseline including uncertain outcomes',async t=>{
 const f=fixture(t,'Owner');await f.manager.sync({...f.target,names:['A']});
 f.fail=true;await assert.rejects(f.manager.edit(f.target,'B',false,()=>true),/unknown/);f.fail=false;
 const restored=new MessagingNicknames(f.file,f.adapter);await restored.sync({...f.target,names:[]});
 assert.equal(f.calls.at(-1),'Owner & B','remove managed A while preserving manually added B');
});
