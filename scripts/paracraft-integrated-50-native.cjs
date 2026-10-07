'use strict';

// Disposable native integrated campaign. No native action occurs when imported.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {catalog,buildSource,revisionSource,inspectSource}=require('./fixtures/paracraft-integrated-catalog.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
function lua(v){if(v==null)return 'nil';if(Array.isArray(v))return '{'+v.map(lua).join(',')+'}';if(typeof v==='object')return '{'+Object.entries(v).map(([k,x])=>'['+lua(k)+']='+lua(x)).join(',')+'}';return JSON.stringify(v);}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.new',JSON.stringify(value,null,2));fs.renameSync(file+'.new',file);}
function read(file){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
function staticStale(result){return Object.entries(result.groups||{}).filter(([name])=>name!=='logic'&&name!=='river_water').reduce((n,[,group])=>n+group.stale,0);}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function managedSection(text){const begin='<!-- paracraft-creation:begin -->',end='<!-- paracraft-creation:end -->';const a=text.indexOf(begin),b=text.indexOf(end);if(a<0&&b<0)return '';assert(a>=0&&b>a&&text.indexOf(begin,a+begin.length)<0&&text.indexOf(end,b+end.length)<0,'Ambiguous managed document section');return text.slice(a+begin.length,b).replace(/^\r?\n/,'').replace(/\r?\n$/,'');}
function resolveRecoveredFailures(r,report){
 if(r.failure){
  assert(report.machinePassed&&r.steps.docsVerified&&r.steps.preservation?.value?.passed,'Cannot resolve a failure without completed machine and documentation evidence');
  const fingerprint=sha(JSON.stringify(canonical(r.failure))),originalFile=path.join(r.dir,'resolved-failure-'+fingerprint.slice(0,12)+'-original.json');
  const pendingFile=path.join(r.dir,'failure.json');if(fs.existsSync(pendingFile)){if(fs.existsSync(originalFile)){assert.equal(fs.readFileSync(originalFile,'utf8'),fs.readFileSync(pendingFile,'utf8'),'Existing historical failure differs');fs.unlinkSync(pendingFile);}else fs.renameSync(pendingFile,originalFile);}else if(!fs.existsSync(originalFile))atomic(originalFile,r.failure);
  const resolution={kind:'completed machine acceptance after recovery',machineReport:path.join(r.dir,'report.json'),state:path.join(r.dir,'state.json'),completedStages:['docsVerified','preservation','reopened','sourceEquality','logic'],documentationEvidence:'state.json#steps.docsVerified',reopenEvidence:'state.json#steps.reopened',originalFailureFile:originalFile,visualReviewIndependent:true};
  r.failureHistory=r.failureHistory||[];if(!r.failureHistory.some(h=>h.fingerprint===fingerprint))r.failureHistory.push({fingerprint,failure:r.failure,resolvedAt:report.end,resolution});delete r.failure;
  fs.writeFileSync(path.join(r.dir,'failure-history.md'),'# Historical failures\n\nThe resolved-failure-*-original.json files retain original failure evidence unchanged. They describe earlier failed attempts, not an active failure. Resolution entries in state.json failureHistory and report.json recoveredFailures reference completed native machine checks, fresh-session reopen and documentation stages. Visual approval is a separate review.\n');
 }
 report.recoveredFailures=r.failureHistory||[];
}
function normalized(p){return String(p||'').replace(/\\/g,'/').replace(/\/+$/,'/');}

class Campaign {
 constructor(port,out){
  this.port=Number(port);assert(Number.isInteger(this.port)&&this.port>0&&this.port<65536,'PORT required');
  this.out=path.resolve(out);const temp=path.resolve(os.tmpdir()),rel=path.relative(temp,this.out);
  assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'OUTPUT must be inside OS temp');
  assert(/^paracraft-integrated-50-[\w-]+$/.test(path.basename(this.out)),'OUTPUT requires paracraft-integrated-50-* basename');
  fs.mkdirSync(this.out,{recursive:true});assert(fs.realpathSync(this.out).toLowerCase().startsWith(fs.realpathSync(temp).toLowerCase()+path.sep),'No output junction escaping temp');
  this.file=path.join(this.out,'campaign.json');this.data=read(this.file)||{version:1,campaignId:path.basename(this.out).replace('paracraft-integrated-50-',''),authoringSession:'integrated50-'+crypto.randomUUID(),createdAt:new Date().toISOString(),httpCount:0,payloadBytes:0,rounds:{}};
  this.author=this.data.authoringSession;this.persist();
 }
 persist(){atomic(this.file,this.data);}
 async cli(action,params={},allowFailure=false){
  const authoringActions=new Set(['run_code','code_job','find_build_site','get_scene_info','camera_capture']);
  const body=JSON.stringify({v:1,action,params:authoringActions.has(action)?{authoringSession:this.author,...params}:params}),start=Date.now();
  this.data.httpCount++;this.data.payloadBytes+=Buffer.byteLength(body);this.persist();
  const raw=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:this.port,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},agent:false},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(new Error(action+' invalid response: '+e.message));}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error(action+' observation timeout; recover same handle')));req.end(body);});
  const result=raw.result;
  if(!allowFailure)assert(raw.ok&&result?.ok!==false,action+': '+JSON.stringify(raw));
  this.data.lastObservation={action,ms:Date.now()-start,at:new Date().toISOString()};this.persist();
  return raw.ok?result:{ok:false,error:raw.error||result||raw};
 }
 async status(){return this.cli('run_command',{world:{operation:'status'}});}
 async fence(identity){const cap=await this.cli('get_creation_capabilities');assert.deepEqual(cap.identity,identity,'World session changed; inspect existing evidence before continuing');return cap;}
 prefix(identity){return `local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local i=C.World.Identity();assert(i.worldPath==${lua(identity.worldPath)} and i.sessionId==${lua(identity.sessionId)} and i.clientId==${lua(identity.clientId)},"campaign identity fence");` ;}
 async probe(identity,code){return (await this.cli('run_npl_code',{code:this.prefix(identity)+code})).result;}
 async entered(worldPath,previous){const deadline=Date.now()+120000;let last,identityError;do{last=await this.status();if(last.worldEntered&&normalized(last.worldPath)===normalized(worldPath)){if(!previous)return last;try{const identity=(await this.cli('get_creation_capabilities')).identity;assert.equal(identity.clientId,previous.clientId,'Reopen changed native client');if(normalized(identity.worldPath)===normalized(worldPath)&&identity.sessionId!==previous.sessionId)return {...last,creationIdentity:identity};}catch(e){identityError=e.message;}}await sleep(700);}while(Date.now()<deadline);throw new Error('Open remains pending; inspect same client, never resubmit: '+JSON.stringify({last,previous,identityError}));}
 async completeReopen(r,name){
  assert(r.steps.saved&&r.steps.opened,'Reopen requires completed save and original entry');const file=path.join(r.dir,'reopen-dispatched.json');let marker=read(file);
  if(!marker){const previous=r.identity;await this.fence(previous);assert.equal(normalized(previous.worldPath),normalized(r.worldPath));marker={previous,name,at:new Date().toISOString()};atomic(file,marker);await this.cli('run_command',{world:{operation:'open',name,expectedWorldPath:r.worldPath,confirmSwitch:true}});}
  assert.equal(marker.name,name,'Stored reopen targets another world');assert.deepEqual(marker.previous,r.steps.opened.value.identity,'Stored reopen previous identity disagrees with original opening');assert.equal(normalized(marker.previous.worldPath),normalized(r.worldPath),'Stored reopen path disagrees with campaign world');
  const entered=await this.entered(r.worldPath,marker.previous),identity=entered.creationIdentity;assert(identity&&identity.sessionId!==marker.previous.sessionId,'No fresh same-path identity');r.identity=identity;
  return {identity,previousIdentity:marker.previous,instructions:await this.instructions(identity)};
 }
 async instructions(identity){
  let agents=await this.cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity},true);
  if(agents.ok===false||agents.exists===false){const error=JSON.stringify(agents);assert(agents.exists===false||/not.?found|missing|does not exist|file_not_found/i.test(error),'AGENTS read failed for reason other than missing: '+error);await this.cli('world_docs',{operation:'init',expectedIdentity:identity});agents=await this.cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity});}
  const home=await this.cli('world_files',{operation:'read',path:'docs/README.md',expectedIdentity:identity});
  assert(typeof agents.content==='string'&&typeof home.content==='string','World instructions missing');return {agents:agents.content,readme:home.content};
 }
 async job(r,key,code){
  const file=path.join(r.dir,key+'-request.json'),existing=read(file);
  let request=existing||{expectedIdentity:r.identity,authoringSession:this.author,requestId:r.jobRequestIds?.[key]||this.author+'-R'+r.number+'-'+key,code,timeoutSeconds:120};
  assert.equal(request.code,code,'Source changed after dispatch; repair existing partial world explicitly');assert.deepEqual(request.expectedIdentity,r.identity,'Stored request uses prior world identity');
  let handle=read(path.join(r.dir,key+'-handle.json'));
  if(!existing){atomic(file,request);fs.writeFileSync(path.join(r.dir,key+'.lua'),code);try{handle=await this.cli('run_code',request);atomic(path.join(r.dir,key+'-handle.json'),handle);}catch(e){handle=await this.cli('code_job',{expectedIdentity:r.identity,requestId:request.requestId});atomic(path.join(r.dir,key+'-handle.json'),handle);}}
  else if(!handle){handle=await this.cli('code_job',{expectedIdentity:r.identity,requestId:request.requestId});atomic(path.join(r.dir,key+'-handle.json'),handle);}
  assert(handle.jobId,'No existing handle; inspect requestId, never blindly replay');
  const start=Date.now();let result;
  do{result=await this.cli('code_job',{expectedIdentity:r.identity,jobId:handle.jobId,resultDetail:'full'});atomic(path.join(r.dir,key+'-job.json'),result);if(['failed','cancelled'].includes(result.state))throw new Error(key+' job '+result.state+': '+JSON.stringify(result));if(result.state==='completed'&&!result.runtimeActive)break;await sleep(500);}while(Date.now()-start<180000);
  assert.equal(result.state,'completed','Job live; resume same handle');assert(!result.runtimeActive,'Persistent job still active');r.jobTimings=r.jobTimings||{};r.jobTimings[key]={startedAt:result.startedAt,finishedAt:result.finishedAt,elapsedMs:result.finishedAt-result.startedAt};return result.result;
 }
 async step(r,key,fn){if(r.steps[key])return r.steps[key].value;const start=Date.now();const value=await fn();r.steps[key]={ms:Date.now()-start,value};r.stage=key;atomic(path.join(r.dir,'state.json'),r);return value;}
 async init(){
  const health=await this.cli('health');this.data.health=health;
  if(this.data.clientId)assert.equal(health.clientId||health.identity?.clientId,this.data.clientId,'Different native client');
  const cap=await this.cli('get_creation_capabilities');this.data.clientId=cap.identity.clientId;
  this.data.officialWiki=this.data.officialWiki||{};for(const page of ['creation.md','world-management.md'])if(!this.data.officialWiki[page]){this.data.officialWiki[page]=await this.cli('read_official_wiki',{path:page});this.persist();}
  this.persist();
 }
 async docs(r,build){
  const identity=r.identity,files=[];
  for(const [p,content]of [['docs/acceptance.md',`# Integrated acceptance ${r.number}\n\n${r.case.brief}\n\nScene ${build.sceneName}; source creation/${build.sceneName}/source.lua.\nNative geometry, scoped roof revision, full generator, circuit input/output behavior, save/reopen and fresh captures are independently checked.\nRuntime/native edits verified; documentation and generator persistence are distinct from native saving. Save/reopen verification follows this document write. Machine acceptance does not imply visual approval.\n`],['docs/changes.md',`# Changes\n\n${new Date().toISOString()}: created integrated scene, revised only west_roof; full generator retained. Documentation written. Native save and independent reopen verification are pending immediately after this entry; authoritative completed verification is in the external campaign report.\n`]]){const previous=await this.cli('world_files',{operation:'read',path:p,expectedIdentity:identity},true);if(previous.ok===false||previous.exists===false){assert(previous.exists===false||/not.?found|missing|does not exist|file_not_found/i.test(JSON.stringify(previous)));files.push({path:p,create:true,content});}else files.push({path:p,expectedContent:previous.content,content});}
  return this.cli('world_docs',{operation:'update',expectedIdentity:identity,files});
 }
 async stableScene(identity){
  await this.fence(identity);await this.cli('bring_to_front');await sleep(1000);
  let previous,stable=0,last;const observations=[];
  for(let attempt=0;attempt<15;attempt++){
   const viewport=await this.probe(identity,'local root=ParaUI.GetUIObject("root");return {width=root.width,height=root.height,aspectRatio=ParaCamera.GetAttributeObject():GetField("AspectRatio",1),rendering=ParaEngine.GetAttributeObject():GetField("Enable3DRendering",true)};');
   last=await this.cli('get_scene_info');observations.push({viewport,camera:last.camera});
   const ratio=viewport.width/viewport.height;
   const ready=viewport.rendering&&viewport.width>0&&viewport.height>0&&Math.abs(last.camera.aspectRatio-ratio)<0.0001;
   if(ready&&previous&&JSON.stringify(last.camera)===JSON.stringify(previous.camera)){stable++;if(stable>=2)return {scene:last,observations};}else stable=0;
   previous=last;await sleep(250);
  }
  throw new Error('Main viewport did not initialize/stabilize before preservation baseline: '+JSON.stringify(observations));
 }
 async recheckCaptures(number){
  const dir=path.join(this.out,'round-'+String(number).padStart(2,'0')),r=read(path.join(dir,'state.json'));assert(r&&r.steps.logic&&r.steps.reopened,'Recheck requires completed construction/reopen/native logic');
  assert(!r.machinePassed,'Round already machinePassed; visual review is a separate root gate');
  await this.fence(r.steps.reopened.value.identity);
  const archive=path.join(dir,'recheck-'+Date.now());fs.mkdirSync(archive,{recursive:true});atomic(path.join(archive,'original-state.json'),r);
  for(const view of ['overview','entry']){const previous=r.steps['capture-'+view]?.value?.file;if(previous&&fs.existsSync(previous))fs.copyFileSync(previous,path.join(archive,path.basename(previous)));}
  if(r.failure)atomic(path.join(archive,'original-failure.json'),r.failure);
  r.rechecks=r.rechecks||[];r.rechecks.push({at:new Date().toISOString(),reason:'Capture/preservation recheck after recorded failure: '+(r.failure?.error?.split('\n')[0]||'No recorded failure text; explicit recheck requested')+'. Cause remains unresolved; completed native construction/logic evidence retained.',originalFailure:r.failure||null,archive});
  for(const key of ['postReopenBefore','baselineViewport','capture-overview','capture-entry','after','preservation'])delete r.steps[key];
  delete r.failure;r.stage='capture-recheck';atomic(path.join(dir,'state.json'),r);
  return this.round(number);
 }
 async retryUnmodifiedBuild(number){
  const dir=path.join(this.out,'round-'+String(number).padStart(2,'0'));let r=read(path.join(dir,'state.json'));assert(r&&!r.machinePassed&&!r.steps.build,'Retry requires failed initial build, never completed construction');
  await this.fence(r.identity);
  if(r.unmodifiedBuildRetry?.phase==='ready')return this.round(number);
  const prior=r.unmodifiedBuildRetry;
  const request=prior?.request||read(path.join(dir,'build-request.json'));const handle=prior?.handle||read(path.join(dir,'build-handle.json'));
  assert(request&&handle?.jobId,'Missing failed build evidence');assert.deepEqual(request.expectedIdentity,r.identity);assert.equal(request.authoringSession,this.author);
  const job=await this.cli('code_job',{expectedIdentity:r.identity,jobId:handle.jobId,resultDetail:'full'});
  assert.equal(job.state,'failed','Never retry running/observation-timeout job');assert.equal(job.runtimeActive,false);assert.equal(job.sourceCompleted,true);assert(Object.keys(job.created||{}).length===0,'Failed job created native references');assert(typeof job.result!=='object','Failed job returned scene state');
  // This opt-in is deliberately limited to the observed line-one read-only clock failure.
  assert(/^local\s+[A-Za-z_][A-Za-z_0-9]*\s*=\s*ParaGlobal\.timeGetTime\(\)\s*\r?\n/.test(request.code),'Cannot prove failed source prefix was read-only');assert(/:1:.*ParaGlobal/.test(String(job.result)),'Failure was not before the first authoring statement');
  const scene=r.case.sceneName;const absent={};for(const file of ['manifest.json','source.lua']){const p='creation/'+scene+'/'+file;absent[p]=await this.cli('world_files',{operation:'read',path:p,expectedIdentity:r.identity});assert.equal(absent[p].exists,false,'Scene persistence exists; partial world must be repaired explicitly');}
  const archive=prior?.archive||path.join(dir,'retry-unmodified-build-'+Date.now());fs.mkdirSync(archive,{recursive:true});
  if(!prior){atomic(path.join(archive,'original-state.json'),r);if(r.failure)atomic(path.join(archive,'original-failure.json'),r.failure);atomic(path.join(archive,'verified-failed-job.json'),job);atomic(path.join(archive,'verified-absent-files.json'),absent);r.unmodifiedBuildRetry={phase:'archiving',archive,request,handle,newRequestId:this.author+'-R'+number+'-build-unmodified-retry-'+crypto.randomUUID()};atomic(path.join(dir,'state.json'),r);}
  for(const name of ['build-request.json','build-handle.json','build-job.json','build.lua','failure.json']){const source=path.join(dir,name),target=path.join(archive,name);if(fs.existsSync(source)){if(!fs.existsSync(target))fs.copyFileSync(source,target);fs.unlinkSync(source);}}
  r.jobRequestIds=r.jobRequestIds||{};r.jobRequestIds.build=r.unmodifiedBuildRetry.newRequestId;r.unmodifiedBuildRetry.phase='ready';r.unmodifiedBuildRetry.verification={identity:r.identity,failedJobId:handle.jobId,sourceCompleted:job.sourceCompleted,runtimeActive:job.runtimeActive,created:job.created,absent};delete r.failure;r.stage='before';atomic(path.join(dir,'state.json'),r);
  return this.round(number);
 }
 async recheckGeometry(number){
  const dir=path.join(this.out,'round-'+String(number).padStart(2,'0')),r=read(path.join(dir,'state.json'));assert(r&&!r.machinePassed&&r.steps.geometry&&!r.steps.geometry.value.passed,'Requires recorded failed geometry check');assert(r.steps.build&&r.steps.revision&&r.steps.saved&&r.steps.reopened,'Requires completed native construction/save/reopen');await this.fence(r.steps.reopened.value.identity);
  const archive=path.join(dir,'recheck-geometry-'+Date.now());fs.mkdirSync(archive,{recursive:true});atomic(path.join(archive,'original-state.json'),r);atomic(path.join(archive,'original-geometry.json'),r.steps.geometry.value);if(r.failure)atomic(path.join(archive,'original-failure.json'),r.failure);
  r.geometryRechecks=r.geometryRechecks||[];r.geometryRechecks.push({at:new Date().toISOString(),archive,mode:'read-only native collision geometry; all completed authoring/save/reopen steps retained'});delete r.steps.geometry;delete r.failure;r.stage='geometry-recheck';atomic(path.join(dir,'state.json'),r);return this.round(number);
 }
 async capture(r,name,view){
  assert(view?.eye&&view?.lookat,'Missing '+name+' camera');let result,errors=[];
  for(let attempt=0;attempt<2;attempt++){try{await this.probe(r.identity,'return {rendering=ParaEngine.GetAttributeObject():GetField("Enable3DRendering",true)};');await sleep(attempt?1000:350);result=await this.cli('camera_capture',{expectedIdentity:r.identity,...view});assert(typeof result.base64==='string'&&result.base64.length>1000,'Capture missing pixels');const ext=result.mimeType==='image/jpeg'||result.format==='jpg'?'jpg':'png';const file=path.join(r.dir,name+'.'+ext);const data=Buffer.from(result.base64,'base64');fs.writeFileSync(file,data);const metadata={...result};delete metadata.base64;return {file,bytes:data.length,sha256:sha(data),metadata,retries:attempt,errors,visualReview:null};}catch(e){errors.push(e.message);if(attempt===0)await this.cli('bring_to_front');}}
  throw new Error('Capture failed after one restore: '+JSON.stringify(errors));
 }
 async logic(r,ports){
  const key='Integrated50_'+this.data.campaignId.replace(/\W/g,'_')+'_'+r.number;
  const existing=await this.probe(r.identity,`local a=_G[${lua(key)}];return a and {active=a.active,done=a.done,result=a.result,error=a.error} or {missing=true};`);
  if(existing.missing){
   const marker=path.join(r.dir,'logic-dispatched.json');assert(!read(marker),'Lost native probe state after dispatch; do not replay inputs blindly');atomic(marker,{identity:r.identity,key,ports,at:new Date().toISOString()});
   await this.probe(r.identity,logicSource(key,ports));
  }
  const deadline=Date.now()+45000;let observed;
  do{await sleep(1500);observed=await this.probe(r.identity,`local a=assert(_G[${lua(key)}],"missing owned probe");return {active=a.active,done=a.done,result=a.result,error=a.error};`);atomic(path.join(r.dir,'logic.json'),observed);if(observed.done||observed.error)break;}while(Date.now()<deadline);
  assert(!observed.error,observed.error);assert(observed.done,'Owned Timer live; resume same probe key');const result=observed.result;
  assert(result.tests.length>0&&result.tests.every(t=>t.pass),'Native truth/reset/retrigger failed: '+JSON.stringify(result));
  if(ports.kind==='delay'){const transitions=result.tests.filter(t=>t.firstMs);assert.equal(transitions.length,4,'Need on/off/reset/retrigger delay transitions');for(const t of transitions){assert(t.firstMs.length===ports.outputs.length&&t.firstMs.every(Number.isFinite),'Missing delay transition');assert(t.firstMs.every((n,i)=>i===0||n>t.firstMs[i-1]+150),'Delay ordering failed');}}
  if(ports.kind==='button')assert(result.releaseMs.every(n=>Number.isFinite(n)&&n>150&&n<2000),'Button did not release naturally');
  return result;
 }
 async round(number){
  const dir=path.join(this.out,'round-'+String(number).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  let r=read(path.join(dir,'state.json'))||{number,dir,case:catalog[number-1],steps:{},stage:'new',start:new Date().toISOString(),httpStart:this.data.httpCount,payloadStart:this.data.payloadBytes};
  assert(r.case,'Missing case');if(r.machinePassed)return read(path.join(dir,'report.json'));
  try{
   const name='CreationAcceptance_Integrated50_'+this.data.campaignId+'_R'+String(number).padStart(2,'0');
   const created=await this.step(r,'created',async()=>{const pending=path.join(dir,'create-dispatched.json');if(read(pending))throw new Error('World create response was lost; inspect same name before recording create evidence');atomic(pending,{name});const v=await this.cli('run_command',{world:{operation:'create',name}});assert(['created','exists'].includes(v.status));return v;});
   assert(normalized(created.worldPath).endsWith('/'+name+'/'),'Unexpected test world path');r.worldPath=created.worldPath;
   if(!r.steps.opened){const before=await this.status();assert(before.worldPath===this.data.initialWorldPath||!this.data.initialWorldPath||/\/CreationAcceptance_/.test(normalized(before.worldPath)),'Refuse switch away from unexpected user world');if(!this.data.initialWorldPath){this.data.initialWorldPath=before.worldPath;this.persist();}const marker=path.join(dir,'open-dispatched.json');if(!read(marker)){atomic(marker,{before,name});await this.cli('run_command',{world:{operation:'open',name,expectedWorldPath:before.worldPath||'',confirmSwitch:true}});}await this.entered(created.worldPath);r.identity=(await this.cli('get_creation_capabilities')).identity;await this.step(r,'opened',async()=>({identity:r.identity,instructions:await this.instructions(r.identity)}));}
   if(!r.steps.reopened&&read(path.join(dir,'reopen-dispatched.json'))){
    if(r.failure&&!fs.existsSync(path.join(dir,'reopen-recovery-original-failure.json')))atomic(path.join(dir,'reopen-recovery-original-failure.json'),r.failure);
    r.reopenRecovery={at:new Date().toISOString(),mode:'observe-persisted-open-only',originalFailure:path.join(dir,'reopen-recovery-original-failure.json')};
    await this.step(r,'reopened',()=>this.completeReopen(r,name));
   }
   r.identity=r.steps.reopened?.value?.identity||r.steps.opened.value.identity;await this.fence(r.identity);
   const before=await this.step(r,'before',async()=>{const value=await this.stableScene(r.identity);r.initialViewport=value.observations;return value.scene;});
   const build=await this.step(r,'build',()=>this.job(r,'build',buildSource(r.case)));assert.equal(staticStale(build),0,'Build stale native static members');
   const pre=await this.step(r,'preRevision',()=>this.job(r,'pre-inspect',inspectSource(build.sceneName)));
   const signatureBefore=await this.step(r,'signatureBefore',()=>this.probe(r.identity,snapshotSource(build.sceneName,true)));
   const revision=await this.step(r,'revision',()=>this.job(r,'revision',revisionSource(r.case,build)));
   const signatureAfter=await this.step(r,'signatureAfter',()=>this.probe(r.identity,snapshotSource(build.sceneName,true)));assert.deepEqual(signatureAfter,signatureBefore,'Exact non-target native signature changed');
   const signatureSaved=await this.step(r,'signatureSaved',()=>this.probe(r.identity,snapshotSource(build.sceneName,false)));
   assert.deepEqual(revision.nativeSnapshot,pre.nativeSnapshot,'Revision changed a non-target native member');assert.equal(staticStale(revision),0);
   const source=await this.step(r,'source',()=>this.cli('world_files',{operation:'read',path:'creation/'+build.sceneName+'/source.lua',expectedIdentity:r.identity}));
   const revisionRequest=read(path.join(dir,'revision-request.json'));
   const dispatchedGenerator=revisionRequest?.code.match(/s:save\(\[([=]*)\[([\s\S]*?)\]\1\]\)/)?.[2];
   assert.equal(source.content,dispatchedGenerator||buildSource({...r.case,params:{...r.case.params,roofColor:'#aa594f'}}),'Saved generator differs from full revised design actually dispatched');
   const preSaveAfter=await this.step(r,'preSaveAfter',()=>this.cli('get_scene_info'));assertPreserved(before,preSaveAfter);
   await this.step(r,'docs',()=>this.docs(r,build));
   await this.step(r,'saved',async()=>{await this.fence(r.identity);const status=await this.status();assert.equal(status.worldPath,r.worldPath);const prior=read(path.join(dir,'save-result.json'));if(prior){assert(prior.completed&&prior.localOnly&&prior.status==='saved');return prior;}const marker=path.join(dir,'save-dispatched.json');assert(!read(marker),'Save response was lost; verify native/disk save evidence before recording saved phase, do not blindly repeat save');atomic(marker,{identity:r.identity,status,at:new Date().toISOString()});const save=await this.cli('run_command',{world:{operation:'save',expectedWorldPath:status.worldPath}});atomic(path.join(dir,'save-result.json'),save);assert(save.completed&&save.localOnly&&save.status==='saved');return save;});
   const reopened=await this.step(r,'reopened',()=>this.completeReopen(r,name));r.identity=reopened.identity;
   const preservedBefore=await this.step(r,'postReopenBefore',async()=>{const value=await this.stableScene(r.identity);r.baselineViewport=value.observations;return value.scene;});
   const reload=await this.step(r,'reopenInspect',async()=>{let observed;for(let attempt=0;attempt<8;attempt++){observed=await this.job(r,'reopen-inspect-'+attempt,inspectSource(build.sceneName));let equal=false;try{assert.deepEqual(observed.nativeSnapshot,revision.nativeSnapshot);equal=true;}catch{}if(staticStale(observed)===0&&equal)break;await sleep(700);}assert.equal(staticStale(observed),0,'Reopened static stale');assert.deepEqual(observed.nativeSnapshot,revision.nativeSnapshot,'Native signatures differ after reopen');return observed;});
   const equality=await this.step(r,'sourceEquality',async()=>{const value=await this.cli('world_files',{operation:'read',path:'creation/'+build.sceneName+'/source.lua',expectedIdentity:r.identity});assert.equal(value.content,source.content,'Reopened full source differs');return {passed:true,sha256:sha(value.content),bytes:Buffer.byteLength(value.content)};});
   const signatureReopened=await this.step(r,'signatureReopened',()=>this.probe(r.identity,snapshotSource(build.sceneName,false)));assert.deepEqual(signatureReopened,signatureSaved,'Exact native signature changed after reopen');
   const geometry=await this.step(r,'geometry',()=>this.probe(r.identity,geometrySource(build)));
   assert(geometry.passed,'Native geometry checks failed: '+JSON.stringify(geometry));
   const logic=await this.step(r,'logic',()=>this.logic(r,build.ports));
   const images={};for(const view of ['overview','entry'])images[view]=await this.step(r,'capture-'+view,()=>this.capture(r,view,build.cameras[view]));
   const after=await this.step(r,'after',()=>this.cli('get_scene_info'));
   const preservation=await this.step(r,'preservation',async()=>{assertPreserved(preservedBefore,after);return {passed:true,before:preservedBefore,after};});
   await this.step(r,'docsVerified',async()=>{const p='docs/changes.md',old=await this.cli('world_files',{operation:'read',path:p,expectedIdentity:r.identity});const label=this.author+'-R'+number+'-verification';const previous=managedSection(old.content)||'# Changes';const base=previous.split(/\r?\n/).filter(line=>!line.includes(label)).join('\n');const time=read(path.join(dir,'save-dispatched.json'))?.at||new Date().toISOString();const content=base+`\n\n- ${label} (${time}): Native local save completed, independent reopen changed session to ${r.identity.sessionId}. Exact revised full generator matched; native static signatures matched, input truth/reset/retrigger verified; fresh capture bytes retained. Visual/pixel review remains pending. Documentation persisted separately; this update does not mutate native scene blocks or mark visual approval.\n`;return this.cli('world_docs',{operation:'update',expectedIdentity:r.identity,files:[{path:p,expectedContent:old.content,content}]});});
   const report={number,case:r.case,identity:r.identity,worldPath:r.worldPath,status:'machinePassed',machinePassed:true,passed:false,visualReview:null,build,revision,reopen:reload,geometry,logic,images,sourceEquality:equality,nativeSignatures:{before:signatureBefore,after:signatureAfter,saved:signatureSaved,reopened:signatureReopened},nativeGeometryHash:sha(JSON.stringify(canonical(signatureReopened))),checks:{staticStale:staticStale(reload),nonTargetUnchanged:true,exactNativeSignature:true,sourceEquality:true,nativeGeometry:geometry.passed,playerCameraPreserved:preservation.passed},timings:Object.fromEntries(Object.entries(r.steps).map(([k,v])=>[k,v.ms])),httpCount:this.data.httpCount-r.httpStart,payloadBytes:this.data.payloadBytes-r.payloadStart,createdCells:build.total,start:r.start,end:new Date().toISOString(),before,after};
   report.viewportInitialization={initial:r.initialViewport,reopened:r.baselineViewport};report.rechecks=r.rechecks||[];report.geometryRechecks=r.geometryRechecks||[];report.unmodifiedBuildRetry=r.unmodifiedBuildRetry||null;report.jobTimings=r.jobTimings||{};report.reopenRecovery=r.reopenRecovery||null;
   resolveRecoveredFailures(r,report);
   atomic(path.join(dir,'report.json'),report);r.machinePassed=true;atomic(path.join(dir,'state.json'),r);this.data.rounds[number]={status:report.status,report:path.join(dir,'report.json')};this.persist();console.log(JSON.stringify({round:number,status:report.status,kind:r.case.kind,strategy:r.case.strategy,httpCount:report.httpCount,buildMs:report.timings.build}));return report;
  }catch(e){r.failure={at:new Date().toISOString(),stage:r.stage,error:e.stack||e.message};atomic(path.join(dir,'state.json'),r);atomic(path.join(dir,'failure.json'),r.failure);this.data.rounds[number]={status:'failed',stage:r.stage,error:e.message};this.persist();throw e;}
 }
}

function assertPreserved(before,after){for(const k of ['position','blockPosition','scaling'])assert.deepEqual(after.player[k],before.player[k],'Player '+k+' changed within one session');assert.deepEqual(after.camera,before.camera,'Main camera changed within one session');}
function snapshotSource(name,excludeRoof){return `local filename=i.worldPath.."creation/"..${lua(name)}.."/manifest.json";local f=ParaIO.open(filename,"r");assert(f and f:IsValid(),"manifest unavailable");local text=f:GetText(0,-1);f:close();local manifest=commonlib.Json.Decode(text);assert(manifest and manifest.cells and manifest.groups,"invalid manifest");local result={};for name,keys in pairs(manifest.groups)do if name~="logic"and name~="river_water"${excludeRoof?' and name~="west_roof"':''}then local rows={};for _,key in ipairs(keys)do local p=assert(manifest.cells[key]).position;local id,data=B:GetBlockFull(unpack(p));local entity=B:GetBlockEntityData(unpack(p));rows[#rows+1]=table.concat({p[1]-manifest.origin[1],p[2]-manifest.origin[2],p[3]-manifest.origin[3],id or 0,data or 0},",")..":"..(entity and commonlib.serialize_compact(entity,true)or "")end;table.sort(rows);result[name]=table.concat(rows,";")end end;return result;`;}
function geometrySource(build){return `local build=${lua({origin:build.origin,road:build.road,doorways:build.doorways,water:build.water,containment:build.containment,bridge:build.bridge,params:build.params})};local T=commonlib.gettable("MyCompany.Aries.Game.block_types");local result={passed=true,checks={},failures={}}
local function check(name,pass,p,id)result.checks[#result.checks+1]={name=name,passed=pass,position=p,id=id};if not pass then result.passed=false;result.failures[#result.failures+1]={name=name,position=p,id=id}end end
local function solid(p)local id=B:GetBlockId(unpack(p));local block=T.get(id);return block and block.solid and block.obstruction and not block.liquid or false,id end
local function air(p)local id=B:GetBlockId(unpack(p));return id==0,id end
local function slab(p)local id=B:GetBlockId(unpack(p));local data=B:GetBlockData(unpack(p));local block=T.get(id);local aabb=block and block.GetCollisionBoundingBoxFromPool and block:GetCollisionBoundingBoxFromPool(unpack(p));local bounds
if aabb then local ax,ay,az=aabb:GetMinValues();local bx,by,bz=aabb:GetMaxValues();local ox,oy,oz=B:real_min(unpack(p));local size=B.blocksize;bounds={min={(ax-ox)/size,(ay-oy)/size,(az-oz)/size},max={(bx-ox)/size,(by-oy)/size,(bz-oz)/size}}end
local pass=id==160 and data%16==0 and block and block.obstruction==true and not block.liquid and bounds~=nil
if pass then for j=1,3 do if math.abs(bounds.min[j])>0.00001 or math.abs(bounds.max[j]-(j==2 and 0.5 or 1))>0.00001 then pass=false end end end
result.slabApproaches=result.slabApproaches or {};result.slabApproaches[#result.slabApproaches+1]={position=p,id=id,data=data,bounds=bounds,passed=pass};return pass,id,pass and(p[2]-build.origin[2]+0.5)or nil end
for _,p in ipairs(build.road or {})do local q={unpack(p)};local lx,lz=q[1]-build.origin[1],q[3]-build.origin[3];local approach=build.params.river and lx>=18 and lx<18+build.params.streetWidth and(lz==5 or lz==9);if approach then q[2]=q[2]+1 end;local ok,id;if approach then ok,id=slab(q)else ok,id=solid(q)end;check(approach and "road-slab-support"or "road-support",ok,q,id);for dy=1,2 do local a={q[1],q[2]+dy,q[3]};local clear,bid=air(a);check("road-headroom",clear,a,bid)end end
if build.params.river then result.bridgeRouteTops={};for x=18,18+build.params.streetWidth-1 do local last;for z=4,10 do local approach=z==5 or z==9;local raised=approach or(z>=6 and z<=8);local p={build.origin[1]+x,build.origin[2]+(raised and 0 or -1),build.origin[3]+z};local top,id,ok;if approach then ok,id,top=slab(p)else ok,id=solid(p);local block=T.get(id);ok=ok and block:isNormalCube();top=p[2]-build.origin[2]+1 end;local expected=approach and 0.5 or(raised and 1 or 0);check("bridge-route-collision-top",ok and top~=nil and math.abs(top-expected)<0.00001,p,id);if last~=nil then check("bridge-route-rise-at-most-half",top~=nil and math.abs(top-last)<=0.50001,p,id)end;result.bridgeRouteTops[#result.bridgeRouteTops+1]={position=p,topMeters=top,expectedMeters=expected};last=top end end end
for _,d in ipairs(build.doorways or {})do for _,p in ipairs(d.clearance or {})do local id=B:GetBlockId(unpack(p));check("door-clearance",id==0 or id==233 or id==109,p,id)end;local p=d.position;check("door-open-lower",B:GetBlockId(unpack(p))==233,p,B:GetBlockId(unpack(p)));local top={p[1],p[2]+1,p[3]};check("door-open-upper",B:GetBlockId(unpack(top))==109,top,B:GetBlockId(unpack(top)))end
for _,p in ipairs(build.water or {})do local id=B:GetBlockId(unpack(p));check("river-water",id==75 or id==76,p,id)end
for _,p in ipairs(build.containment or {})do local ok,id=solid(p);check("river-containment-solid",ok,p,id)end
if build.water and #build.water>0 then local minx,minz,maxx,maxz=math.huge,math.huge,-math.huge,-math.huge;local y=build.water[1][2];local inside={};for _,p in ipairs(build.water)do minx=math.min(minx,p[1]);maxx=math.max(maxx,p[1]);minz=math.min(minz,p[3]);maxz=math.max(maxz,p[3]);inside[p[1]..","..p[3]]=true end;for x=minx-2,maxx+2 do for z=minz-2,maxz+2 do for dy=0,1 do if dy==1 or not inside[x..","..z]then local p={x,y+dy,z};local id=B:GetBlockId(unpack(p));check("river-outside-no-water",id~=75 and id~=76,p,id)end end end end end
for _,p in ipairs(build.bridge or {})do local ok,id=solid(p);check("bridge-support",ok,p,id);for dy=1,2 do local a={p[1],p[2]+dy,p[3]};local clear,bid=air(a);check("bridge-headroom",clear,a,bid)end end
return result;`;}

function logicSource(key,ports){return `local ports=${lua(ports)};local key=${lua(key)};assert(not _G[key],"owned probe already exists")
local a={active=true,done=false,result={tests={},releaseMs={}},index=1,phase=0};_G[key]=a
local kind=ports.kind;local sequences={};local n=#ports.inputs
if kind=="button"then for _=1,2 do sequences[#sequences+1]={1};sequences[#sequences+1]={0}end
elseif kind=="delay"then sequences={{0},{1},{0},{1},{0}}
else for cycle=1,2 do for state=0,2^n-1 do local row={};for j=1,n do row[j]=math.floor(state/2^(n-j))%2 end;sequences[#sequences+1]=row end;local reset={};for j=1,n do reset[j]=0 end;sequences[#sequences+1]=reset end end
local function outputs()local row={};for _,p in ipairs(ports.outputs)do row[#row+1]=B:GetBlockId(unpack(p))==207 and 1 or 0 end;return row end
local function expected(v)if kind=="and"then return v[1]*v[2]elseif kind=="or"then return math.max(v[1],v[2])elseif kind=="mixed"then return v[1]*math.max(v[2],v[3])else return v[1]end end
local function click(p)local b=B:GetBlock(unpack(p));assert(b and(b.id==190 or b.id==105));b:OnClick(p[1],p[2],p[3],"left")end
a.timer=commonlib.Timer:new({callbackFunc=function(t)local ok,err=pcall(function()
 local ident=C.World.Identity();assert(ident.worldPath==i.worldPath and ident.sessionId==i.sessionId,"probe world fence")
 local now=ParaGlobal.timeGetTime();local want=sequences[a.index]
 if not want then a.done=true;a.active=false;t:Change();return end
 if a.phase==0 then
  a.start=now;a.first={};a.trace={};a.want=want
  for j,p in ipairs(ports.inputs)do if kind=="button"then if want[j]==1 then click(p)end else local on=math.floor(B:GetBlockData(unpack(p))/8)%2;if on~=want[j]then click(p)end end end
  a.phase=1
 else
  local row=outputs();local elapsed=now-a.start;local target=expected(want)
  if kind=="delay"and a.index>1 then for j,state in ipairs(row)do if state==target and not a.first[j]then a.first[j]=elapsed end end;a.trace[#a.trace+1]={ms=elapsed,states=row}end
  if kind=="button"and want[1]==1 then if row[1]==1 then a.sawOn=true end;if a.sawOn and row[1]==0 and not a.released then a.released=elapsed end end
  local duration=kind=="delay"and 2600 or kind=="button"and(want[1]==1 and 1700 or 500)or 700
  if elapsed>=duration then
   local pass=true;if kind=="button"and want[1]==1 then pass=a.sawOn and a.released~=nil and row[1]==0;a.result.releaseMs[#a.result.releaseMs+1]=a.released;a.sawOn=nil;a.released=nil else for _,state in ipairs(row)do if state~=target then pass=false end end end
   a.result.tests[#a.result.tests+1]={inputs=want,expected=target,actual=row,pass=pass,firstMs=(kind=="delay"and a.index>1)and a.first or nil,trace=(kind=="delay"and a.index>1)and a.trace or nil}
   a.index=a.index+1;a.phase=0
  end
 end
end);if not ok then a.error=tostring(err);a.active=false;t:Change()end end});a.timer:Change(0,20);return {started=true,key=key};`;}

async function main(){const [port,out,...args]=process.argv.slice(2);assert(port&&out,'Usage: node script PORT OUTPUT --from N --to N | --recheck-captures N | --recheck-geometry N | --retry-unmodified-build N');const option=k=>{const i=args.indexOf(k);return i>=0?Number(args[i+1]):undefined;};const c=new Campaign(port,out);await c.init();const geometry=option('--recheck-geometry');if(geometry!==undefined){assert(Number.isInteger(geometry)&&geometry>=1&&geometry<=50);await c.recheckGeometry(geometry);return;}const retry=option('--retry-unmodified-build');if(retry!==undefined){assert(Number.isInteger(retry)&&retry>=1&&retry<=50);await c.retryUnmodifiedBuild(retry);return;}const recheck=option('--recheck-captures');if(recheck!==undefined){assert(Number.isInteger(recheck)&&recheck>=1&&recheck<=50);await c.recheckCaptures(recheck);return;}const from=option('--from')||1,to=option('--to')||50;assert(from>=1&&to<=50&&from<=to);for(let n=from;n<=to;n++)await c.round(n);}
if(require.main===module)main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
module.exports={Campaign,logicSource,geometrySource,snapshotSource,managedSection,resolveRecoveredFailures,lua};
