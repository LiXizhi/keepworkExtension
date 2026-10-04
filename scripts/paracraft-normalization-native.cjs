const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [worldPath,outArg,existingJobArg]=process.argv.slice(2);assert(worldPath?.includes('/CreationAcceptance')&&outArg,'Usage: node scripts/paracraft-normalization-native.cjs EXACT_DISPOSABLE_WORLD OUTPUT [EXISTING_JOB_JSON]');
const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const r=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
  let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
 });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native read timeout')));req.end(body);});assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result;
}
(async()=>{
 const identity=(await native('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);
 const reload=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(C.World.Identity().worldPath==${JSON.stringify(worldPath)} and C.World.Identity().sessionId==${identity.sessionId});assert(not C.AssetCapture.pending);NPL.load("(gl)script/apps/Aries/Creator/Game/Code/Creation/VoxelExport.lua",true);NPL.load("(gl)script/apps/Aries/Creator/Game/Code/Creation/AssetCapture.lua",true);NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/CreationClipRegression.lua",true);return commonlib.gettable("MyCompany.Aries.Game.ParacraftCLI.CreationClipRegression").Run();`;
 const regression=(await native('run_npl_code',{code:reload})).result;
 const client=new Client({name:'normalization-native-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const existing=existingJobArg?JSON.parse(fs.readFileSync(existingJobArg,'utf8')):null;
 if(existing)assert.deepEqual(existing.identity,identity,'Existing job belongs to another world session');
 const session='rsi-template-native',requestId='normalization-'+Date.now(),sceneName=existing?existing.sceneName:'rsi_normalized_'+Date.now();
 const raw=async(action,params={})=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId:session,params}});assert(!r.isError,r.content.find(c=>c.type==='text')?.text);return r;};
 const call=async(action,params)=>JSON.parse((await raw(action,params)).content.find(c=>c.type==='text').text).result;
 try{
  let code=fs.readFileSync('skills/paracraft-create/examples/mini-character.lua','utf8').replace('name="mini_character"',`name="${sceneName}"`);
  code=code.replace('local clipsFile=',`for _,k in ipairs({{0,0},{0.5,0.125},{1,0},{1.5,0.125},{2,0.0625},{2.5,0.125},{3,0}})do s:keyframe("wave","character",k[1],{bones={root={translation={0,k[2],0}}}})end\nlocal clipsFile=`);
  code=code.replace('animation={movie="wave"','scale=0.25,animation={movie="wave"').replace('expectedMeters={1.125,1.75,0.4375}','expectedMeters={0.28125,0.4375,0.109375}');
  code=code.replace('local info=s:inspect();','s:save();local info=s:inspect();');
  const params={expectedIdentity:identity,requestId,code};if(!existing)fs.writeFileSync(path.join(out,'request.json'),JSON.stringify({identity,session,...params},null,2));
  let job=existing?await call('code_job',{expectedIdentity:identity,jobId:existing.jobId,resultDetail:'full'}):await call('run_code',params);
  fs.writeFileSync(path.join(out,'job.json'),JSON.stringify({identity,session,sceneName,jobId:job.jobId},null,2));
  const until=Date.now()+125000;while(job.state==='running'&&Date.now()<until){await new Promise(r=>setTimeout(r,500));job=await call('code_job',{expectedIdentity:identity,jobId:job.jobId,resultDetail:'full'});}
  assert.equal(job.state,'completed',job.error);assert.equal(job.result.clips.bakedScale,0.25);const result=job.result;
  for(const bone of result.clips.bones){const original=result.exported.bones.find(b=>b.name===bone.name);assert(original);assert.equal(bone.parent,original.parent);bone.pivotMeters.forEach((n,i)=>assert(Math.abs(n-original.pivotMeters[i]*0.25)<0.00001));}
  const sourceHash=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.sessionId==${identity.sessionId});local root=w.identity.worldPath.."creation/${sceneName}/";local function read(file)local f=ParaIO.open(root..file,"r");assert(f:IsValid());local t=f:GetText(0,-1);f:close();return t end;local manifest=read("manifest.json");local d=commonlib.Json.Decode(manifest);local members={};for k,m in pairs(d.cells)do local actual=w:Fingerprint(w:Snapshot(m.position));assert(actual==m.fingerprint,"stale source");members[#members+1]=k.."="..actual end;table.sort(members);return {source=ParaMisc.md5(read("source.lua")),manifest=ParaMisc.md5(manifest),members=ParaMisc.md5(table.concat(members,"\\n"))};`;
  const before=(await native('run_npl_code',{code:sourceHash})).result,viewBefore=await call('get_scene_info'),images=[];
  const originalReply=await raw('camera_capture',{expectedIdentity:identity,asset:{filename:result.exported.filename,animId:0,timeSeconds:0}});
  const originalMetadata=JSON.parse(originalReply.content.find(c=>c.type==='text').text),originalImage=originalReply.content.find(c=>c.type==='image');assert(originalImage);
  originalMetadata.asset.meters.forEach((n,i)=>assert(Math.abs(n*0.25-result.animation.actors[0].expectedMeters[i])<0.001,'source-to-normalized dimension ratio'));
  for(const expected of result.exported.bones){const bone=originalMetadata.asset.bones.find(b=>b.name===expected.name);assert(bone);bone.pivotMeters.forEach((n,i)=>assert(Math.abs(n-expected.pivotMeters[i])<0.0001,'original native pivot'));}
  const originalFile=path.join(out,'original-rig.png');fs.writeFileSync(originalFile,Buffer.from(originalImage.data,'base64'));images.push({file:originalFile,metadata:originalMetadata});
  const cases=[{id:0,time:0,lift:0},{id:0,time:0.5,lift:0.125},{id:1,time:0,lift:0},{id:1,time:0.5,lift:0.125},{id:1,time:1,lift:0.0625},{id:1,time:1.5,lift:0.125},{id:1,time:2,lift:0},{id:1,time:0.5,lift:0.125,repeat:1},{id:1,time:0.5,lift:0.125,repeat:2}];
  for(const pose of cases){
   const r=await raw('camera_capture',{expectedIdentity:identity,asset:{filename:result.clips.filename,animId:pose.id,timeSeconds:pose.time}});
   const metadata=JSON.parse(r.content.find(c=>c.type==='text').text),image=r.content.find(c=>c.type==='image');assert(image&&image.mimeType==='image/png');assert.equal(metadata.asset.scale,1);
   metadata.asset.meters.forEach((n,i)=>assert(Math.abs(n-result.animation.actors[0].expectedMeters[i])<0.001,'normalized geometry size'));
   for(const expected of result.clips.bones){const bone=metadata.asset.bones.find(b=>b.name===expected.name);assert(bone);bone.pivotMeters.forEach((n,i)=>assert(Math.abs(n-expected.pivotMeters[i])<0.0001,'normalized native pivot'));}
   const root=metadata.asset.bones.find(b=>b.name==='root');assert(Math.abs(root.translationMeters[1]-pose.lift*0.25)<0.0001,'normalized native translation: '+JSON.stringify({pose,root}));
   const arm=metadata.asset.bones.find(b=>b.name==='right_arm'),globalTime=pose.time+(pose.id===1?1:0),expected=result.animation.actors[0].rotationKeys.find(k=>Math.abs(k.time-globalTime)<0.0001).rotation;
   assert(Math.abs(arm.rotation.reduce((sum,n,i)=>sum+n*expected[i],0))>0.9999,'rotation changed while normalizing');
   const file=path.join(out,`id${pose.id}-${pose.time}${pose.repeat?'-repeat'+pose.repeat:''}.png`);fs.writeFileSync(file,Buffer.from(image.data,'base64'));images.push({file,metadata});
  }
  const after=(await native('run_npl_code',{code:sourceHash})).result,viewAfter=await call('get_scene_info');assert.deepEqual(after,before);assert.deepEqual(viewAfter.player,viewBefore.player);assert.deepEqual(viewAfter.camera,viewBefore.camera);
  const cleanup=(await native('run_npl_code',{code:`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(not C.AssetCapture.pending);for _,name in ipairs({${images.map(i=>JSON.stringify(i.metadata.captureId)).join(',')}})do assert(not CommonCtrl.GetControl(name),"capture control leaked")end;return {cleaned=${images.length}};`})).result;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,regression,result,images,before,after,cleanup,playerUnchanged:true,cameraUnchanged:true},null,2));console.log('PASS normalized geometry, native bone pivots/translations and rotations, two independent clip IDs and unchanged source/player/camera');
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
