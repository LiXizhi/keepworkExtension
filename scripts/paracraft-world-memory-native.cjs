// Fenced native world-memory/film acceptance. No publishing or unrelated-world saves.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
const port=Number(process.env.PARACRAFT_TEST_PORT||8099);
const out=path.resolve(process.argv[2]||'tmp/world-memory-acceptance');
async function cli(action,params={}) {
  const data=JSON.stringify({v:1,action,params});
  const body=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,agent:false,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'Connection':'close'}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(new Error(action+': HTTP '+res.statusCode+' '+e.message))}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native response timeout; inspect last-job.json before retrying')));req.end(data)});
  assert(body.ok&&body.result?.ok!==false,JSON.stringify(body));return body.result;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function job(identity,requestId,code) {
  const started=await cli('run_code',{expectedIdentity:identity,authoringSession:'world-memory-acceptance',requestId,code,timeoutSeconds:120});
  fs.writeFileSync(path.join(out,'last-job.json'),JSON.stringify({identity,requestId,jobId:started.jobId},null,2));
  for(let i=0;i<240;i++) {const j=await cli('code_job',{jobId:started.jobId,expectedIdentity:identity,authoringSession:'world-memory-acceptance'});
    if(j.state==='failed'||j.state==='cancelled')throw new Error(JSON.stringify(j));
    if(j.sourceCompleted&&!j.runtimeActive) {assert.equal(j.state,'completed',JSON.stringify(j));return j.result;}
    await delay(500);
  }throw new Error('Job still pending; recover last-job.json, do not resubmit');
}
const source=`local s=createScene({name="memory_film",dimensions={16,6,10},terrainDepth=1})
s:group("sets")
s:surface({position={0,0,0},dimensions={7,1,8},blockId="StoneBrick"})
s:surface({position={9,0,0},dimensions={7,1,8},blockId="StoneBrick"})
s:group("asset")
s:box({position={7,0,8},dimensions={1,2,1},blockId="ColorBlock",color="#d48a38"})
local file=s:exportBmax("blocktemplates/memory_actor.bmax","asset")
s:group("controls")
local shots={}
for i=1,3 do
 local name="shot"..i; local x=i==2 and 12 or 3
 s:movie({name=name,position={i,1,9},duration=3})
 s:actor(name,{name="hero",filename=file,position={x,1,3},scale=1})
 s:keyframes(name,"hero",{{seconds=0,values={position={x,1,3}}},{seconds=3,values={position={x+1,1,3}}}})
 s:cameraKeyframes(name,{{seconds=0,lookat={x,1,3},distanceMeters=7,yaw=0.7,pitch=0.2},
   {seconds=3,lookat={x+1,1,3},distanceMeters=6,yaw=0.5,pitch=0.2}})
 shots[i]={seconds=(i-1)*3,moviePosition=s:position({i,1,9})}
end
s:movie({name="film",position={0,1,9},duration=9})
s:movieSequence("film",shots)
s:save()
return {origin=s.origin,shots=shots,master=s:position({0,1,9}),
  view={eye=s:cameraPoint({20,10,15}),lookat=s:cameraPoint({8,1,4})}}`;
if(require.main===module)(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const cap=await cli('get_creation_capabilities'),identity=cap.identity;
 assert(identity.worldPath.includes('/CreationAcceptance_WorldMemory_'),'Requires disposable WorldMemory acceptance world');
 assert(cap.worldAnalysis&&cap.worldDocuments&&cap.movieSequences&&cap.cameraKeyframes);
 const regression=await cli('run_npl_code',{code:'NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/WorldMemoryRegression.lua",true);return MyCompany.Aries.Game.ParacraftCLI.WorldMemoryRegression.Run();'});
 assert(regression.result.ok);
 const init=await cli('world_docs',{operation:'init',expectedIdentity:identity});assert.equal(init.worldSaved,false);
 const initAgain=await cli('world_docs',{operation:'init',expectedIdentity:identity});assert(initAgain.files.every(f=>f.status==='unchanged'));
 const instruction=await cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity});assert(instruction.content.includes('docs/README.md'));
 const result=await job(identity,'memory-film-build-v1',source);fs.writeFileSync(path.join(out,'film.json'),JSON.stringify({identity,result},null,2));
 const negatives=await cli('run_npl_code',{code:`local C=MyCompany.Aries.Game.Code.Creation;local s=C.Scene:new():Init({name="memory_film",resume=true},{wait=function() end});s:openMovie("film",{0,1,9});s:openMovie("shot1",{1,1,9});assert(not pcall(function()s:movieSequence("shot1",{{seconds=0,moviePosition=s:position({0,1,9})}})end));assert(not pcall(function()s:movieSequence("film",{{seconds=1,moviePosition=s:position({1,1,9})}})end));return true;`});assert(negatives.result);
 const snapshot=await cli('analyze_world',{expectedIdentity:identity});assert.equal(snapshot.objects.filter(o=>o.kind==='movie').length,4);
 const master=snapshot.objects.find(o=>o.kind==='movie'&&o.position.join()===result.master.join());assert(master);
 const detail=await cli('read_scene_object',{ref:master.ref,details:true});assert.equal(detail.relations.filter(r=>r.kind==='plays').length,3);
 const movies=await cli('world_files',{operation:'read',path:'docs/movies.md',expectedIdentity:identity});
 await cli('world_docs',{operation:'update',expectedIdentity:identity,files:[{path:'docs/movies.md',expectedContent:movies.content,content:`# Film\nScene: memory_film\nMaster: ${result.master.join(', ')}\n${JSON.stringify(result.shots)}\nSource: creation/memory_film/source.lua\nNative edits are UNSAVED; recheck after a session change.\n`}]});
 const image=await cli('camera_capture',{expectedIdentity:identity,...result.view});
 fs.writeFileSync(path.join(out,'overview.png'),Buffer.from(image.base64,'base64'));
 const playback=await job(identity,'memory-film-play-v1',`local s=createScene({name="memory_film",resume=true});s:openMovie("film",{0,1,9});return s:playMovie("film")`);
 const log=await cli('tail_log',{lines:10});
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,regression,init,snapshot,detail,playback,log},null,2));
 console.log('PASS native docs initialization, world index, three shots/two sets, camera tracks, cycle rejection and playback completion');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
module.exports={cli,job};
