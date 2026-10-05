const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [reportArg,outArg,mode]=process.argv.slice(2);assert(reportArg&&outArg,'Usage: node scripts/paracraft-assembly-mcp-native.cjs NATIVE_TEMPLATE_REPORT OUTPUT [--auto-fit]');
const saved=JSON.parse(fs.readFileSync(reportArg,'utf8')),identity=saved.identity,out=path.resolve(outArg);
assert(Number.isFinite(saved.result.blocksize)&&saved.result.blocksize>0,'Native report lacks positive blocksize; repair metadata before assembly audit');
assert(/^[\w-]+$/.test(saved.result.name));fs.mkdirSync(out,{recursive:true});
const evidence={identity,reviewId:require('node:crypto').randomUUID(),state:'starting',verified:false,images:[],startedAt:new Date().toISOString()};
function checkpoint(update={}){
 Object.assign(evidence,update);
 const file=path.join(out,'capture-progress.json'),temporary=file+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify(evidence,null,2));fs.renameSync(temporary,file);
}
checkpoint();
async function nativeSnapshot(code){
 const body=JSON.stringify({v:1,action:'run_npl_code',params:{code}});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native audit timeout')));req.end(body);
 });assert(reply.ok&&reply.result.ok,JSON.stringify(reply));return reply.result.result;
}
(async()=>{
 const client=new Client({name:'assembly-native-acceptance',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const raw=async(action,params={})=>{
  const reply=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId:saved.performance.authoringSession,params}});
  assert(!reply.isError,reply.content.find(c=>c.type==='text')?.text);return reply;
 };
 const call=async(action,params)=>JSON.parse((await raw(action,params)).content.find(c=>c.type==='text').text);
 try{
  assert.deepEqual((await client.listTools()).tools.filter(t=>t.name.startsWith('paracraft_')).map(t=>t.name),['paracraft_cli']);
  const cap=await call('get_creation_capabilities');assert.deepEqual(cap.result.identity,identity);assert(cap.result.isolatedAssemblyCapture);
  const snapshot=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.worldPath==${JSON.stringify(identity.worldPath)} and w.identity.sessionId==${identity.sessionId});local root=w.identity.worldPath.."creation/${saved.result.name}/";local function read(name) local f=ParaIO.open(root..name,"r");assert(f:IsValid());local t=f:GetText(0,-1);f:close();return t end;local text=read("manifest.json");local d=commonlib.Json.Decode(text);local signatures={};for key,m in pairs(d.cells) do local actual=w:Fingerprint(w:Snapshot(m.position));assert(actual==m.fingerprint,"stale native member");signatures[#signatures+1]=key.."="..actual end;table.sort(signatures);return {members=ParaMisc.md5(table.concat(signatures,"\\n")),manifest=ParaMisc.md5(text),source=ParaMisc.md5(read("source.lua"))}`;
  const before=await nativeSnapshot(snapshot);
  const viewBefore=(await call('get_scene_info')).result;
  const images=evidence.images,started=Date.now();
  checkpoint({state:'capturing',before,playerBefore:viewBefore.player,cameraBefore:viewBefore.camera});
  const rejected=await client.callTool({name:'paracraft_cli',arguments:{action:'camera_capture',clientId:identity.clientId,chatSessionId:saved.performance.authoringSession,params:{expectedIdentity:identity,assembly:{moviePosition:saved.result.animation.moviePosition,timeSeconds:1.25,actors:['missing_part']}}}});
  assert(rejected.isError,'Missing named actor did not reject');
  const animation=saved.result.animation,times=animation.times,baseName=animation.actors[0].name;
  const repeated=times.includes(1.25)?1.25:times[Math.floor(times.length/2)];
  const poseTimes=animation.actors.some(a=>a.name==='front_left')?[...times,repeated,repeated]:[times[0],times[1],times[2],repeated,times.at(-2),times.at(-1),repeated,repeated];
  for(const time of poseTimes){
   const reply=await raw('camera_capture',{expectedIdentity:identity,assembly:{moviePosition:animation.moviePosition,timeSeconds:time,yaw:0.65,elevation:0.2,...(mode==="--auto-fit"?{}:{distanceMeters:baseName==='hull'?10:baseName==='airframe'?18:8}),size:512}});
   const pixels=reply.content.find(c=>c.type==='image'),metadata=JSON.parse(reply.content.find(c=>c.type==='text').text);
   assert(pixels&&pixels.mimeType==='image/png'&&metadata.isolated);assert.equal(metadata.base64,undefined);assert.equal(metadata.sessionId,identity.sessionId);
   const file=path.join(out,'assembly-'+images.length+'-'+time+'.png');
   fs.writeFileSync(file,Buffer.from(pixels.data,'base64'));
   const frame={file,timeSeconds:time,metadata,poseVerified:false};images.push(frame);checkpoint();
   assert.equal(metadata.assembly.actors.length,animation.actors.length);assert.equal(metadata.assembly.timeSeconds,time);
   const expected=saved.images.find(frame=>frame.timeSeconds===time).articulatedPose.actors;
   for(const actor of metadata.assembly.actors){
    assert.equal(actor.scale,1);const native=expected[actor.name];assert(native);
    actor.positionMeters.forEach((n,i)=>assert(Math.abs(n-(native.position[i]-expected[baseName].position[i])/saved.result.blocksize)<0.0001,'Clone attachment drift'));
    metadata.assembly.originWorld.forEach((n,i)=>assert(Math.abs(n-expected[baseName].position[i])<0.0001,'Wrong pose anchor'));
    if(native.rotation){const boneName=animation.actors.find(a=>a.name===actor.name).bone;const bone=actor.bones.find(b=>b.name===boneName);assert(bone);assert(Math.abs(bone.rotation.reduce((s,n,i)=>s+n*native.rotation[i],0))>0.9999,'Clone bone differs from independently audited native pose');}
   }
   frame.poseVerified=true;checkpoint();
  }
  const after=await nativeSnapshot(snapshot);assert.deepEqual(after,before);
  if(mode==='--auto-fit'){
   for(const frame of images){
    assert.deepEqual(frame.metadata.cameraPos,images[0].metadata.cameraPos,'Auto camera drifted during animation');
    const parts=frame.metadata.assembly.actors;
    for(const spec of animation.actors){
     const part=parts.find(p=>p.name===spec.name);
     const kind=part.bones.length>1?'rest_sphere':spec.rotationKeys?.length>1?'rotation_envelope':'rigid_pose';
     assert.equal(parts.find(p=>p.name===spec.name).framingKind,kind);
    }
   }
  }
  const names=images.map(frame=>JSON.stringify(frame.metadata.captureId)).join(',');
  const cleanup=await nativeSnapshot(`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(not C.AssemblyCapture.pending and not C.Capture.pending);local names={${names}};for _,name in ipairs(names) do assert(not CommonCtrl.GetControl(name),"leaked canvas control");assert(not ParaUI.GetUIObject(name):IsValid(),"leaked canvas UI") end;return {removed=#names}`);
  const viewAfter=(await call('get_scene_info')).result;
  assert.deepEqual((await call('get_creation_capabilities')).result.identity,identity);
  assert.deepEqual(viewAfter.player,viewBefore.player);assert.deepEqual(viewAfter.camera,viewBefore.camera);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,reviewId:evidence.reviewId,images,before,after,cleanup,missingActorRejected:true,elapsedMs:Date.now()-started,playerUnchanged:true,cameraUnchanged:true},null,2));
  checkpoint({state:'completed',verified:true,after,cleanup,elapsedMs:Date.now()-started,playerUnchanged:true,cameraUnchanged:true});
  console.log(`PASS isolated assembly MCP: ${images.length} PNGs, all template parts/poses, fixed source/player/camera`);
 }finally{await client.close();}
})().catch(e=>{checkpoint({state:'failed',verified:false,error:String(e.message).slice(0,4096)});console.error(e.message);process.exitCode=1;});
