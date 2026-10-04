const assert=require('node:assert/strict');const fs=require('node:fs');const http=require('node:http');const path=require('node:path');
const [reportArg]=process.argv.slice(2);assert(reportArg,'Usage: node scripts/paracraft-boat-native-check.cjs NATIVE_BOAT_REPORT');
const r=JSON.parse(fs.readFileSync(reportArg,'utf8')),bs=r.result.blocksize;
const pose=time=>r.images.find(frame=>frame.timeSeconds===time).articulatedPose.actors;
const initial=pose(0),dip=pose(0.5),lift=pose(1.5),last=pose(2);
const base=initial.hull.position.map((n,i)=>n-[10.5,0.25,5.5][i]*bs);
function tip(actor){
 const [x,y,z,w]=actor.rotation,v=[1.5625,0.03125,0];
 const t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];
 const rotated=[v[0]+w*t[0]+y*t[2]-z*t[1],v[1]+w*t[1]+z*t[0]-x*t[2],v[2]+w*t[2]+x*t[1]-y*t[0]];
 return rotated.map((n,i)=>n+(actor.position[i]-base[i])/bs);
}
const tips={};
for(const name of ['left_oar','right_oar']){
 const down=tip(dip[name]),up=tip(lift[name]);assert(down[1]<-0.1&&up[1]>0.6,'Oar did not dip/lift');
 assert(down[0]>=8&&down[0]<=13&&down[2]>=3&&down[2]<=8,'Blade enters bank rather than water');
 tips[name]={dip:down,recovery:up};
}
for(const name of Object.keys(initial)){
 initial[name].position.forEach((n,i)=>assert(Math.abs(n-last[name].position[i])<0.0001,'Boat loop position discontinuity'));
 if(initial[name].rotation)assert(Math.abs(initial[name].rotation.reduce((sum,n,i)=>sum+n*last[name].rotation[i],0))>0.9999,'Oar loop discontinuity');
}
assert(/^[\w-]+$/.test(r.result.name));
const code=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.worldPath==${JSON.stringify(r.identity.worldPath)} and w.identity.sessionId==${r.identity.sessionId});local f=ParaIO.open(w.identity.worldPath.."creation/${r.result.name}/manifest.json","r");assert(f:IsValid());local d=commonlib.Json.Decode(f:GetText(0,-1));f:close();local water,bed,banks,backups=0,0,0,0;for _,m in pairs(d.cells) do if m.group=="pond" then local state=w:Snapshot(m.position);assert(w:Fingerprint(state)==m.fingerprint,"stale pond");assert(m.original and not m.original.entity,"missing original floor backup");backups=backups+1;local y=m.position[2]-d.origin[2];if y==-2 then assert(state.id==68,"missing solid basin bed");bed=bed+1 elseif state.id==76 then water=water+1 else assert(state.id==68,"open bank");banks=banks+1 end end end;assert(water==25 and bed==49 and banks==24 and backups==98);return {water=water,bed=bed,banks=banks,backups=backups}`;
const body=JSON.stringify({v:1,action:'run_npl_code',params:{code}});
const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
 let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{
  const reply=JSON.parse(text);assert(reply.ok&&reply.result.ok,JSON.stringify(reply));
  const result={identity:r.identity,tips,loopContinuous:true,pond:reply.result.result};
  fs.writeFileSync(path.join(path.dirname(reportArg),'boat-check.json'),JSON.stringify(result,null,2));console.log('PASS native boat: loop/oar entry/recovery, enclosed water, solid bed and 98 original ground backups');
 }catch(e){console.error(e.message);process.exitCode=1;}});
});req.on('error',e=>{console.error(e.message);process.exitCode=1;});req.setTimeout(30000,()=>req.destroy(new Error('native audit timeout')));req.end(body);
