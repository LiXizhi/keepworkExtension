const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [worldPath,sourceArg,outArg]=process.argv.slice(2);
assert(worldPath&&sourceArg&&outArg,'Usage: node scripts/paracraft-asset-mcp-native.cjs EXACT_WORLD CHARACTER_REPORT OUTPUT');
const source=JSON.parse(fs.readFileSync(sourceArg,'utf8')),out=path.resolve(outArg);
const spec=source.result.animation.actors[0];assert(spec.embedded&&source.result.clips);
fs.mkdirSync(out,{recursive:true});
function native(port,action,params={}){
 const body=JSON.stringify({v:1,action,params});
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{const r=JSON.parse(text);assert(r.ok&&r.result.ok!==false,JSON.stringify(r));resolve(r.result);}catch(e){reject(e);}});
  });req.setTimeout(15000,()=>req.destroy(new Error('capture timed out')));req.on('error',reject);req.end(body);
 });
}
(async()=>{
 const client=new Client({name:'isolated-asset-acceptance',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 let clientId;
 const raw=async(action,params={})=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId,chatSessionId:'rsi-template-native',params}});assert(!r.isError,r.content.find(c=>c.type==='text')?.text);return r;};
 const call=async(action,params)=>JSON.parse((await raw(action,params)).content.find(c=>c.type==='text').text);
 try{
  assert.deepEqual((await client.listTools()).tools.filter(t=>t.name.startsWith('paracraft_')).map(t=>t.name),['paracraft_cli']);
  const selected=(await call('clients')).clients.find(c=>c.worldEntered&&c.worldPath===worldPath);assert(selected);clientId=selected.clientId;
  const identity=(await call('get_creation_capabilities')).result.identity;assert.deepEqual(identity,source.identity);
  const before=(await call('get_scene_info')).result;
  assert(/^[\w-]+$/.test(source.result.name));
  const code=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local w=C.World:new():Init({});assert(w.identity.worldPath==${JSON.stringify(worldPath)} and w.identity.sessionId==${identity.sessionId});local function read(name) local f=ParaIO.open(w.identity.worldPath.."creation/${source.result.name}/"..name,"r");assert(f:IsValid());local s=f:GetText(0,-1);f:close();return s end;local manifest=read("manifest.json");local d=commonlib.Json.Decode(manifest);local cells={};for key,m in pairs(d.cells) do local actual=w:Fingerprint(w:Snapshot(m.position));assert(actual==m.fingerprint,"stale scene member");cells[#cells+1]=key.."="..actual end;table.sort(cells);return {members=ParaMisc.md5(table.concat(cells,"\\n")),manifest=ParaMisc.md5(manifest),source=ParaMisc.md5(read("source.lua"))}`;
  const persistedBefore=(await native(selected.nplPort,'run_npl_code',{code})).result;
  const images=[],started=Date.now();
  const cases=[{id:0,time:0},{id:0,time:0.5},{id:1,time:0},{id:1,time:0.5},{id:1,time:1},{id:1,time:1.5},{id:1,time:2},{id:1,time:0.5,repeat:1},{id:1,time:0.5,repeat:2},{id:1,time:0.5,yaw:0.5},{id:1,time:0.5,yaw:Math.PI/2}];
  for(const pose of cases){
   const asset={filename:source.result.clips.filename,animId:pose.id,timeSeconds:pose.time,...(pose.yaw===undefined?{}:{yaw:pose.yaw})};
   const result=await raw('camera_capture',{expectedIdentity:identity,asset});
   const metadata=JSON.parse(result.content.find(c=>c.type==='text').text),image=result.content.find(c=>c.type==='image');
   assert(image&&image.mimeType==='image/png'&&metadata.isolated&&!metadata.base64);
   assert.equal(metadata.worldPath,worldPath);assert.equal(metadata.sessionId,identity.sessionId);assert.equal(metadata.asset.scale,1);
   metadata.asset.meters.forEach((n,i)=>assert(Math.abs(n-spec.expectedMeters[i])<0.001));
   const clip=source.result.clips.clips.find(c=>c.id===pose.id);
   const expected=spec.rotationKeys.find(k=>Math.abs(k.time-clip.startSeconds-pose.time)<0.0001).rotation;
   const bone=metadata.asset.bones.find(b=>b.name===spec.bone);assert(bone);
   assert(Math.abs(bone.rotation.reduce((sum,n,i)=>sum+n*expected[i],0))>0.9999,'Independent clip pose differs: '+JSON.stringify(pose));
   const root=metadata.asset.bones.find(b=>b.name==='root');assert(root&&Math.abs(root.rotation[3])>0.9999,'Root unexpectedly moved');
   const file=path.join(out,`id${pose.id}-${pose.time}${pose.yaw===undefined?'':'-yaw'+pose.yaw.toFixed(2)}${pose.repeat?'-repeat'+pose.repeat:''}.png`);
   fs.writeFileSync(file,Buffer.from(image.data,'base64'));images.push({file,metadata});
  }
  const after=(await call('get_scene_info')).result;
  assert.deepEqual(after.player.position,before.player.position);assert.equal(after.player.facing,before.player.facing);assert.deepEqual(after.camera,before.camera);
  const persistedAfter=(await native(selected.nplPort,'run_npl_code',{code})).result;assert.deepEqual(persistedAfter,persistedBefore);
  const cleanupCode=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(not C.AssetCapture.pending);local names=${'{'+images.map(i=>JSON.stringify(i.metadata.captureId)).join(',')+'}'};for _,name in ipairs(names) do assert(not CommonCtrl.GetControl(name),"capture UI leaked") end;return {cleaned=#names};`;
  const cleanup=(await native(selected.nplPort,'run_npl_code',{code:cleanupCode})).result;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,images,captureMs:Date.now()-started,persistedBefore,persistedAfter,cleanup,playerUnchanged:true,cameraUnchanged:true},null,2));
  console.log('PASS isolated assets: both native clip IDs, eleven PNGs, correct poses/scale, clean controls, unchanged scene/player/camera');
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
