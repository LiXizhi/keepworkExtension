// Independently reload a completed static color-voxel prop at scale 1.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [arg,outArg,elevationArg,distanceArg,mode]=process.argv.slice(2);assert(arg&&outArg);assert(mode===undefined||mode==='asset-only');const elevation=elevationArg===undefined?0.2:Number(elevationArg);assert(Number.isFinite(elevation)&&Math.abs(elevation)<=1.4);const distance=distanceArg===undefined||distanceArg==='auto'?{}:{distanceMeters:Number(distanceArg)};assert(!Object.keys(distance).length||(Number.isFinite(distance.distanceMeters)&&distance.distanceMeters>=0.01&&distance.distanceMeters<=1000));const job=JSON.parse(fs.readFileSync(arg)),out=path.resolve(outArg);assert(job.state==='completed'&&job.result.prop);fs.mkdirSync(out,{recursive:true});
(async()=>{
 const c=new Client({name:'static-prop-native',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params={})=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:job.identity.clientId,chatSessionId:job.authoringSession,params}});assert(!r.isError,r.content[0]?.text);return r;};
 try{
  const view=async()=>JSON.parse((await call('get_scene_info')).content[0].text).result;const before=await view(),images=[],sceneImages=[];
  for(const name of mode==='asset-only'?[]:['overview','detail']){const r=await call('camera_capture',{expectedIdentity:job.identity,...job.result[name]}),metadata=JSON.parse(r.content[0].text),image=r.content.find(x=>x.type==='image');assert(image&&metadata.sessionId===job.identity.sessionId);const file=path.join(out,name+'.jpg');fs.writeFileSync(file,Buffer.from(image.data,'base64'));sceneImages.push({file,metadata});}
  for(let i=0;i<3;i++){
   const r=await call('camera_capture',{expectedIdentity:job.identity,asset:{filename:job.result.prop.filename,yaw:0.7,elevation,...distance}}),metadata=JSON.parse(r.content[0].text),image=r.content.find(x=>x.type==='image');assert(image&&image.mimeType==='image/png');assert.equal(metadata.asset.scale,1);metadata.asset.meters.forEach((n,j)=>assert(Math.abs(n-job.result.prop.expectedMeters[j])<0.001,`dimension ${j}: ${n}`));const file=path.join(out,'prop-'+i+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));images.push({file,metadata});
  }
  const after=await view();assert.deepEqual(after.player,before.player);assert.deepEqual(after.camera,before.camera);assert(Object.values(job.result.groups).every(g=>g.stale===0));
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity:job.identity,jobId:job.jobId,result:job.result,images,sceneImages,worldCaptureSkipped:mode==='asset-only',playerUnchanged:true,cameraUnchanged:true},null,2));console.log('PASS independent scale-1 prop dimensions and three fresh PNGs; native source and main view preserved');
 }finally{await c.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
