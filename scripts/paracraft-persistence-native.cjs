const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const [reportArg,outArg]=process.argv.slice(2);assert(reportArg&&outArg,'Usage: node scripts/paracraft-persistence-native.cjs NATIVE_REPORT OUTPUT');
const saved=JSON.parse(fs.readFileSync(reportArg,'utf8')),out=path.resolve(outArg),name=saved.result.name;
assert(saved.identity.worldPath.includes('/CreationAcceptance')&&/^[\w-]+$/.test(name));
async function cli(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native read timeout')));req.end(body);
 });assert(reply.ok&&reply.result.ok,JSON.stringify(reply));return reply.result;
}
const world=p=>cli('run_command',{world:p});
async function entered(target){
 const until=Date.now()+60000;let state;
 while(Date.now()<until){state=await world({operation:'status'});if(state.worldEntered&&state.worldPath===target)return state;await new Promise(r=>setTimeout(r,500));}
 throw new Error('Open pending; inspect same client without repeating open: '+JSON.stringify(state));
}
async function snapshot(identity){
 const code=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.worldPath==${JSON.stringify(identity.worldPath)} and w.identity.sessionId==${identity.sessionId});local function read(path)local f=ParaIO.open(w.identity.worldPath..path,"r");assert(f:IsValid(),path);local t=f:GetText(0,-1);f:close();return t end;local root="creation/${name}/";local text=read(root.."manifest.json");local d=commonlib.Json.Decode(text);local count,stale=0,{};for k,m in pairs(d.cells) do count=count+1;if w:Fingerprint(w:Snapshot(m.position))~=m.fingerprint then stale[#stale+1]={key=k,group=m.group} end end;local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local e=assert(E.GetBlockEntity(${saved.result.animation.moviePosition.join(',')}));assert(e.class_name=="EntityMovieClip");local I=commonlib.gettable("MyCompany.Aries.Game.Items.ItemTimeSeries");local tracks={};for slot=1,e.inventory:GetSlotCount()do local item=e.inventory:GetItem(slot);if item and type(item.serverdata)=="table" and item.serverdata.timeseries then tracks[#tracks+1]=I:SerializeServerData(item.serverdata,true) end end;local assets={};${Object.values(saved.result.files).map(file=>`assets[${JSON.stringify(file)}]=ParaMisc.md5(read(${JSON.stringify(file)}));`).join('')}local s=C.Scene:new():Init({name="${name}",resume=true},{wait=function()end,authoringSession="rsi-template-native"});local groups=0;for _ in pairs(s.groups)do groups=groups+1 end;return {members=count,stale=stale,groups=groups,origin=s.origin,dimensions=s.dimensions,manifest=ParaMisc.md5(text),source=ParaMisc.md5(read(root.."source.lua")),tracks=ParaMisc.md5(table.concat(tracks,"\\n")),actors=#tracks,assets=assets};`;
 return (await cli('run_npl_code',{code})).result;
}
(async()=>{
 let identity=(await cli('get_creation_capabilities')).identity;assert.deepEqual(identity,saved.identity);
 const before=await snapshot(identity);assert.equal(Object.keys(before.stale).length,0);assert.equal(before.actors,5);
 const fixture='CreationAcceptance RSI31 Space',created=await world({operation:'create',name:fixture});
 assert.equal(created.status,'exists','Use the existing disposable lifecycle fixture');
 const originalName=identity.worldPath.replace(/\/+$/,'').split('/').at(-1),rounds=[];
 for(let round=1;round<=2;round++){
  assert.equal((await world({operation:'save',expectedWorldPath:identity.worldPath})).status,'saved');
  assert.equal((await world({operation:'open',name:fixture,expectedWorldPath:identity.worldPath,confirmSwitch:true})).status,'open_requested');
  await entered(created.worldPath);
  assert.equal((await world({operation:'open',name:originalName,expectedWorldPath:created.worldPath,confirmSwitch:true})).status,'open_requested');
  await entered(saved.identity.worldPath);const next=(await cli('get_creation_capabilities')).identity;assert.notEqual(next.sessionId,identity.sessionId);identity=next;
  const after=await snapshot(identity);assert.deepEqual(after,before,'Saved member/track/asset data changed after reopen');rounds.push({round,identity,snapshot:after});
 }
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({before,rounds},null,2));
 fs.writeFileSync(path.join(out,'reopened-report.json'),JSON.stringify({...saved,identity},null,2));
 console.log('PASS two native saves/reopens: exact track/source/manifest/asset hashes, groups and non-stale members');console.log({identity,members:before.members,actors:before.actors,groups:before.groups});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
