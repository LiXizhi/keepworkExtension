const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
// Explicit disposable world fence; reusable for every template iteration.
const [portArg,worldPath,templateArg,outArg,mode]=process.argv.slice(2);
const port=Number(portArg);
assert(port>=8099&&port<=8115&&worldPath&&templateArg&&outArg,
 'Usage: node scripts/paracraft-template-native.cjs PORT EXACT_DISPOSABLE_WORLD TEMPLATE OUTPUT_DIRECTORY');
const out=path.resolve(outArg);
const saveSource=!process.argv.includes('--no-save');
const calls={};
function rotationAt(keys,time){
 assert(keys.length>=2&&time>=keys[0].time&&time<=keys.at(-1).time);
 let j=1;while(j<keys.length-1&&keys[j].time<time)j++;
 const a=keys[j-1],b=keys[j],t=(time-a.time)/(b.time-a.time);
 let end=b.rotation,cos=a.rotation.reduce((sum,n,i)=>sum+n*end[i],0);
 if(cos<0){cos=-cos;end=end.map(n=>-n);}
 if(cos>0.9995){const q=a.rotation.map((n,i)=>n*(1-t)+end[i]*t);const length=Math.hypot(...q);return q.map(n=>n/length);}
 const angle=Math.acos(Math.min(1,cos)),den=Math.sin(angle);
 return a.rotation.map((n,i)=>(n*Math.sin((1-t)*angle)+end[i]*Math.sin(t*angle))/den);
}
function rotateVector(q,v){
 const [x,y,z,w]=q,[a,b,c]=v;
 const tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);
 return [a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];
}
async function cli(action,params={}) {
 calls[action]=(calls[action]||0)+1;
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/ajax/paracraft_cli',method:'POST',
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
   });req.setTimeout(30000,()=>req.destroy(new Error('transport timeout: recover job, do not rerun')));
   req.on('error',reject);req.end(body);
 });assert.notEqual(reply.ok,false,JSON.stringify(reply));
 const result=reply.result||reply;assert.notEqual(result.ok,false,JSON.stringify(result));return result;
}
(async()=>{
 const cap=await cli('get_creation_capabilities');const identity=cap.identity;
 assert.equal(identity.worldPath,worldPath,'Wrong world: refusing to write');
 const previous=mode==='--capture-existing'?JSON.parse(fs.readFileSync(path.join(out,'job.json'),'utf8')):null;
 const revision=mode?.startsWith('--revise-existing=')?JSON.parse(fs.readFileSync(path.resolve(mode.slice('--revise-existing='.length)),'utf8')):null;
 if(previous)assert.deepEqual(previous.identity,identity,'Saved capture belongs to another world session');
 if(revision)assert.deepEqual(revision.identity,identity,'Revision belongs to another world session');
 // One sequential authoring chat keeps its pet; requests/scenes remain unique.
 const saved=previous||revision;
 const session=saved?saved.session:'rsi-validation-'+identity.sessionId;
 const sceneName=saved?(saved.sceneName||saved.session):'rsi-'+Date.now();
 const requestId=revision?'revision-'+Date.now():sceneName;
 const original=fs.readFileSync(templateArg,'utf8');
 const named=original.replace(/(createScene\(\{name=")[\w-]+(")/,(_,start,end)=>start+sceneName+end);
 const code=saveSource?named.replace('local info=s:inspect();','s:save();local info=s:inspect();'):named;
 assert.notEqual(code,original,'Test harness requires unique name and explicit test save');
 fs.mkdirSync(out,{recursive:true});
 if(!previous)fs.writeFileSync(path.join(out,'request.json'),JSON.stringify({identity,session,requestId,sceneName,template:templateArg,resumed:!!revision,saveSource},null,2));
 const scoped={expectedIdentity:identity,authoringSession:session};
 const before=await cli('get_scene_info');
 const started=Date.now();
 let job=previous?await cli('code_job',{...scoped,jobId:previous.jobId}):await cli('run_code',{...scoped,requestId,code});
 fs.writeFileSync(path.join(out,'job.json'),JSON.stringify({identity,session,sceneName,jobId:job.jobId},null,2));
 const deadline=Date.now()+125000;
 while(job.state==='running'&&Date.now()<deadline){
  await new Promise(r=>setTimeout(r,500));job=await cli('code_job',{...scoped,jobId:job.jobId});
 }
 assert.equal(job.state,'completed',job.error||JSON.stringify(job));
 assert.equal(job.result.name,sceneName);
 for(const g of Object.values(job.result.groups)){assert(g.cells>0);assert.equal(g.stale,0);}
 const creationMs=Date.now()-started;const captureStarted=Date.now();
 const captureBefore=await cli('get_scene_info');
 assert(/^[\w-]+$/.test(sceneName));
 const snapshotCode=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.worldPath==${JSON.stringify(worldPath)} and w.identity.sessionId==${identity.sessionId},"world session changed");local function read(name) local f=ParaIO.open(w.identity.worldPath.."creation/${sceneName}/"..name,"r");assert(f:IsValid(),"missing saved scene");local text=f:GetText(0,-1);f:close();return text end;local manifest=read("manifest.json");local d=commonlib.Json.Decode(manifest);local signatures={};local stale=0;for key,member in pairs(d.cells) do local actual=w:Fingerprint(w:Snapshot(member.position));signatures[#signatures+1]=key.."="..actual;if actual~=member.fingerprint then stale=stale+1 end end;table.sort(signatures);return {members=ParaMisc.md5(table.concat(signatures,"\\n")),manifest=ParaMisc.md5(manifest),source=ParaMisc.md5(read("source.lua")),stale=stale}`;
 const persistedBefore=(await cli('run_npl_code',{code:snapshotCode})).result;
 assert.equal(persistedBefore.stale,0,'Saved scene differs before captures');
 const images=[];
 for(const view of ['overview','detail','portrait','side'].filter(view=>job.result[view])){
  const capture=await cli('camera_capture',{...scoped,...job.result[view]});
  assert(capture.base64&&!capture.cached);assert.equal(capture.sessionId,identity.sessionId);
  const file=path.join(out,view+'.jpg');fs.writeFileSync(file,Buffer.from(capture.base64,'base64'));
  images.push({view,file,cameraPos:capture.cameraPos,sessionId:capture.sessionId,timestamp:capture.timestamp});
 }
 if(job.result.animation){
  for(const timeSeconds of job.result.animation.times){
   const poseView=job.result.portrait?'portrait':'detail';
   const capture=await cli('camera_capture',{...scoped,...job.result[poseView],
    moviePosition:job.result.animation.moviePosition,timeSeconds});
   assert(capture.base64&&!capture.cached);assert.equal(capture.sessionId,identity.sessionId);
   const file=path.join(out,'pose-'+timeSeconds+'.jpg');
   fs.writeFileSync(file,Buffer.from(capture.base64,'base64'));
   images.push({view:poseView,timeSeconds,file,cameraPos:capture.cameraPos,sessionId:capture.sessionId,timestamp:capture.timestamp});
   const anim=job.result.animation;
   if(anim.actor&&anim.expectedMeters){
    assert(/^[\w_]+$/.test(anim.actor));
    const audit=await cli('run_npl_code',{code:`local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local T=commonlib.gettable("MyCompany.Aries.Game.block_types");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local e=E.GetBlockEntity(${anim.moviePosition.join(',')});local clip=e:GetMovieClip();for slot=1,e.inventory:GetSlotCount() do local item=e.inventory:GetItem(slot);if item and item.id==T.names.TimeSeriesNPC then local a=clip:GetActorFromItemStack(item,true);if a:GetValue("name",0)=="${anim.actor}" then local obj=a:GetEntity():GetInnerObject();local b=obj:GetPrimaryAsset():GetBoundingBox({});local pos={obj:GetPosition()};local expected={a:GetValue("x",${timeSeconds*1000}),a:GetValue("y",${timeSeconds*1000}),a:GetValue("z",${timeSeconds*1000})};for i=1,3 do assert(math.abs(pos[i]-expected[i])<0.0001,"pose position mismatch") end;return {time=clip:GetTime(),position=pos,meters={(b.max_x-b.min_x)/B.blocksize,(b.max_y-b.min_y)/B.blocksize,(b.max_z-b.min_z)/B.blocksize},scale=a:GetEntity():GetScaling()} end end end;error("missing animal actor")`});
    assert.equal(audit.result.time,timeSeconds*1000);
    assert.equal(audit.result.scale,1);
    audit.result.meters.forEach((n,i)=>assert(Math.abs(n-anim.expectedMeters[i])<0.001,'export scale mismatch'));
    images.at(-1).pose=audit.result;
    if(anim.motion==='bone'){
     assert(/^[\w_]+$/.test(anim.bone)&&Array.isArray(anim.rotationAxis),'Bone audit requires bone and rotationAxis');
     const boneAudit=await cli('run_npl_code',{code:`local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local T=commonlib.gettable("MyCompany.Aries.Game.block_types");local e=E.GetBlockEntity(${anim.moviePosition.join(',')});local clip=e:GetMovieClip();for slot=1,e.inventory:GetSlotCount() do local item=e.inventory:GetItem(slot);if item and item.id==T.names.TimeSeriesNPC then local a=clip:GetActorFromItemStack(item,true);if a:GetValue("name",0)=="${anim.actor}" then local bones=a:GetBonesVariable();local b=bones:GetChild("${anim.bone}");assert(b,"missing bone");bones:UpdateAnimInstance();return {rotation=b:GetRotation(true),keys=b:GetRotationVar():GetKeyNum()} end end end;error("missing bone actor")`});
     const halfAngle=Math.PI*anim.turns*timeSeconds/anim.times.at(-1);
     const expected=[...anim.rotationAxis.map(n=>n*Math.sin(halfAngle)),Math.cos(halfAngle)];
     const actual=boneAudit.result.rotation;
     assert.equal(actual.length,4);assert(boneAudit.result.keys>=3,'missing native bone keys');
     assert(Math.abs(actual.reduce((sum,n,i)=>sum+n*expected[i],0))>0.9999,'Native bone pose differs from requested rotation');
     images.at(-1).pose.bone=boneAudit.result;
    }
   }
   if(anim.actors){
    const wanted=anim.actors.map(a=>{
     assert(/^[\w_]+$/.test(a.name)&&(!a.bone||/^[\w_]+$/.test(a.bone)));
     return `["${a.name}"]={${a.bone?`bone="${a.bone}"`:''}}`;
    }).join(',');
    const auditCode=`local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local T=commonlib.gettable("MyCompany.Aries.Game.block_types");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local G=commonlib.gettable("MyCompany.Aries.Game.Code.Creation.Geometry");local e=E.GetBlockEntity(${anim.moviePosition.join(',')});local c=e:GetMovieClip();local wanted={${wanted}};local result={ready=true,time=c:GetTime(),actors={}};for i=1,e.inventory:GetSlotCount() do local item=e.inventory:GetItem(i);if item and item.id==T.names.TimeSeriesNPC then local a=c:GetActorFromItemStack(item,true);local name=a:GetValue("name",0);local spec=wanted[name];if spec then local obj=a:GetEntity():GetInnerObject();local b=obj:GetPrimaryAsset():GetBoundingBox({});if not obj:GetPrimaryAsset():IsLoaded() or not G.ModelBoundsValid(b) then return {ready=false,actor=name} end;local p={obj:GetPosition()};local expected={a:GetValue("x",${timeSeconds*1000}),a:GetValue("y",${timeSeconds*1000}),a:GetValue("z",${timeSeconds*1000})};for k=1,3 do assert(math.abs(p[k]-expected[k])<0.0001,"actor joint position mismatch") end;local r={position=p,scale=a:GetEntity():GetScaling(),meters={(b.max_x-b.min_x)/B.blocksize,(b.max_y-b.min_y)/B.blocksize,(b.max_z-b.min_z)/B.blocksize}};if spec.bone then local inst=obj:GetAttributeObject():GetChildAt(1,1);assert(inst and inst:IsValid(),"missing native animation instance");inst:CallField("UpdateModel");for index=0,inst:GetChildCount(1)-1 do local bone=inst:GetChildAt(index,1);if bone:GetField("name","")==spec.bone then r.rotation=bone:GetField("FinalRot",{0,0,0,1});break end end;assert(r.rotation,"missing native bone");local tracks=a:GetTimeSeries():GetChild("bones");local track=tracks and tracks:GetVariable(spec.bone.."_rot");r.keys=track and track:GetKeyNum() or 0 end;result.actors[name]=r end end end;return result`;
    let audit;const readyDeadline=Date.now()+5000;
    do {
     audit=await cli('run_npl_code',{code:auditCode});
     if(audit.result.ready)break;
     await new Promise(r=>setTimeout(r,100));
    }while(Date.now()<readyDeadline);
    assert(audit.result.ready,'Actor geometry unavailable after capture: '+audit.result.actor);
    assert.equal(audit.result.time,timeSeconds*1000);
    for(const spec of anim.actors){
     const actual=audit.result.actors[spec.name];assert(actual,'Missing articulated actor '+spec.name);
     assert.equal(actual.scale,1);actual.meters.forEach((n,i)=>assert(Math.abs(n-spec.expectedMeters[i])<0.001,'part meter scale mismatch'));
     if(spec.bone){
      assert.equal(actual.keys,spec.embedded?0:spec.rotationKeys.length,spec.embedded?'Independent asset has external bone keys':'bone keys not persisted');
      const expected=rotationAt(spec.rotationKeys,timeSeconds);
      assert(Math.abs(actual.rotation.reduce((sum,n,i)=>sum+n*expected[i],0))>0.9999,`Articulated bone pose mismatch: ${spec.name} at ${timeSeconds}s, actual=${actual.rotation}, expected=${expected}`);
     }
    }
    for(const joint of anim.joints||[]){
     assert(Number.isFinite(job.result.blocksize)&&job.result.blocksize>0,'Missing native meter conversion');
     const child=audit.result.actors[joint.actor],parent=audit.result.actors[joint.parent];
     assert(child&&parent,'Missing actor at attachment');
     const offset=joint.rotateWithParent?rotateVector(parent.rotation,joint.offset):joint.offset;
     const tolerance=joint.toleranceMeters||0.0001;
     assert(tolerance>0&&tolerance<=0.001,'Attachment tolerance exceeds 1 mm');
     offset.forEach((n,i)=>assert(Math.abs((child.position[i]-parent.position[i])/job.result.blocksize-n)<tolerance,'Detached moving joint: '+joint.actor));
    }
    images.at(-1).articulatedPose=audit.result;
   }
  }
 }
 const poses=images.filter(i=>i.pose).map(i=>i.pose);
 if(poses.length>1 && !['bone','articulated'].includes(job.result.animation.motion)){
  assert(poses.some(p=>Math.abs(p.position[1]-poses[0].position[1])>0.01),'Animation did not move');
  poses[0].position.forEach((n,i)=>assert(Math.abs(n-poses.at(-1).position[i])<0.0001,'Loop endpoints differ'));
 }
 let rolling;
 if(job.result.animation?.wheelRadiusMeters){
  const anim=job.result.animation,frames=images.filter(i=>i.articulatedPose);
  const first=frames[0],last=frames.at(-1),body0=first.articulatedPose.actors.body.position;
  const distance=2*Math.PI*anim.wheelRadiusMeters;
  assert(Math.abs(distance-anim.travelMeters)<0.0001,'Wheel circumference differs from travel');
  for(const frame of frames){
   const p=frame.articulatedPose.actors.body.position;
   assert(Math.abs(p[0]-body0[0])<0.0001&&Math.abs(p[1]-body0[1])<0.0001,'Straight drive drifted sideways or vertically');
   const actual=(body0[2]-p[2])/job.result.blocksize;
   const travelEnd=anim.travelEndSeconds||last.timeSeconds;
   const expected=distance*Math.min(1,(frame.timeSeconds-first.timeSeconds)/(travelEnd-first.timeSeconds));
   assert(Math.abs(actual-expected)<0.0001,'Wheel rotation and traveled distance differ');
  }
  rolling={radiusMeters:anim.wheelRadiusMeters,travelMeters:(body0[2]-last.articulatedPose.actors.body.position[2])/job.result.blocksize,frames:frames.length};
  if(anim.steering){
   for(const name of anim.steering.actors){
    const post=frames.filter(frame=>frame.timeSeconds>anim.steering.startSeconds);
    assert(post.some(frame=>frame.articulatedPose.actors[name].rotation[1]>0.1),'Front wheel did not steer left');
    assert(post.some(frame=>frame.articulatedPose.actors[name].rotation[1]<-0.1),'Front wheel did not steer right');
    assert(Math.abs(post.at(-1).articulatedPose.actors[name].rotation[1])<0.0001,'Front wheel failed to straighten');
   }
   rolling.steeringVerified=true;
  }
 }
 const after=await cli('get_scene_info');assert.deepEqual(after.player.position,before.player.position);
 assert.deepEqual(after.player.position,captureBefore.player.position);assert.deepEqual(after.camera,captureBefore.camera);
 const persistedAfter=(await cli('run_npl_code',{code:snapshotCode})).result;
 assert.deepEqual(persistedAfter,persistedBefore,'Capture/audit changed native scene data, manifest or generator');
 const log=await cli('tail_log',{lines:10});
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,captureOnly:!!previous,template:templateArg,result:job.result,
  performance:{creationMs,captureMs:Date.now()-captureStarted,calls,authoringSession:session,pollIntervalMs:500},
  images,rolling,persistedBefore,persistedAfter,playerPositionUnchanged:true,playerFacingUnchanged:after.player.facing===captureBefore.player.facing,cameraUnchanged:true,log},null,2));
 console.log(previous?'PASS native existing-job captures and optional numeric pose/scale checks':'PASS native template: auto site, nonempty/stale-free groups, fresh views, stationary player/main camera');
 console.log(out);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
