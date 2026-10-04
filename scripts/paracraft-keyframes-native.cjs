const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const [jobArg]=process.argv.slice(2);assert(jobArg,'Usage: node scripts/paracraft-keyframes-native.cjs NATIVE_JOB_JSON');
const saved=JSON.parse(fs.readFileSync(jobArg,'utf8')),identity=saved.identity;
assert(identity.worldPath.includes('/CreationAcceptance')&&/^[\w-]+$/.test(saved.sceneName));
async function cli(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const r=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native regression timeout')));req.end(body);
 });assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result;
}
(async()=>{
 assert.deepEqual((await cli('get_creation_capabilities')).identity,identity);
 const code=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(C.World.Identity().worldPath==${JSON.stringify(identity.worldPath)} and C.World.Identity().sessionId==${identity.sessionId});NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/CreationKeyframesRegression.lua",true);local s=C.Scene:new():Init({name=${JSON.stringify(saved.sceneName)},resume=true},{wait=function()end,authoringSession=${JSON.stringify(saved.session)}});s:group("movie");s:openMovie("propeller",{0,0,12});return commonlib.gettable("MyCompany.Aries.Game.ParacraftCLI.CreationKeyframesRegression").Run(s,"propeller","airframe")`;
 const regression=(await cli('run_npl_code',{code})).result;
 const benchmark=(await cli('run_npl_code',{code:code.replace('.Run(s,"propeller","airframe")','.Benchmark(s,"propeller","airframe")')})).result;
 assert.equal(benchmark.sequentialSerializedEdits,129);assert.equal(benchmark.batchSerializedEdits,1);assert(benchmark.restored);
 const job=await cli('code_job',{expectedIdentity:identity,authoringSession:saved.session,jobId:saved.jobId});
 assert.equal(job.state,'completed');
 fs.writeFileSync(path.join(path.dirname(jobArg),'regression.json'),JSON.stringify({identity,regression,benchmark,creationElapsedMs:job.finishedAt-job.startedAt},null,2));
 console.log('PASS native batch validation, failure rollback, one-step undo and redo');console.log(regression);console.log(benchmark);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
