// Execute one reviewed patch in the exact saved scene; persist its recovery handle.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [handle,sourceFile,outArg]=process.argv.slice(2);assert(handle&&sourceFile&&outArg,'Usage: JOB_HANDLE PATCH_LUA OUTPUT');
const original=JSON.parse(fs.readFileSync(handle));assert(/^[\w-]+$/.test(original.sceneName));
const source=fs.readFileSync(sourceFile,'utf8');assert(source.includes('name="birdbath_garden",resume=true'));
const code=source.replace('name="birdbath_garden",resume=true',`name="${original.sceneName}",resume=true`);
const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
(async()=>{const c=new Client({name:'scoped-revision',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{const caps=(await call('get_creation_capabilities',{})).result;assert.deepEqual(caps.identity,original.identity);
const file=path.join(out,'job.json');let h;
if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}
else{const requestFile=path.join(out,'request.json');let request;
 if(fs.existsSync(requestFile)){request=JSON.parse(fs.readFileSync(requestFile));assert.equal(request.code,code,'Pending recovery source changed');assert.deepEqual(request.expectedIdentity,original.identity);}
 else{request={expectedIdentity:original.identity,requestId:'scoped-'+path.basename(out)+'-'+Date.now(),code};fs.writeFileSync(requestFile,JSON.stringify(request,null,2));}
 const started=(await call('run_code',request)).result;h={identity:original.identity,session:original.session,sceneName:original.sceneName,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert.equal(job.result.name,original.sceneName);assert(Object.values(job.result.groups).every(g=>g.stale===0));console.log('PASS exact-world scoped revision; fixed scene, persisted job recovery and unchanged-member checks');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
