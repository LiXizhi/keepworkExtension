const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [worldPath,outArg,paletteArg,templateArg,existingJobArg,mode]=process.argv.slice(2);
assert(mode===undefined||mode==='asset-only');
const template=templateArg||'bird';
assert(worldPath&&outArg,'Usage: node scripts/paracraft-template-mcp-native.cjs EXACT_DISPOSABLE_WORLD OUTPUT');
const out=path.resolve(outArg),session='rsi-template-native';
(async()=>{
 const client=new Client({name:'template-native-acceptance',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']});
 await client.connect(transport);let clientId;
 const raw=async(action,params={})=>{
  // Dense native authoring can briefly expire the hub heartbeat. Recover reads
  // against the original job; never submit another creation to recover a poll.
  for(let attempt=0;attempt<6;attempt++){
   const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId,chatSessionId:session,params}});
   const error=r.content.find(c=>c.type==='text')?.text;
   if(r.isError&&/client gone/.test(error||'')&&['code_job','camera_capture','get_creation_capabilities','clients'].includes(action)&&attempt<5){
    await new Promise(resolve=>setTimeout(resolve,1000));continue;
   }
   assert(!r.isError,error);return r;
  }
 };
 const call=async(action,params)=>JSON.parse((await raw(action,params)).content.find(c=>c.type==='text').text);
 try{
  const listed=(await client.listTools()).tools.filter(t=>t.name.startsWith('paracraft_'));
  assert.deepEqual(listed.map(t=>t.name),['paracraft_cli']);
  const clients=await call('clients');const selected=clients.clients.find(c=>c.worldPath===worldPath&&c.worldEntered);
  assert(selected,'Exact disposable world not connected');clientId=selected.clientId;
  const caps=await call('get_creation_capabilities');const identity=caps.result.identity;
  assert.equal(identity.worldPath,worldPath);
  let info=null,currentTemplateError;
  if(existingJobArg){try{info=await call('template_info',{template});}catch(e){currentTemplateError=e.message;}}
  else{info=await call('template_info',{template});assert(info.sourceBytes>1000);assert(!info.content);}
  fs.mkdirSync(out,{recursive:true});
  let first,jobId,duplicateRecovered=false,originalInfo,originalRequest,templateMetadata;
  if(existingJobArg){
   const saved=JSON.parse(fs.readFileSync(existingJobArg,'utf8'));
   assert.deepEqual(saved.identity||saved.expectedIdentity,identity,'Existing job belongs to another world session');
   assert.equal(saved.session,session,'Existing job belongs to another authoring session');
   if(saved.request)assert.equal(saved.request.template,template,'Existing job belongs to another template');
   else if(saved.requestId)assert.equal(saved.template,template,'Existing request belongs to another template');
   originalInfo=saved.templateInfo||null;originalRequest=saved.request||(!saved.jobId?saved:null);templateMetadata=saved.jobId?(saved.template||null):null;
   assert(saved.jobId||saved.requestId,'Existing handle has neither jobId nor requestId');
   first=await call('code_job',{expectedIdentity:identity,...(saved.jobId?{jobId:saved.jobId}:{requestId:saved.requestId})});jobId=first.result.jobId;
   if(saved.sceneName&&first.result.result)assert.equal(first.result.result.name,saved.sceneName,'Existing scene identity changed');
  }else{
   const params={template,templateHash:info.templateHash,expectedIdentity:identity,requestId:'template-'+Date.now(),saveSource:true,...(paletteArg?{palette:JSON.parse(paletteArg)}:{})};
   originalInfo=info;originalRequest=params;
   fs.writeFileSync(path.join(out,'request.json'),JSON.stringify({identity,session,...params},null,2));
   first=await call('run_template',params);jobId=first.result.jobId;
   templateMetadata=first.result.template;
   fs.writeFileSync(path.join(out,'job.json'),JSON.stringify({identity,session,sceneName:first.result.template.sceneName,jobId,request:params,templateInfo:info,template:templateMetadata},null,2));
   const duplicate=await call('run_template',params);assert.equal(duplicate.result.jobId,jobId,'Retry repeated mutation');duplicateRecovered=true;
  }
  let job=first.result;const deadline=Date.now()+125000;
  while(job.state==='running'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));job=(await call('code_job',{expectedIdentity:identity,jobId})).result;}
  assert.equal(job.state,'completed',job.error||'native job incomplete');
  fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));
  if(!existingJobArg)assert.equal(job.result.name,first.result.template.sceneName);
  const images=[];
  const views=job.result.animation?(job.result.animation.times||[0.25,0.75]).map(t=>({name:'pose-'+t,params:{...(job.result.portrait||job.result.detail),moviePosition:job.result.animation.moviePosition,timeSeconds:t}})):
    ['overview','detail'].map(view=>({name:view,params:job.result[view]}));
  for(const view of mode==='asset-only'?[]:views){
   const r=await raw('camera_capture',{expectedIdentity:identity,...view.params});
   const pixels=r.content.find(c=>c.type==='image'),metadata=JSON.parse(r.content.find(c=>c.type==='text').text);
   assert(pixels&&metadata.sessionId===identity.sessionId);assert.equal(metadata.base64,undefined);
   const file=path.join(out,'mcp-'+view.name+'.jpg');fs.writeFileSync(file,Buffer.from(pixels.data,'base64'));
   images.push({file,view:view.name,metadata});
  }
  fs.writeFileSync(path.join(out,'mcp-report.json'),JSON.stringify({identity,templateInfo:originalInfo,currentTemplateInfo:info,currentTemplateError,originalRequest,templateMetadata,jobId,existingJob:!!existingJobArg,duplicateRecovered,result:job.result,images,worldCaptureSkipped:mode==='asset-only'},null,2));
  console.log(mode==='asset-only'?'PASS stdio MCP job completion; world image capture explicitly skipped':existingJobArg?'PASS stdio MCP existing job: singleton hub, native job and fresh MCP images':'PASS stdio MCP template: singleton hub, auto site, duplicate recovery, native job and MCP images');
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
