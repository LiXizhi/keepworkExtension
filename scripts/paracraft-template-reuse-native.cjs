// Validate a retained positive job and one missing-file dependency job; never rebuild on resume.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const out=path.resolve('out/rsi/056'),positive=JSON.parse(fs.readFileSync(path.join(out,'build/job.json')));
(async()=>{const c=new Client({name:'template-reuse-native',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params={})=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:positive.identity.clientId,chatSessionId:positive.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
 try{const info=await call('template_info',{template:'tabletop_lantern'});assert.equal(info.writesAssets,false);assert.deepEqual(Object.keys(info.assetSlots),['table','lantern']);
  const repeated=(await call('run_template',positive.request)).result;assert.equal(repeated.jobId,positive.jobId);
  const completed=(await call('code_job',{expectedIdentity:positive.identity,jobId:positive.jobId,resultDetail:'full'})).result;assert.equal(completed.state,'completed');assert(completed.created.every(s=>Object.keys(s.artifacts).length===0));
  const failedHandle=path.join(out,'missing-job.json');let handle;
  if(fs.existsSync(failedHandle)){handle=JSON.parse(fs.readFileSync(failedHandle));assert.deepEqual(handle.identity,positive.identity);}
  else{const request={...positive.request,templateHash:info.templateHash,saveSource:false,requestId:'rsi-missing-dependency-056',assets:{...positive.request.assets,lantern:'blocktemplates/missing_dependency_056.x'}};const started=(await call('run_template',request)).result;handle={identity:positive.identity,jobId:started.jobId,request};fs.writeFileSync(failedHandle,JSON.stringify(handle,null,2));}
  let failed=(await call('code_job',{expectedIdentity:positive.identity,jobId:handle.jobId,resultDetail:'full'})).result;const deadline=Date.now()+125000;while(failed.state==='running'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));failed=(await call('code_job',{expectedIdentity:positive.identity,jobId:handle.jobId,resultDetail:'full'})).result;}assert.equal(failed.state,'failed');assert.match(failed.error,/model file not found/);
  fs.writeFileSync(path.join(out,'missing-result.json'),JSON.stringify(failed,null,2));
  fs.writeFileSync(path.join(out,'reuse-report.json'),JSON.stringify({positiveJobId:completed.jobId,duplicateRecovered:true,missingJobId:failed.jobId,info,templateRequestBytes:Buffer.byteLength(JSON.stringify(positive.request)),templateSourceBytes:info.sourceBytes,reusedAssets:positive.request.assets,createdArtifacts:completed.created.map(s=>s.artifacts)},null,2));console.log('PASS fresh stdio asset-role template, duplicate recovery, no exports and missing-file rejection; verify native zero writes separately');
 }finally{await c.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
