// Opt-in disposable-world profiling. Persist request/job before observation;
// transport failures never trigger another mutation.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const [worldPath,outArg]=process.argv.slice(2);assert(worldPath&&worldPath.includes('CreationAcceptance')&&outArg,'Exact disposable world and output required');
const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){
 const body=JSON.stringify({v:1,action,params});return await new Promise((resolve,reject)=>{
  const r=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{const reply=JSON.parse(text);assert(reply.ok&&reply.result.ok,JSON.stringify(reply));resolve(reply.result);}catch(e){reject(e);}});});r.on('error',reject);r.setTimeout(30000,()=>r.destroy(new Error('observation timed out')));r.end(body);
 });
}
(async()=>{
 const identity=(await native('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);
 const session='rsi-template-native',jobFile=path.join(out,'job.json');let handle;
 if(fs.existsSync(jobFile)){handle=JSON.parse(fs.readFileSync(jobFile));assert.deepEqual(handle.identity,identity);}
 else{
  const params={template:'curious_fox',expectedIdentity:identity,requestId:'fox-profile-'+Date.now(),saveSource:true};
  const compiled=compileCreationTemplate(params,session);let code=compiled.code;
  const marker='assert(C.VoxelExport';assert.equal(code.split(marker).length,2);
  const instrumentation=`local profile={};local function measure(object,names,prefix)
   for _,name in ipairs(names)do local old=assert(object[name]);local stats={calls=0,ms=0};profile[prefix..name]=stats
    object[name]=function(self,...)local start=commonlib.TimerManager.timeGetTime();local result=old(self,...);stats.calls=stats.calls+1;stats.ms=stats.ms+commonlib.TimerManager.timeGetTime()-start;return result end
   end
  end
  measure(s,{"box","bone","bindBone","exportVoxelX","keyframes","inspect","save"},"scene.")
  measure(s.world,{"Snapshot","Restore","Commit","EntitiesIntersect"},"world.")
  `;
  code=code.replace(marker,instrumentation+marker).replace('return {name=s.name,','return {profile=profile,name=s.name,');
  const request={expectedIdentity:identity,authoringSession:session,requestId:params.requestId,timeoutSeconds:600,code};
  fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));
  const first=await native('run_code',request);handle={identity,session,jobId:first.jobId};assert(handle.jobId);fs.writeFileSync(jobFile,JSON.stringify(handle,null,2));
 }
 const end=Date.now()+610000;
 while(Date.now()<end){
  let job;try{job=await native('code_job',{expectedIdentity:identity,authoringSession:session,jobId:handle.jobId});}catch(e){console.log('Read failed; retaining '+handle.jobId+': '+e.message);await new Promise(r=>setTimeout(r,1000));continue;}
  fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));
  if(job.state!=='running'){assert.equal(job.state,'completed',job.error);console.log(JSON.stringify(job.result.profile));return;}
  console.log(JSON.stringify({jobId:handle.jobId,progress:job.progress}));await new Promise(r=>setTimeout(r,2000));
 }
 throw new Error('Observation limit reached; recover saved job handle');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
