// Opt-in against an already entered disposable world; never saves native world data.
// PARACRAFT_TEST_PORT=8100 node scripts/paracraft-half-blocks-native.cjs OUTPUT
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const port=Number(process.env.PARACRAFT_TEST_PORT||8100),out=path.resolve(process.argv[2]||'out/codex-half-blocks');
async function cli(action,params={}) {
 const body=JSON.stringify({action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('native timeout; recover existing job')));req.end(body);
 });assert.notEqual(reply.ok,false,JSON.stringify(reply));assert.notEqual(reply.result?.ok,false,JSON.stringify(reply));return reply.result||reply;
}
(async()=>{
 const cap=await cli('get_creation_capabilities'),identity=cap.identity;
 assert(identity.worldPath.replace(/\\/g,'/').match(/\/CreationAcceptance_HalfBlocks[^/]*\/$/),'Disposable HalfBlocks world required');
 assert(cap.nativeHalfBlocks,'Updated engine required');
 await cli('world_docs',{operation:'init',expectedIdentity:identity});
 await cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity});
 const name='halves_'+Date.now(),authoringSession=name;
 async function run(code,suffix,expectedState='completed') {
  let job=await cli('run_code',{expectedIdentity:identity,authoringSession,requestId:name+'-'+suffix,code});
  for(let n=0;job.state==='running'&&n<180;n++) {await new Promise(r=>setTimeout(r,500));job=await cli('code_job',{expectedIdentity:identity,authoringSession,jobId:job.jobId});}
  assert.equal(job.state,expectedState,JSON.stringify(job));return expectedState==='completed'?job.result:job;
 }
 const source=`local s=createScene({name="${name}",dimensions={8,4,8}})
local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine")
local T=commonlib.gettable("MyCompany.Aries.Game.block_types")
s:group("steps")
local directions={{{0.5,0.5,0},{0.5,0.5,1}},{{0,0.5,0},{0.5,0.5,1}},{{0,0.5,0.5},{1,0.5,0.5}},{{0,0.5,0},{1,0.5,0.5}}}
local placed={}
for i,d in ipairs(directions) do
 local x=(i-1)*2
 local result=s:halfBlocks({blockId="StoneBrick",boxes={
  {position={x,0,0},dimensions={1,0.5,1}},
  {position={x+d[1][1],d[1][2],d[1][3]},dimensions=d[2]}}})
 local p=s:position({x,0,0});local id,data=B:GetBlockFull(unpack(p));assert(id==T.names.StoneBrick_Stairs and data%256==i)
 placed[#placed+1]={position=p,id=id,data=data}
 assert(result.nativeShapes.stairs==1)
end
s:group("slabs")
s:box({position={0,0,3},dimensions={2,0.5,1},size=0.5,blockId="Oak_Wood_Planks"})
s:box({position={3,0.5,3},dimensions={2,0.5,1},size=0.5,blockId="Oak_Wood_Planks"})
s:group("micro")
s:block({position={6,0,3},size=0.5,color="#3399AA"})
local p=s:position({6,0,3});assert(B:GetBlockId(unpack(p))==T.names.VoxelModelBlock,"default color half must stay exportable")
s:group("seats")
s:halfBlocks({color="#AA6655",boxes={{position={0,0,5},dimensions={3,0.5,1}},{position={0,0.5,5},dimensions={3,0.5,0.5}}}})
s:halfBlocks({color="#AA6655",boxes={{position={0,0,7},dimensions={3,0.5,1}},{position={0,0.5,7.5},dimensions={3,0.5,0.5}}}})
local a=s:position({0,0,5});local b=s:position({0,0,7})
assert(B:GetBlockData(unpack(a))%256==4 and B:GetBlockData(unpack(b))%256==3,"opposed seats must face their shared space")
s:save()
wait(2)
return {name=s.name,origin=s.origin,placed=placed,seats={a,b},
 eye=s:cameraPoint({11,8,-9}),lookat=s:cameraPoint({3,0.5,3}),
 sideEye=s:cameraPoint({8,3,9}),sideLookat=s:cameraPoint({2,0.6,6}),worldSaved=false}`;
 const build=await run(source,'build');
 const failed=await run(`local s=createScene({name="${name}",resume=true});s:group("negative");s:halfBlocks({blockId="StoneBrick",boxes={{position={5,0,5},dimensions={1,0.5,1}},{position={6,0,5},dimensions={0.5,0.5,0.5}}}})`,'invalid','failed');
 assert(failed.error.includes('no exact native slab/stair'));
 const empty=await cli('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");assert(B:GetBlockId(${build.origin[0]+5},${build.origin[1]},${build.origin[2]+5})==0);assert(B:GetBlockId(${build.origin[0]+6},${build.origin[1]},${build.origin[2]+5})==0);return true`});assert.equal(empty.result,true);
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'generator.lua'),source);
 for(const [file,eye,lookat] of [['overview.jpg',build.eye,build.lookat],['seats.jpg',build.sideEye,build.sideLookat]]) {
  const capture=await cli('camera_capture',{expectedIdentity:identity,authoringSession,eye,lookat});
  assert.notEqual(capture.cached,true);assert.equal(capture.mimeType,'image/jpeg');assert(capture.base64);
  fs.writeFileSync(path.join(out,file),Buffer.from(capture.base64,'base64'));
 }
 const removed=await run(`local s=createScene({name="${name}",resume=true});s:remove("steps");return true`,'remove');assert.equal(removed,true);
 await cli('run_npl_code',{code:'return commonlib.gettable("MyCompany.Aries.Game.UndoManager").Undo()'});
 const positions=build.placed.map(p=>`{${p.position.join(',')}}`).join(',');
 const undo=await cli('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");for i,p in ipairs({${positions}})do assert(B:GetBlockData(unpack(p))%256==i)end;return true`});assert.equal(undo.result,true);
 await cli('run_npl_code',{code:'return commonlib.gettable("MyCompany.Aries.Game.UndoManager").Redo()'});
 const redo=await cli('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");for _,p in ipairs({${positions}})do assert(B:GetBlockId(unpack(p))==0)end;return true`});assert.equal(redo.result,true);
 // Return to the built display without saving the disposable native world.
 await cli('run_npl_code',{code:'return commonlib.gettable("MyCompany.Aries.Game.UndoManager").Undo()'});
 const logs=await cli('tail_log');fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,build,undo:undo.result,redo:redo.result,worldSaved:false,logs},null,2));
 console.log('PASS four native stair directions, upper/lower slabs, opposed seats, microvoxel preservation, failed-batch isolation, manifest resume and native undo/redo');
})().catch(error=>{console.error(error.message);process.exitCode=1});
