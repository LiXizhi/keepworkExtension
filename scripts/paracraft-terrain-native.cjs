const assert=require('node:assert/strict');
const fs=require('node:fs');
const endpoint='http://127.0.0.1:8100/ajax/paracraft_cli';
async function cli(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const r=await new Promise((resolve,reject)=>{
  const req=require('node:http').request(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}})});
  req.on('error',reject);req.end(body);
 });
 assert.notEqual(r.ok,false,JSON.stringify(r));assert.notEqual(r.result?.ok,false,JSON.stringify(r));return r.result||r;
}
(async()=>{
 const cap=await cli('get_creation_capabilities');assert.equal(cap.identity.worldPath,'C:/lxzsrc/ParaEngine/ParaWorld/worlds/DesignHouse/CreationAcceptance_20261003/');console.log(JSON.stringify(cap.identity));
 const name='terrain_'+Date.now(),authoringSession=name;const identity=cap.identity;
 async function run(code,suffix){let r=await cli('run_code',{expectedIdentity:identity,authoringSession,requestId:name+'-'+suffix,code});for(let i=0;i<600&&r.state==='running';i++){await new Promise(r=>setTimeout(r,100));r=await cli('code_job',{expectedIdentity:identity,authoringSession,jobId:r.jobId});}assert.equal(r.state,'completed',r.error||JSON.stringify(r));return r.result;}
 const result=await run(`local s=createScene({name="${name}",dimensions={3,4,3},terrainDepth=2,radius=48})
s:group("floor")
s:surface({dimensions={2,1,2},blockId=81})
local ground=s:position({0,-1,0});local key=table.concat(ground,",")
local original=commonlib.deepcopy(s.cells[key].original)
s:surface({dimensions={2,1,2},blockId=76})
local water=s.world:Snapshot(ground);assert(water.id==75 or water.id==76,"water readback "..water.id)
assert(s.world:Fingerprint(s.cells[key].original)==s.world:Fingerprint(original))
s:save()
local eye=s:toWorld({2,3,2});local lookat=s:toWorld({1,0,1})
return {name=s.name,ground=ground,original=original,origin=s.origin,eye=eye,lookat=lookat}`, 'build');
 const restored=await run(`local s=createScene({name="${name}",resume=true})
assert(s.terrainDepth==2)
local key=table.concat({${result.ground.join(',')}},",");local p=s.cells[key].position
local original=commonlib.deepcopy(s.cells[key].original)
local water=s.world:Snapshot(p);assert(water.id==75 or water.id==76,"water readback "..water.id)
s:remove("floor")
assert(s.world:Fingerprint(s.world:Snapshot(p))==s.world:Fingerprint(original))
s:save(s.savedSource)
return {restored=true,original=original,position=p}`, 'restore');
 await cli('run_npl_code',{code:'return commonlib.gettable("MyCompany.Aries.Game.UndoManager").Undo()'});
 const undone=await cli('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local id=B:GetBlockId(${result.ground.join(',')});assert(id==75 or id==76,"undo did not restore water");return true`});
 assert.equal(undone.result,true);
 await cli('run_npl_code',{code:'return commonlib.gettable("MyCompany.Aries.Game.UndoManager").Redo()'});
 const redone=await cli('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local id,data=B:GetBlockFull(${result.ground.join(',')});assert(id==${result.original.id} and data==${result.original.data},"redo did not restore original terrain");return true`});
 assert.equal(redone.result,true);
 const screen=await cli('camera_capture' ,{expectedIdentity:identity,authoringSession,eye:result.eye,lookat:result.lookat});
 assert.equal(screen.mimeType,'image/jpeg');fs.mkdirSync('out/codex-terrain',{recursive:true});fs.writeFileSync('out/codex-terrain/restored.jpg',Buffer.from(screen.base64,'base64'));fs.writeFileSync('out/codex-terrain/report.json',JSON.stringify({identity,result,restored},null,2));
 console.log('PASS native flush floor -> water -> saved resume -> original terrain restoration, native undo/redo; fresh capture saved');
})().catch(e=>{console.error(e.message);process.exitCode=1});
