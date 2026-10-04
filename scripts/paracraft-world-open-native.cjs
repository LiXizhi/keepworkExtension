// Native lifecycle acceptance. Saves only the fenced disposable acceptance world.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg,'Usage: node scripts/paracraft-world-open-native.cjs NATIVE_JOB_JSON OUTPUT');
const saved=JSON.parse(fs.readFileSync(jobArg,'utf8')),out=path.resolve(outArg);
assert(saved.identity.worldPath.includes('/CreationAcceptance'),'Disposable world required');
async function cli(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native read timeout')));req.end(body);
 });assert(reply.ok&&reply.result.ok,JSON.stringify(reply));return reply.result;
}
const world=p=>cli('run_command',{world:p});
async function entered(target){
 const deadline=Date.now()+60000;let last;
 while(Date.now()<deadline){
  last=await world({operation:'status'});
  if(last.worldEntered&&last.worldPath.replace(/\\/g,'/').endsWith('/'+target+'/'))return last;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 throw new Error('Opening still pending; inspect this same client without resubmitting: '+JSON.stringify(last));
}
(async()=>{
 const initial=(await cli('get_creation_capabilities')).identity;assert.deepEqual(initial,saved.identity);
 await cli('run_npl_code',{code:`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(C.World.Identity().worldPath==${JSON.stringify(initial.worldPath)} and C.World.Identity().sessionId==${initial.sessionId});NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/WorldManagement.lua",true);return true;`});
 const status=await world({operation:'status'});assert.equal(status.worldPath,initial.worldPath);
 const savedReply=await world({operation:'save',expectedWorldPath:status.worldPath});assert(savedReply.completed&&savedReply.localOnly);
 const name='CreationAcceptance RSI31 Space';
 const created=await world({operation:'create',name});assert(['created','exists'].includes(created.status));
 const opened=await world({operation:'open',name,expectedWorldPath:status.worldPath,confirmSwitch:true});assert.equal(opened.status,'open_requested');
 const fixtureStatus=await entered(name),fixtureIdentity=(await cli('get_creation_capabilities')).identity;
 assert.notDeepEqual(fixtureIdentity,initial);assert(!fixtureStatus.worldPath.includes('"'));
 const originalName=initial.worldPath.replace(/\/+$/,'').split('/').at(-1);
 const returned=await world({operation:'open',name:originalName,expectedWorldPath:fixtureStatus.worldPath,confirmSwitch:true});assert.equal(returned.status,'open_requested');
 await entered(originalName);const reopened=(await cli('get_creation_capabilities')).identity;
 assert.equal(reopened.worldPath,initial.worldPath);assert.notEqual(reopened.sessionId,initial.sessionId);
 const logs=await cli('tail_log',{lines:10});
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({initial,savedReply,created,opened,fixtureIdentity,returned,reopened,log:logs},null,2));
 fs.writeFileSync(path.join(out,'reopened.json'),JSON.stringify({...saved,identity:reopened},null,2));
 console.log('PASS native spaced-name world entry, guarded local save and return with fresh session');console.log(reopened);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
