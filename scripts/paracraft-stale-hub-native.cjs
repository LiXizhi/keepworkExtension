// Observe an existing native job through fresh stdio with a stale discovery record.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg);const job=JSON.parse(fs.readFileSync(jobArg)),out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});assert(job.state==='completed');
const bootstrap=`const fs=require('node:fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);const c=require('./src/core/config.ts');c.readInstance=()=>({pid:2147483647,port:1});require('./src/mcp/stdio.ts').startStdioServer({port:8089,root:process.cwd()});`;
(async()=>{
 const c=new Client({name:'stale-hub-native',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['-e',bootstrap],cwd:path.resolve(__dirname,'..')}));
 const call=async(action,params={})=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:job.identity.clientId,chatSessionId:job.authoringSession,params}});assert(!r.isError,r.content[0]?.text);return r;};
 try{
  const view=async()=>JSON.parse((await call('get_scene_info')).content[0].text).result;
  const before=await view(),status=JSON.parse((await call('code_job',{expectedIdentity:job.identity,jobId:job.jobId,resultDetail:'full'})).content[0].text).result;assert.equal(status.jobId,job.jobId);assert.equal(status.state,'completed');
  const r=await call('camera_capture',{expectedIdentity:job.identity,...job.result.detail});const image=r.content.find(x=>x.type==='image'),metadata=JSON.parse(r.content[0].text);assert(image&&metadata.sessionId===job.identity.sessionId);fs.writeFileSync(path.join(out,'detail.jpg'),Buffer.from(image.data,'base64'));
  const after=await view();assert.deepEqual(after.player,before.player);assert.deepEqual(after.camera,before.camera);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity:job.identity,jobId:status.jobId,state:status.state,stalePid:2147483647,stalePort:1,configuredPort:8089,metadata,playerUnchanged:true,cameraUnchanged:true},null,2));console.log('PASS stale discovery ignored: same native job and fresh MCP image, no mutation replay');
 }finally{await c.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
