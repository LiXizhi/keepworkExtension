const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function load(name){const file=path.resolve(__dirname,'../src/core',name+'.ts'),m=new Module(file,module);m.filename=file;m.paths=module.paths;m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
const {organization,emptyOrganization,reconcile,circleAgentContext,circleDescription,validateGroupDescription}=load('circleModel'),{Circles}=load('circles');
const org=()=>({version:1,revision:0,name:'Test',members:[{id:'human',kind:'human',name:'Alex',identity:{channel:'feishu',account:'tenant:user',id:'u1'}},{id:'bot',kind:'persona',name:'Writer',personaId:'writer'}],circles:[{id:'product',parentId:null,name:'Product',goal:'Ship',publicDescription:'Public',archived:false,members:['human'],roles:[{id:'role',name:'Write',responsibility:'Write docs',skills:['$docs'],holders:['bot']}]}]});
function fixture(t,channel='feishu'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'circles-')),brain=path.join(home,'brain');fs.mkdirSync(brain);let active=true,root=brain,creates=0,sends=0,failCreate=false;
 const initial=org();initial.members[0].identity.channel=channel;
 let remote={name:'Product',description:channel==='feishu'?'Public':undefined,members:[{id:'u1',name:'Alex'}]};
 const adapter={operator:async()=>({id:'u1',name:'Alex'}),discover:async()=>[],requireOwner:async()=>{},verify:async()=>{},search:async()=>[],snapshot:async()=>structuredClone(remote),create:async(_root,_b,_s,_type,check,dryRun)=>{if(dryRun)return '';check?.();creates++;if(failCreate)throw Error('timeout');remote=structuredClone(_s);return 'group';},update:async(_root,b,s,_old,remove)=>{remote=structuredClone(s);},history:async()=>({messages:[{id:'m1',sender:'u1',name:'Alex',text:'Hello',time:1,kind:'text'}],cursor:'',incomplete:false}),send:async()=>{sends++;}};
 const deps={root:owner=>owner==='owner'?root:'',bindings:()=>[{id:'binding',channel,profile:'tenant:user',root:brain,enabled:true}],allowed:()=>active,agents:()=>[{id:'writer',owner:'owner',root:brain,name:'Writer',prompt:'Base'}],pause:()=>{}};
 const service=new Circles(path.join(home,'state'),deps,adapter);t.after(()=>{service.close();fs.rmSync(home,{recursive:true,force:true});});
 const request=(action,input={})=>service.request('owner',action,input);
 return {service,request,brain,home,deps,initial,adapter,get creates(){return creates;},get sends(){return sends;},remote:()=>remote,setRemote:v=>remote=v,setActive:v=>active=v,setRoot:v=>root=v,failCreate:()=>failCreate=true};
}
async function save(f){const p=await f.request('preview',{organization:f.initial,expectedRevision:0});return f.request('apply',{ticket:p.ticket});}
async function deploy(f,channel='feishu'){const s=await save(f),p=await f.request('deployPreview',{circleId:'product',channel,account:'tenant:user',expectedRevision:s.organization.revision});return f.request('deploy',{circleId:'product',ticket:p.ticket});}

for(const channel of ['feishu','dingtalk'])test(channel+' catchup continues overlapping pages across its budget and restart',async t=>{
 const f=fixture(t,channel);await deploy(f,channel);const cursors=[];
 f.adapter.history=async(_root,_binding,cursor)=>{cursors.push(cursor);const page=cursor?Number(cursor):0;return {messages:[page*2,page*2+1,page*2+2].map(n=>({id:'history-'+n,sender:'u1',name:'Alex',text:'Message '+n,time:100-n,kind:'text'})),cursor:page<6?String(page+1):'',incomplete:false};};
 let s=await f.request('refresh');let record=Object.values(s.sync)[0];assert.deepEqual(cursors,['','1','2','3','4']);assert.equal(record.incomplete,true);assert.equal(record.catchupCursor,'5');assert.equal(record.messages.length,11);
 f.service.close();const resumed=new Circles(path.join(f.home,'state'),f.deps,f.adapter);try{
  s=await resumed.request('owner','refresh',{});record=Object.values(s.sync)[0];assert.deepEqual(cursors,['','1','2','3','4','5','6']);assert.equal(record.messages.length,15);assert.equal(new Set(record.messages.map(m=>m.id)).size,15);assert.equal(record.incomplete,false);assert.equal(record.catchupCursor,'');assert.equal(f.sends,0);
  await resumed.request('owner','refresh',{});assert.equal(cursors.at(-1),'');assert.equal(cursors.length,8);
 }finally{resumed.close();}
});
test('model rejects cycles, unknown holders, duplicate group bindings and strips credentials',()=>{const v=org();v.circles[0].parentId='product';assert.throws(()=>organization(v),/cycle/);v.circles[0].parentId=null;v.circles[0].roles[0].holders=['missing'];assert.throws(()=>organization(v),/member/);const clean=org();clean.token='secret';assert.equal(organization(clean).token,undefined);});
test('three-way rename, additions and removals use IDs, not names',()=>{const b={name:'Old',members:[{id:'1',name:'Alex'}]},l={name:'New',members:[...b.members,{id:'2',name:'Alex'}]},r={name:'Old',members:b.members};const result=reconcile(b,l,r);assert.equal(result.merged.name,'New');assert.equal(result.merged.members.length,2);assert.equal(result.conflicts.length,0);assert.equal(reconcile(b,{...l,members:[]},{...r,name:'Other'}).conflicts.length,2);});
test('persona roles are scoped to their circle without parent inheritance',()=>{
 const o=org(),parent=o.circles[0];parent.binding={channel:'feishu',account:'tenant:user',id:'g'};parent.roles.push({id:'review',name:'Review',responsibility:'Review releases',skills:['$review'],holders:['bot']});
 const child={...structuredClone(parent),id:'child',parentId:'product',name:'Child',goal:'Child goal',binding:{...parent.binding,id:'child-group'},roles:[{id:'research',name:'Research',responsibility:'Research only',skills:[],holders:['bot']}]};o.circles.push(child);
 const context=circleAgentContext(o,'writer',parent.binding);assert.match(context,/Write docs/);assert.match(context,/Review releases/);assert.doesNotMatch(context,/Research only|Child goal/);
 const childContext=circleAgentContext(o,'writer',child.binding);assert.match(childContext,/Research only/);assert.doesNotMatch(childContext,/Write docs|Review releases/);assert.equal(circleAgentContext(o,'writer',{...parent.binding,id:'other'}),'');child.archived=true;assert.equal(circleAgentContext(o,'writer',child.binding),'');
});
test('preview is non-mutating, apply revision checks and isolates owners',async t=>{const f=fixture(t),p=await f.request('preview',{organization:f.initial,expectedRevision:0});assert.equal((await f.request('read')).organization.revision,0);await f.request('apply',{ticket:p.ticket});await assert.rejects(f.request('preview',{organization:f.initial,expectedRevision:0}),/变化/);await assert.rejects(f.service.request('other','read',{}));});
for(const channel of ['feishu','dingtalk'])test(channel+' deploy and messages: one group, no historical reply triggers, deduplicated send',async t=>{const f=fixture(t,channel);const s=await deploy(f,channel);assert.equal(s.organization.circles[0].binding.id,'group');assert.equal(f.creates,1);assert.equal(f.service.assignments({id:'writer',owner:'owner',root:f.brain}).length,1);await f.request('history',{circleId:'product'});assert.equal(f.sends,0);await f.request('send',{circleId:'product',text:'Hello',requestId:'same'});await f.request('send',{circleId:'product',text:'Hello',requestId:'same'});assert.equal(f.sends,1);});
test('unknown creation is not replayed after another preview',async t=>{const f=fixture(t);await save(f);f.failCreate();for(let i=0;i<2;i++){const p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',expectedRevision:1});await assert.rejects(f.request('deploy',{circleId:'product',ticket:p.ticket}));}assert.equal(f.creates,1);});
test('remote rename imports, member removal waits, gateway loss prevents writes',async t=>{const f=fixture(t);await deploy(f);f.setRemote({...f.remote(),name:'Renamed'});let s=await f.request('refresh');assert.equal(s.organization.circles[0].name,'Renamed');f.setRemote({...f.remote(),members:[]});s=await f.request('refresh');assert.equal(Object.values(s.sync)[0].conflicts[0].kind,'removal');f.setActive(false);await assert.rejects(f.request('send',{circleId:'product',text:'no',requestId:'blocked'}),/gateway/);assert.equal(f.sends,0);});
test('read-only refresh does not invalidate previews and multiple conflict decisions accumulate',async t=>{
 const f=fixture(t);let s=await deploy(f),revision=s.organization.revision;s=await f.request('refresh');assert.equal(s.organization.revision,revision);
 const next=structuredClone(s.organization);next.circles[0].name='Local';next.circles[0].goal='Local description';const p=await f.request('preview',{organization:next,expectedRevision:revision});s=await f.request('apply',{ticket:p.ticket});f.setRemote({...f.remote(),name:'Remote',description:'Remote description'});s=await f.request('refresh');assert.equal(Object.values(s.sync)[0].conflicts.length,2);
 s=await f.request('resolve',{circleId:'product',expectedRevision:s.organization.revision,resolutions:{name:'remote'}});assert.equal(Object.values(s.sync)[0].conflicts.length,1);
 s=await f.request('resolve',{circleId:'product',expectedRevision:s.organization.revision,resolutions:{description:'local'}});assert.equal(s.organization.circles[0].name,'Remote');assert.equal(s.organization.circles[0].goal,'Local description');
});
test('binding an existing group imports direct members without inferring their roles',async t=>{
 const f=fixture(t);let s=await save(f);f.setRemote({...f.remote(),members:[{id:'u2',name:'Alex'}]});const p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',groupId:'existing',expectedRevision:s.organization.revision});s=await f.request('deploy',{circleId:'product',ticket:p.ticket});assert.equal(f.creates,0);assert.equal(s.organization.members.filter(m=>m.name==='Alex').length,2);assert.equal(s.organization.circles[0].roles[0].holders.length,1);
});
test('changed brain during channel authorization blocks actual send',async t=>{
 const f=fixture(t);await deploy(f);f.adapter.send=async(_root,_b,_key,_text,_reply,check)=>{f.setRoot('');check();};await assert.rejects(f.request('send',{circleId:'product',requestId:'changing',text:'no'}));assert.equal(f.sends,0);
});
test('Feishu adapter uses explicit user identity, safe literal content, stable IDs and pagination',async()=>{
 const {CircleChannels}=load('circleChannels'),calls=[];const b={channel:'feishu',account:'app:ou_me',id:'oc_group'};
 const call=async args=>{calls.push(args);if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'ou_me'}}};if(args.includes('+chat-messages-list'))return {data:{messages:[{message_id:'m',sender:{id:'ou_sender'},create_time:'1700000000',msg_type:'text',content:'{"text":"hello"}'}],page_token:'next'}};return {code:0,data:{}};};
 const channel=new CircleChannels(async()=>{throw Error('wrong channel');},call);await channel.send('root',b,'request','@private-file');const send=calls.find(a=>a.includes('+messages-send'));assert.ok(send.includes('--as')&&send.includes('user'));assert.deepEqual(JSON.parse(send[send.indexOf('--content')+1]),{text:'@private-file'});assert.ok(!send.includes('--text'));
 const page=await channel.history('root',b,'previous');assert.equal(page.messages[0].time,1700000000000);assert.equal(page.cursor,'next');assert.ok(calls.at(-1).includes('previous'));
});
test('DingTalk adapter rejects account mismatch before any mutation',async()=>{
 const {CircleChannels}=load('circleChannels');let calls=0;const c=new CircleChannels(async()=>{calls++;return {identity:{corp_id:'other',user_id:'user'}};});await assert.rejects(c.create('root',{channel:'dingtalk',account:'corp:user',id:'new'},{name:'Test',members:[{id:'u',name:'A'}]},'INTERNAL'),/account/);assert.equal(calls,1);
});
test('restart retains send receipts, rejects changed payload, archive and unlink preserve external group',async t=>{
 const f=fixture(t);await deploy(f);await f.request('send',{circleId:'product',requestId:'durable',text:'hello'});f.service.close();
 const resumed=new Circles(path.join(f.home,'state'),f.deps,f.adapter);try{
  await resumed.request('owner','send',{circleId:'product',requestId:'durable',text:'hello'});assert.equal(f.sends,1);
  await assert.rejects(resumed.request('owner','send',{circleId:'product',requestId:'durable',text:'different'}),/different content/);
  let s=await resumed.request('owner','read',{});s.organization.circles[0].archived=true;const p=await resumed.request('owner','preview',{organization:s.organization,expectedRevision:s.organization.revision});s=await resumed.request('owner','apply',{ticket:p.ticket});assert.equal(resumed.assignments({id:'writer',owner:'owner',root:f.brain}).length,0);
  await resumed.request('owner','unbind',{circleId:'product',expectedRevision:s.organization.revision,confirm:true});assert.equal(f.remote().name,'X-Product');
 }finally{resumed.close();}
});

for(const platform of ['feishu','dingtalk'])test(platform+' X- discovery is inbound only, identity stable, and unlink stays unlinked',async t=>{
 const f=fixture(t,platform);let updates=0;f.adapter.update=async()=>{updates++;};
 f.adapter.discover=async()=>[{id:'g1',name:'X-Team'},{id:'g2',name:'X-Team'},{id:'ordinary',name:'Team'}];
 f.setRemote({...f.remote(),name:'X-Team'});let s=await f.request('refresh');assert.equal(s.organization.circles.length,2);assert.notEqual(s.organization.circles[0].id,s.organization.circles[1].id);assert.equal(s.organization.members.length,1);assert.equal(s.organization.circles[0].roles.length,0);
 const circleId=s.organization.circles[0].id,revision=s.organization.revision;s=await f.request('refresh');assert.equal(s.organization.revision,revision);assert.equal(updates,0);
 f.setRemote({...f.remote(),name:'Renamed'});s=await f.request('refresh');assert.equal(s.organization.circles[0].id,circleId);assert.equal(s.organization.circles[0].name,'Renamed');
 s=await f.request('unbind',{circleId,expectedRevision:s.organization.revision,confirm:true});s=await f.request('refresh');assert.equal(s.organization.circles.length,2);assert.equal(s.organization.circles[0].binding,undefined);
});
test('local changes stay pending until owner preview and explicit publish; ownership is checked again',async t=>{
 const f=fixture(t);let s=await deploy(f),updates=0;const original=f.adapter.update;f.adapter.update=async(...args)=>{updates++;await original(...args);};
 const next=structuredClone(s.organization);next.circles[0].name='X-Local';let p=await f.request('preview',{organization:next,expectedRevision:s.organization.revision});s=await f.request('apply',{ticket:p.ticket});s=await f.request('refresh');assert.equal(updates,0);assert.equal(f.remote().name,'X-Product');assert.equal(Object.values(s.sync)[0].pendingPublish,true);
 p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});assert.equal(updates,0);
 f.adapter.requireOwner=async()=>{throw Error('owner required');};await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'denied'}),/owner/);assert.equal(updates,0);
 await assert.rejects(f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision}),/owner/);
 f.adapter.requireOwner=async()=>{};p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});s=await f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'allowed'});assert.equal(updates,1);assert.equal(f.remote().name,'X-Local');assert.equal(Object.values(s.sync)[0].pendingPublish,false);
});
test('stale external preview cannot overwrite a changed group',async t=>{
 const f=fixture(t);const s=await deploy(f),p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});let writes=0;f.adapter.update=async()=>{writes++;};f.setRemote({...f.remote(),name:'X-Changed'});await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'stale'}),/变化/);assert.equal(writes,0);
});
test('discovery errors are visible and inactive gateways never scan',async t=>{
 const f=fixture(t);let scans=0;f.adapter.discover=async()=>{scans++;throw Error('incomplete groups');};let s=await f.request('refresh');assert.match(Object.values(s.discovery)[0].error,/incomplete/);assert.equal(s.organization.circles.length,0);f.setActive(false);await f.request('refresh');assert.equal(scans,1);
});
for(const platform of ['feishu','dingtalk'])test(platform+' adapter paginates discovery and permits verified administrators',async()=>{
 const {CircleChannels}=load('circleChannels'),calls=[];let owner=false;
 const b={channel:platform,account:platform==='feishu'?'app:ou_me':'corp:user',id:'g'};
 const call=async args=>{calls.push(args);
  if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'ou_me'}}};
  if(args[0]==='event')return {identity:{corp_id:'corp',user_id:'user'}};
  if(args.includes('get'))return {data:{owner_id:owner?'ou_me':'ou_other',user_manager_id_list:[]}};
  if(args.includes('+chat-list'))return {data:args.includes('--page-token')?{chats:[{chat_id:'g',name:'X-Team'}],has_more:false}:{chats:[{chat_id:'normal',name:'Team'}],has_more:true,page_token:'next'}};
  if(args.includes('list-all'))return {result:args.includes('--cursor')?{groups:[{openConversationId:'g',title:'X-Team',myRole:owner?'群管理员':'普通成员',ownerOpenDingtalkId:'open-owner'}],hasMore:false}:{groups:[],hasMore:true,nextCursor:'next'}};
  return {};
 };
 const adapter=new CircleChannels(call,call);assert.deepEqual((await adapter.discover('root',b)).map(g=>g.id),['g']);
 await assert.rejects(adapter.update('root',b,{name:'changed',members:[]},{name:'old',members:[]}),/群主/);assert.ok(!calls.some(a=>a.includes('+chat-update')||a.includes('rename')));
 owner=true;await adapter.requireOwner('root',b);
});
test('unknown publish is never blindly replayed under another request ID',async t=>{
 const f=fixture(t);const s=await deploy(f);let calls=0;f.adapter.update=async()=>{calls++;throw Error('timeout');};
 for(const requestId of ['one','two']){const p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId}));}assert.equal(calls,1);
});

test('brain scope rejects a stale draft even when both brains have revision zero',async t=>{
 const f=fixture(t),original=await f.request('read'),other=path.join(f.home,'other-brain');fs.mkdirSync(other);f.setRoot(other);
 const current=await f.request('read');assert.equal(current.organization.revision,original.organization.revision);assert.notEqual(current.scope,original.scope);
 for(const action of ['preview','refresh','search'])await assert.rejects(f.request(action,{expectedScope:original.scope,organization:f.initial,expectedRevision:0}),/第二大脑已切换/);
 assert.equal(fs.existsSync(path.join(other,'.aichat','circles','organization.json')),false);
 const proposal={...current.organization,name:'New brain organization'},preview=await f.request('preview',{expectedScope:current.scope,expectedRevision:0,organization:proposal});const result=await f.request('apply',{expectedScope:current.scope,ticket:preview.ticket});assert.equal(result.organization.name,'New brain organization');
 f.setRoot(f.brain);await assert.rejects(f.request('apply',{expectedScope:current.scope,ticket:preview.ticket}),/第二大脑已切换/);assert.equal((await f.request('read')).organization.revision,0);
});

test('partial publish is explicitly verified and a new preview executes only remaining changes',async t=>{
 const f=fixture(t);let s=await deploy(f);s.organization.circles[0].name='X-Updated';s.organization.members.push({id:'second',kind:'human',name:'Other',identity:{channel:'feishu',account:'tenant:user',id:'u2'}});s.organization.circles[0].members.push('second');let p=await f.request('preview',{organization:s.organization,expectedRevision:s.organization.revision});s=await f.request('apply',{ticket:p.ticket});
 let fail=true,renames=0,adds=0;f.adapter.update=async(_root,_binding,desired)=>{let actual=f.remote();if(actual.name!==desired.name){renames++;f.setRemote({...actual,name:desired.name});}if(fail){fail=false;throw Error('timeout after rename');}adds+=desired.members.filter(m=>!f.remote().members.some(r=>r.id===m.id)).length;f.setRemote(structuredClone(desired));};
 p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'partial'}));s=await f.request('read');const receiptId=Object.keys(s.receipts).find(key=>key.endsWith(':partial'));assert.equal(s.receipts[receiptId].intent.desired.name,'X-Updated');
 const verified=await f.request('verifyReceipt',{circleId:'product',receiptId});assert.equal(verified.status,'reviewed');assert.equal(renames,1);assert.equal(adds,0);assert.equal(verified.actual.members.length,1);
 p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});s=await f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'remaining'});assert.equal(renames,1);assert.equal(adds,1);assert.equal(f.creates,1);assert.equal(s.receipts[receiptId].status,'superseded');
});
test('completed-but-unknown publish is verified after restart without repeating writes',async t=>{
 const f=fixture(t);const s=await deploy(f);let writes=0;f.adapter.update=async(_root,_binding,desired)=>{writes++;f.setRemote(structuredClone(desired));throw Error('ack lost');};
 const p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'ack-lost'}));f.service.close();
 const restarted=new Circles(path.join(f.home,'state'),f.deps,f.adapter);try{const snapshot=await restarted.request('owner','read',{}),receiptId=Object.keys(snapshot.receipts).find(key=>key.endsWith(':ack-lost'));const result=await restarted.request('owner','verifyReceipt',{circleId:'product',receiptId});assert.equal(result.status,'done');assert.equal(writes,1);assert.equal(result.snapshot.receipts[receiptId].status,'done');}finally{restarted.close();}
});
test('verification read failure stays unknown, and message receipts cannot be verified as group updates',async t=>{
 const f=fixture(t);const s=await deploy(f);f.adapter.update=async()=>{throw Error('timeout');};const p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});await assert.rejects(f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'pending'}));let snapshot=await f.request('read');const receiptId=Object.keys(snapshot.receipts).find(key=>key.endsWith(':pending'));f.adapter.snapshot=async()=>{throw Error('permission denied');};await assert.rejects(f.request('verifyReceipt',{circleId:'product',receiptId}),/permission/);snapshot=await f.request('read');assert.equal(snapshot.receipts[receiptId].status,'unknown');await assert.rejects(f.request('verifyReceipt',{circleId:'product',receiptId:'send:made-up'}),/无法/);
});
test('unknown creation is resolved by explicit existing-group binding without another create',async t=>{
 const f=fixture(t);let s=await save(f);f.failCreate();let p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',expectedRevision:s.organization.revision});await assert.rejects(f.request('deploy',{circleId:'product',ticket:p.ticket}));p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',groupId:'found-group',expectedRevision:s.organization.revision});s=await f.request('deploy',{circleId:'product',ticket:p.ticket});assert.equal(f.creates,1);assert.equal(s.organization.circles[0].binding.id,'found-group');assert.equal(Object.values(s.receipts).find(r=>r.status==='linked').linkedGroup.id,'found-group');
});

 test('circle platform persists and rejects cross-platform deployment or bound edits',async t=>{
  const f=fixture(t,'feishu');f.initial.circles[0].platform='feishu';const saved=await save(f);
  assert.equal(saved.organization.circles[0].platform,'feishu');
  await assert.rejects(f.request('deployPreview',{circleId:'product',channel:'dingtalk',account:'tenant:user',expectedRevision:saved.organization.revision}),/平台/);
  const p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',expectedRevision:saved.organization.revision});
  const result=await f.request('deploy',{circleId:'product',ticket:p.ticket});
  const invalid=structuredClone(result.organization);invalid.circles[0].platform='dingtalk';
  assert.throws(()=>organization(invalid),/platform/);
  invalid.circles[0].platform='invalid';assert.throws(()=>organization(invalid),/platform/);
 });

test('independent organizations preserve legacy data, isolate revisions/tickets and survive restart',async t=>{
 const f=fixture(t);const original=await save(f),file=path.join(f.brain,'.aichat/circles/organization.json'),bytes=fs.readFileSync(file,'utf8');
 const next=await f.request('createOrganization',{name:'Another team',requestId:'new-team',expectedRevision:original.organization.revision,expectedScope:original.scope});
 assert.equal(next.organizations.length,2);assert.notEqual(next.scope,original.scope);assert.equal(next.organization.circles.length,0);assert.equal(fs.readFileSync(file,'utf8'),bytes);
 assert.equal((await f.request('createOrganization',{name:'Another team',requestId:'new-team',expectedRevision:original.organization.revision})).organizationId,next.organizationId);
 await assert.rejects(f.request('preview',{organizationId:next.organizationId,expectedScope:original.scope,expectedRevision:next.organization.revision,organization:f.initial}),/切换/);
 const draft=await f.request('preview',{expectedRevision:original.organization.revision,organization:{...original.organization,name:'Changed default'}});
 await assert.rejects(f.request('apply',{organizationId:next.organizationId,ticket:draft.ticket}),/预览/);
 const secondDraft=await f.request('preview',{organizationId:next.organizationId,expectedRevision:next.organization.revision,organization:{...f.initial,name:'Another team'}});
 await f.request('apply',{organizationId:next.organizationId,ticket:secondDraft.ticket});
 assert.equal((await f.request('read')).organization.name,'Test');assert.equal(fs.readFileSync(file,'utf8'),bytes);
 f.service.close();const resumed=new Circles(path.join(f.home,'state'),f.deps,f.adapter);try{const value=await resumed.request('owner','read',{organizationId:next.organizationId});assert.equal(value.organization.circles[0].id,'product');assert.equal(value.organizations.length,2);assert.equal(value.scope,next.scope);}finally{resumed.close();}
 await assert.rejects(f.request('read',{organizationId:'../../escape'}),/Invalid organization/);
});

test('all organizations route persona context and messages, refresh independently and reject duplicate groups',async t=>{
 const f=fixture(t);const first=await deploy(f);const second=await f.request('createOrganization',{name:'Second',requestId:'second',expectedRevision:first.organization.revision});
 const scoped=(action,input={})=>f.request(action,{organizationId:second.organizationId,...input});
 let p=await scoped('preview',{organization:{...f.initial,name:'Second',circles:[{...f.initial.circles[0],goal:'Second goal'}]},expectedRevision:second.organization.revision});let s=await scoped('apply',{ticket:p.ticket});
 await assert.rejects(scoped('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',groupId:'group',expectedRevision:s.organization.revision}),/其他组织/);
 p=await scoped('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',groupId:'group-two',expectedRevision:s.organization.revision});s=await scoped('deploy',{circleId:'product',ticket:p.ticket});
 const agent=f.deps.agents()[0];assert.deepEqual(f.service.assignments(agent).map(x=>x.id).sort(),['group','group-two']);assert.match(f.service.context(agent,s.organization.circles[0].binding),/Second goal/);assert.doesNotMatch(f.service.context(agent,first.organization.circles[0].binding),/Second goal/);
 f.service.observe('owner',s.organization.circles[0].binding,{id:'only-second',sender:'u1',name:'Alex',text:'Second only',time:2,kind:'text'});
 let value=await scoped('read');assert.equal(Object.values(value.sync)[0].messages[0].id,'only-second');assert.equal(Object.values((await f.request('read')).sync)[0].messages,undefined);
 const snapshots=[];f.adapter.snapshot=async(_root,b)=>{snapshots.push(b.id);return {name:b.id,description:'Public',members:[]};};
 f.adapter.discover=async()=>[{id:'group-two',name:'X-Second'}];await f.service.refreshAll('owner');assert.ok(snapshots.includes('group'));assert.ok(snapshots.includes('group-two'));assert.equal((await f.request('read')).organization.circles.length,1);
 assert.equal((await scoped('read')).organization.circles.length,1);
});

test('primary owner is explicit, validated and survives save; collaborators retain routing',async t=>{
 const old=organization(org());assert.equal(old.circles[0].roles[0].primaryHolder,undefined);
 const f=fixture(t),role=f.initial.circles[0].roles[0];role.primaryHolder='human';role.holders=['human','bot'];
 const saved=await save(f);assert.equal(saved.organization.circles[0].roles[0].primaryHolder,'human');
 assert.equal((await f.request('read')).organization.circles[0].roles[0].primaryHolder,'human');
 const value=structuredClone(saved.organization);value.circles[0].binding={channel:'feishu',account:'tenant:user',id:'g'};
 assert.match(circleAgentContext(value,'writer',value.circles[0].binding),/Write docs/);
 value.circles[0].roles[0].primaryHolder='missing';assert.throws(()=>organization(value),/Primary owner/);
 value.circles[0].roles[0].primaryHolder=null;assert.equal(organization(value).circles[0].roles[0].primaryHolder,null);
});

test('group description projects goal, roles, collaborators and DRI without identity inference',async t=>{
 const f=fixture(t),c=f.initial.circles[0];c.roles[0].holders=['bot','human'];c.roles[0].primaryHolder='human';
 assert.equal(circleDescription(f.initial,c),'目标：Ship\n角色：Write:Writer&Alex\nDRI:Alex');
 let s=await deploy(f);assert.equal(f.remote().description,'目标：Ship\n角色：Write:Writer&Alex\nDRI:Alex');
 const next=structuredClone(s.organization);next.circles[0].goal='Launch';next.members.find(m=>m.id==='bot').name='deluca';
 const draft=await f.request('preview',{organization:next,expectedRevision:s.organization.revision});s=await f.request('apply',{ticket:draft.ticket});
 const p=await f.request('publishPreview',{circleId:'product',expectedRevision:s.organization.revision});assert.equal(p.desired.description,'目标：Launch\n角色：Write:deluca&Alex\nDRI:Alex');
 s=await f.request('publish',{circleId:'product',ticket:p.ticket,requestId:'description'});assert.equal(f.remote().description,p.desired.description);
 s=await f.request('refresh');assert.equal(s.organization.circles[0].publicDescription,'Public');assert.equal(s.organization.circles[0].goal,'Launch');
 assert.throws(()=>validateGroupDescription({channel:'feishu'},{description:'字'.repeat(101)}),/100/);
 validateGroupDescription({channel:'feishu'},{description:'字'.repeat(100)});
 const imported=org();imported.circles[0].goal='';imported.circles[0].roles=[];assert.equal(circleDescription(imported,imported.circles[0]),'Public');
});

test('DingTalk dedicated X:goal notice creates once, edits only matching notice and rejects ambiguity',async()=>{
 const {CircleChannels}=load('circleChannels'),b={channel:'dingtalk',account:'corp:user',id:'g'};
 const notices=[{dataId:'other',content:'# General\nKeep me'}],writes=[];let duplicate=false,incomplete=false;
 const call=async args=>{
  if(args[0]==='event')return {identity:{corp_id:'corp',user_id:'user'}};
  if(args.includes('list-all'))return {result:{groups:[{openConversationId:'g',name:'X-Team',myRole:'群主',ownerOpenDingtalkId:'owner'}],hasMore:false}};
  if(args.includes('notice')){
   const op=args[3];
   if(op==='list')return {result:{items:duplicate?[...notices,{dataId:'duplicate',content:'# X:goal\n\nNew'}]:notices,hasMore:incomplete}};
   if(op==='get')return {result:args.includes('duplicate')?{content:'# X:goal\n\nNew'}:notices.find(n=>n.dataId===args[args.indexOf('--notice-id')+1])};
   writes.push(args);const content=args[args.indexOf('--content')+1];
   if(op==='create')notices.push({dataId:'goal',content});else notices.find(n=>n.dataId===args[args.indexOf('--notice-id')+1]).content=content;
   return {result:{dataId:'goal'}};
  }throw Error('Unexpected '+args.join(' '));
 };
 const adapter=new CircleChannels(call),remote={name:'X-Team',description:'',members:[]};
 await adapter.update('root',b,{...remote,description:'New'},remote);assert.equal(writes.length,1);assert.equal(writes[0][3],'create');
 await adapter.update('root',b,{...remote,description:'Next'},{...remote,description:'New'});assert.equal(writes[1][3],'edit');assert.ok(writes[1].includes('goal'));assert.equal(notices[0].content,'# General\nKeep me');
 await adapter.update('root',b,{...remote,description:'Next'},{...remote,description:'Next'});assert.equal(writes.length,2);
 duplicate=true;await assert.rejects(adapter.update('root',b,{...remote,description:'Third'},{...remote,description:'Next'}),/多条/);duplicate=false;
 incomplete=true;await assert.rejects(adapter.update('root',b,{...remote,description:'Third'},{...remote,description:'Next'}),/分页/);assert.equal(writes.length,2);
 assert.ok(writes.every(a=>!a.includes('--send-ding')&&!a.includes('--sticky')));
});

for(const channel of ['feishu','dingtalk'])test(channel+' pulls group goal and roles through a non-mutating preview',async t=>{
 const f=fixture(t,channel);let saved=await deploy(f,channel);
 f.setRemote({...f.remote(),name:'X-Remote',description:'目标：New goal\n角色：Developer:Writer&Alex\nDRI:Alex'});
 const p=await f.request('pullPreview',{circleId:'product',expectedRevision:saved.organization.revision});
 assert.equal((await f.request('read')).organization.circles[0].goal,'Ship');
 assert.equal(p.after.circles[0].goal,'New goal');assert.equal(p.after.circles[0].roles[0].name,'Developer');assert.deepEqual(p.after.circles[0].roles[0].holders,['bot','human']);assert.equal(p.after.circles[0].roles[0].primaryHolder,'human');
 saved=await f.request('apply',{ticket:p.ticket});assert.equal(saved.organization.circles[0].name,'X-Remote');assert.equal(f.sends,0);
 f.setRemote({...f.remote(),description:'目标：Unsafe\n角色：Developer:Unknown'});await assert.rejects(f.request('pullPreview',{circleId:'product',expectedRevision:saved.organization.revision}),/无法唯一匹配/);assert.equal((await f.request('read')).organization.circles[0].goal,'New goal');
});
test('related agents project one verified human and suspend routing when that human leaves',async t=>{
 const f=fixture(t);f.initial.circles[0].members=[];f.initial.members.push({id:'bot2',kind:'persona',name:'Reviewer',personaId:'reviewer'});f.initial.circles[0].roles[0].holders.push('bot2');
 f.deps.agents=()=>['writer','reviewer'].map(id=>({id,owner:'owner',root:f.brain,name:id,prompt:'Base'}));
 let s=await save(f);const p=await f.request('deployPreview',{circleId:'product',channel:'feishu',account:'tenant:user',expectedRevision:s.organization.revision});assert.equal(p.desired.members.length,1);assert.equal(p.operators.length,2);assert.equal(p.operators[0].human.id,'u1');
 await f.request('deploy',{circleId:'product',ticket:p.ticket});const agent=f.deps.agents()[0];assert.equal(f.service.assignments(agent).length,1);
 f.setRemote({...f.remote(),members:[]});await f.request('refresh');assert.equal(f.service.assignments(agent).length,0);
 f.setRemote({...f.remote(),members:[{id:'u1',name:'Alex'}]});await f.request('refresh');assert.equal(f.service.assignments(agent).length,1);
});
test('verified platform operator IDs never fall back to a display name or corp user ID',async()=>{
 const {CircleChannels}=load('circleChannels');const adapter=new CircleChannels(async()=>({identity:{corp_id:'corp',user_id:'user',user_name:'Alex'}}));
 await assert.rejects(adapter.operator('root',{channel:'dingtalk',account:'corp:user',id:'g'}),/openDingtalkId/);
 const feishu=new CircleChannels(undefined,async()=>({appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'ou_me'}}}));
 assert.equal((await feishu.operator('root',{channel:'feishu',account:'app:ou_me',id:'g'})).id,'ou_me');
});
test('Feishu administrator is allowed without becoming the group owner',async()=>{
 const {CircleChannels}=load('circleChannels');const adapter=new CircleChannels(undefined,async args=>args[0]==='auth'?{appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'ou_me'}}}:{data:{owner_id:'ou_other',user_manager_id_list:['ou_me']}});
 await adapter.requireOwner('root',{channel:'feishu',account:'app:ou_me',id:'g'});
});

test('pull apply rejects a group that changed after preview and same-name identity ambiguity',async t=>{
 const f=fixture(t);const s=await deploy(f);
 f.setRemote({...f.remote(),description:'目标：First\n角色：Write:Writer'});
 const p=await f.request('pullPreview',{circleId:'product',expectedRevision:s.organization.revision});
 f.setRemote({...f.remote(),description:'目标：Second\n角色：Write:Writer'});
 await assert.rejects(f.request('apply',{ticket:p.ticket}),/群资料已变化/);assert.equal((await f.request('read')).organization.circles[0].goal,'Ship');
 f.setRemote({...f.remote(),members:[...f.remote().members,{id:'u2',name:'Alex'}],description:'目标：Second\n角色：Write:Alex'});
 await assert.rejects(f.request('pullPreview',{circleId:'product',expectedRevision:s.organization.revision}),/无法唯一匹配/);assert.equal((await f.request('read')).organization.members.length,2);
});

for(const channel of ['feishu','dingtalk'])test(channel+' organization IM configuration and member sync deduplicate by identity and preserve roles',async t=>{
 const f=fixture(t,channel);f.initial.im={channel,account:'tenant:user'};f.initial.circles[0].platform=channel;
 let s=await save(f);f.adapter.directory=async()=>({groups:2,members:[{id:'u1',name:'Renamed Alex'},{id:'u2',name:'Renamed Alex'}]});
 const p=await f.request('membersPreview',{expectedRevision:s.organization.revision});assert.equal((await f.request('read')).organization.members.length,2);
 s=await f.request('apply',{ticket:p.ticket});assert.equal(s.organization.members.length,3);assert.equal(s.organization.members.find(m=>m.id==='human').name,'Renamed Alex');assert.deepEqual(s.organization.circles[0].roles[0].holders,['bot']);assert.equal(s.memberSync.count,2);
 const again=await f.request('membersPreview',{expectedRevision:s.organization.revision});s=await f.request('apply',{ticket:again.ticket});assert.equal(s.organization.members.length,3);
 f.adapter.directory=async()=>{throw Error('Incomplete member list');};await assert.rejects(f.request('membersPreview',{expectedRevision:s.organization.revision}),/Incomplete/);assert.equal((await f.request('read')).organization.members.length,3);
 await assert.rejects(f.request('deployPreview',{circleId:'product',channel:channel==='feishu'?'dingtalk':'feishu',account:'tenant:user',expectedRevision:s.organization.revision}),/组织配置/);
});
test('organization IM rejects incompatible existing group bindings',()=>{
 const value=org();value.im={channel:'dingtalk',account:'other'};value.circles[0].binding={channel:'feishu',account:'tenant:user',id:'g'};assert.throws(()=>organization(value),/组织 IM/);
});

test('company directory stops at 100 people without scanning groups',async()=>{
 const {CircleChannels}=load('circleChannels'),calls=[];
 const adapter=new CircleChannels(async args=>{calls.push(args);if(args[0]==='event')return {identity:{corp_id:'corp',user_id:'user'}};if(args.includes('list-members'))return {deptUserList:Array.from({length:130},(_,i)=>({userInfo:{userId:'u'+i,name:'Member '+i}}))};throw Error('Unexpected request');});
 const result=await adapter.directory('root',{channel:'dingtalk',account:'corp:user',id:'organization'});assert.equal(result.members.length,100);assert.equal(result.limited,true);assert.equal(result.source,'company');assert.ok(calls.every(a=>!a.includes('chat')));assert.equal(calls.length,2);
});
test('company directory traverses departments and deduplicates stable IDs',async()=>{
 const {CircleChannels}=load('circleChannels');const adapter=new CircleChannels(async args=>{
 if(args[0]==='event')return {identity:{corp_id:'corp',user_id:'user'}};
 if(args.includes('list-members'))return {deptUserList:[{userInfo:{userId:'u1',name:'A'}},{userInfo:{userId:args[args.indexOf('--depts')+1],name:'A'}}]};
 return {result:args[args.indexOf('--dept')+1]==='1'?[{deptId:2}]:[]};});
 const result=await adapter.directory('root',{channel:'dingtalk',account:'corp:user',id:'organization'});assert.equal(result.members.length,3);assert.equal(result.limited,false);
});
test('Feishu company directory uses tenant departments and open IDs with a 100 person cap',async()=>{
 const {CircleChannels}=load('circleChannels'),calls=[];let page=0;const adapter=new CircleChannels(undefined,async args=>{calls.push(args);if(args[0]==='auth')return {appId:'app',identities:{user:{status:'ready',available:true,verified:true,openId:'self'}}};page++;return {code:0,data:{items:Array.from({length:50},(_,i)=>({open_id:'u'+((page-1)*50+i),name:'Member'})),has_more:true,page_token:'p'+page}};});
 const result=await adapter.directory('root',{channel:'feishu',account:'app:self',id:'organization'});assert.equal(result.members.length,100);assert.equal(result.limited,true);assert.equal(page,2);assert.ok(calls.slice(1).every(a=>a.includes('/open-apis/contact/v3/users/find_by_department')));
});

test('account labels match exact profile and expose no credentials',async()=>{
 const {CircleChannels}=load('circleChannels');let calls=0;const adapter=new CircleChannels(async()=>{calls++;return {profiles:[{profile:'other:user',corpName:'Wrong'},{profile:'corp:user',corpName:'Company',userName:'Alex',token:'secret'}]};});
 const binding={channel:'dingtalk',account:'corp:user',id:'label'};assert.deepEqual(await adapter.accountLabel('root',binding),{organization:'Company',accountName:'Alex'});await adapter.accountLabel('root',binding);assert.equal(calls,1);
 assert.deepEqual(await adapter.accountLabel('root',{...binding,account:'unknown:user'}),{organization:'',accountName:''});
});
