const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg,'Usage: node scripts/paracraft-job-summary-native.cjs NATIVE_JOB_JSON OUTPUT');
const saved=JSON.parse(fs.readFileSync(jobArg,'utf8')),out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('read timeout')));req.end(body);
 });assert(reply.ok&&reply.result.ok,JSON.stringify(reply));return reply;
}
(async()=>{
 const identity=(await native('get_creation_capabilities')).result.identity;assert.deepEqual(identity,saved.identity);
 const params={expectedIdentity:identity,jobId:saved.jobId};
 const before=await native('code_job',{...params,authoringSession:saved.session});assert.equal(before.result.state,'completed');
 const client=new Client({name:'job-summary-acceptance',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 try{
  const call=async(extra={})=>{
   const reply=await client.callTool({name:'paracraft_cli',arguments:{action:'code_job',clientId:identity.clientId,chatSessionId:saved.session,params:{...params,...extra}}});
   assert(!reply.isError,reply.content[0].text);return reply.content[0].text;
  };
  const summaryText=await call(),fullText=await call({resultDetail:'full'});
  const summary=JSON.parse(summaryText),full=JSON.parse(fullText);
  const {id: transportRequestId,...nativeEnvelope}=full;
  assert.deepEqual(nativeEnvelope,before,'Full MCP view differs from unchanged native HTTP result');
  assert.equal(summary.result.resultDetails.mode,'summary');
  const recovered=await client.callTool({name:'paracraft_cli',arguments:summary.result.resultDetails.full});
  assert(!recovered.isError,recovered.content[0].text);
  assert.deepEqual(JSON.parse(recovered.content[0].text).result,full.result,'Returned recovery call lost job identity or ownership');
  const actors=full.result.result.animation.actors,omitted=summary.result.resultDetails.omitted;
  assert.equal(omitted.length,actors.filter(a=>a.rotationKeys?.length).length);
  for(let i=0;i<actors.length;i++){
   const {rotationKeys,...fields}=actors[i];assert.deepEqual(summary.result.result.animation.actors[i],fields);
   assert.equal(omitted[i].count,rotationKeys.length);
  }
  for(const key of ['jobId','identity','state','site','created','error','output','sourceCompleted','runtimeActive','startedAt','finishedAt'])assert.deepEqual(summary.result[key],full.result[key]);
  assert.deepEqual(summary.result.result.files,full.result.result.files);assert.deepEqual(summary.result.result.groups,full.result.result.groups);
  const after=await native('code_job',{...params,authoringSession:saved.session});assert.deepEqual(after,before,'Read projection mutated native job');
  const summaryBytes=Buffer.byteLength(summaryText),fullBytes=Buffer.byteLength(fullText);
  assert(summaryBytes<fullBytes/2,'Real dense result did not shrink enough');
  const report={identity,jobId:saved.jobId,summaryBytes,fullBytes,reductionPercent:100*(1-summaryBytes/fullBytes),omittedArrays:omitted.length,
   omittedKeys:omitted.reduce((n,a)=>n+a.count,0),fullMatchesNative:true,jobUnchanged:true,mutationsSubmitted:0};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'summary.json'),summaryText);console.log('PASS stdio/native HTTP: compact view and exact full recovery without mutation');console.log(report);
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
