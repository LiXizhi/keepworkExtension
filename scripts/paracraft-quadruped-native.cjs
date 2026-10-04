const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg,'Usage: node scripts/paracraft-quadruped-native.cjs COMPLETED_NATIVE_JOB_JSON OUTPUT');
const job=JSON.parse(fs.readFileSync(jobArg,'utf8')),identity=job.identity,result=job.result,out=path.resolve(outArg);
assert(job.state==='completed'&&identity.worldPath.includes('/CreationAcceptance')&&/^[\w-]+$/.test(result.name));fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){
 const body=JSON.stringify({v:1,action,params});const r=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native read timeout')));req.end(body);
 });assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result;
}
function rotate(q,v){const[x,y,z,w]=q,[a,b,c]=v,tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);return[a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];}
(async()=>{
 const boneCount=result.headLook?7:6;
 assert.deepEqual((await native('get_creation_capabilities')).identity,identity);assert.equal(result.clips.bones.length,boneCount);assert.equal(result.clips.bakedScale,1/32);
 assert.deepEqual(result.clips.clips.map(c=>[c.id,c.loop]),[[0,true],[1,true]]);
 const snapshot=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.sessionId==${identity.sessionId});local root=w.identity.worldPath.."creation/${result.name}/";local function read(name)local f=ParaIO.open(root..name,"r");assert(f:IsValid());local t=f:GetText(0,-1);f:close();return t end;local text=read("manifest.json");local d=commonlib.Json.Decode(text);local keys={};for k,m in pairs(d.cells)do local actual=w:Fingerprint(w:Snapshot(m.position));assert(actual==m.fingerprint,"stale quadruped source");keys[#keys+1]=k.."="..actual end;table.sort(keys);return {members=ParaMisc.md5(table.concat(keys,"\\n")),source=ParaMisc.md5(read("source.lua")),manifest=ParaMisc.md5(text),cells=#keys};`;
 const before=(await native('run_npl_code',{code:snapshot})).result;
 const client=new Client({name:'quadruped-native-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params={})=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId:job.authoringSession,params}});assert(!r.isError,r.content.find(c=>c.type==='text')?.text);return r;};
 try{
  const view=async()=>JSON.parse((await call('get_scene_info')).content.find(c=>c.type==='text').text).result;
  const viewBefore=await view(),images=[],checks=[];
  const cases=[{id:0,time:0},{id:0,time:0.25},{id:0,time:0.5},{id:0,time:0.75},{id:0,time:0.999},
   ...[0,0.125,0.25,0.5,0.75,1,1.25,1.5,1.75,2].map(time=>({id:1,time})),{id:1,time:0.5,repeat:1},{id:1,time:0.5,repeat:2}];
  for(const pose of cases){
   const r=await call('camera_capture',{expectedIdentity:identity,asset:{filename:result.clips.filename,animId:pose.id,timeSeconds:pose.time,yaw:0.7,elevation:0.25}});
   const metadata=JSON.parse(r.content.find(c=>c.type==='text').text),image=r.content.find(c=>c.type==='image');assert(image&&image.mimeType==='image/png');assert.equal(metadata.asset.scale,1);assert.equal(metadata.asset.bones.length,boneCount);
   metadata.asset.meters.forEach((n,i)=>assert(Math.abs(n-result.animation.actors[0].expectedMeters[i])<0.001,'delivered meter bounds'));
   const rootIndex=metadata.asset.bones.findIndex(b=>b.name==='root'),root=metadata.asset.bones[rootIndex];assert(root&&Math.abs(root.rotation[3])>0.99999&&root.translationMeters.every(n=>Math.abs(n)<0.0001));
   const phase=2*Math.PI*pose.time/(pose.id===0?0.999:2),feet=[];
   for(const leg of result.legs){
    const bone=metadata.asset.bones.find(b=>b.name===leg.name);assert(bone&&bone.parentIndex===rootIndex);
    const expected=result.clips.bones.find(b=>b.name===leg.name);bone.pivotMeters.forEach((n,i)=>assert(Math.abs(n-expected.pivotMeters[i])<0.0001));
    const swing=pose.id===0?0:Math.sin(phase)*leg.phase,angle=swing*12*Math.PI/180;
    assert(Math.abs(bone.rotation[0]*Math.sin(angle/2)+bone.rotation[3]*Math.cos(angle/2))>0.99999,'native leg angle');
    const ys=[];for(const x of [leg.x-1,leg.x+2])for(const y of [0,1])for(const z of [leg.minZ,leg.maxZ]){
     const p=[x*0.5/32,y/32,(z-14)/32],relative=p.map((n,i)=>n-bone.pivotMeters[i]),moved=rotate(bone.rotation,relative);
     ys.push(moved[1]+bone.pivotMeters[1]+bone.translationMeters[1]);
    }
    const minY=Math.min(...ys);assert(minY>=-0.0001,'foot below floor: '+JSON.stringify({pose,leg:leg.name,minY}));feet.push({name:leg.name,minY});
   }
   const tail=metadata.asset.bones.find(b=>b.name==='tail'),yaw=Math.sin(phase)*(pose.id===0?20:12)*Math.PI/180;
   assert(tail.parentIndex===rootIndex&&Math.abs(tail.rotation[1]*Math.sin(yaw/2)+tail.rotation[3]*Math.cos(yaw/2))>0.99999,'native tail angle');
   if(result.headLook){
    const head=metadata.asset.bones.find(b=>b.name==='head'),headYaw=pose.id===0?Math.sin(phase)*25*Math.PI/180:0;
    assert(head&&head.parentIndex===rootIndex,'head parent');
    const expected=result.clips.bones.find(b=>b.name==='head');head.pivotMeters.forEach((n,i)=>assert(Math.abs(n-expected.pivotMeters[i])<0.0001));
    assert(Math.abs(head.rotation[1]*Math.sin(headYaw/2)+head.rotation[3]*Math.cos(headYaw/2))>0.99999,'independent head pose');
    assert(head.translationMeters.every(n=>Math.abs(n)<0.0001),'head unexpectedly translated');
   }
   const file=path.join(out,`id${pose.id}-${pose.time}${pose.repeat?'-repeat'+pose.repeat:''}.png`);fs.writeFileSync(file,Buffer.from(image.data,'base64'));images.push({file,metadata});checks.push({pose,feet});
  }
  assert(checks.some(c=>c.feet.some(f=>f.minY>0.01)),'No visible swing-foot lift');
  const begin=images.find(i=>i.metadata.asset.animId===1&&i.metadata.asset.timeSeconds===0).metadata.asset.bones,end=images.find(i=>i.metadata.asset.animId===1&&i.metadata.asset.timeSeconds===2).metadata.asset.bones;
  for(const b of begin){const e=end.find(n=>n.name===b.name);assert(Math.abs(e.rotation.reduce((s,n,i)=>s+n*b.rotation[i],0))>0.999999);e.translationMeters.forEach((n,i)=>assert(Math.abs(n-b.translationMeters[i])<0.0001));}
  const idleBegin=images.find(i=>i.metadata.asset.animId===0&&i.metadata.asset.timeSeconds===0).metadata.asset.bones,idleEnd=images.find(i=>i.metadata.asset.animId===0&&i.metadata.asset.timeSeconds===0.999).metadata.asset.bones;
  for(const b of idleBegin){const e=idleEnd.find(n=>n.name===b.name);assert(Math.abs(e.rotation.reduce((s,n,i)=>s+n*b.rotation[i],0))>0.999999,'idle loop did not close');e.translationMeters.forEach((n,i)=>assert(Math.abs(n-b.translationMeters[i])<0.0001));}
  const after=(await native('run_npl_code',{code:snapshot})).result,viewAfter=await view();assert.deepEqual(after,before);assert.deepEqual(viewAfter.player,viewBefore.player);assert.deepEqual(viewAfter.camera,viewBefore.camera);
  const cleanup=(await native('run_npl_code',{code:`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(not C.AssetCapture.pending);for _,name in ipairs({${images.map(i=>JSON.stringify(i.metadata.captureId)).join(',')}})do assert(not CommonCtrl.GetControl(name))end;return {cleaned=${images.length}};`})).result;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,result,images,checks,before,after,cleanup,playerUnchanged:true,cameraUnchanged:true},null,2));console.log(`PASS independent ${boneCount}-bone quadruped: idle/trot IDs, seventeen PNGs, foot clearance, loop closure, source and camera preserved`);
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
