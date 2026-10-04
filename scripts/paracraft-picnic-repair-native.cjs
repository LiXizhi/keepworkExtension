const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
(async()=>{
 const [inputArg='out/rsi/043/job.json',outArg='out/rsi/043']=process.argv.slice(2);const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
 const saved=JSON.parse(fs.readFileSync(inputArg)),input={...saved.request};delete input.templateHash;
 const canonical=compileCreationTemplate(input,saved.session).code;
 const code=canonical.replace(/createScene\((\{[^\n]+)\}\)/,'createScene($1,resume=true})')
 .replace(/(local s=createScene[^\n]+\n)/,'$1s:remove("table");s:remove("ground");\n')
 .replace('local info=s:inspect()',`s:save([====[${canonical}]====]);local info=s:inspect()`);
 assert(code.includes('resume=true')&&code.includes('s:remove("table")'));
 const c=new Client({name:'picnic-repair',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:saved.identity.clientId,chatSessionId:saved.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text).result;};
 try{
  const file=path.join(out,'repaired-job-final.json');let handle;
  if(fs.existsSync(file))handle=JSON.parse(fs.readFileSync(file));else{const requestId='picnic-component-repair-'+Date.now();const first=await call('run_code',{expectedIdentity:saved.identity,requestId,code});handle={identity:saved.identity,session:saved.session,jobId:first.jobId,requestId};fs.writeFileSync(file,JSON.stringify(handle,null,2));}
  let job;for(let i=0;i<180;i++){job=await call('code_job',{expectedIdentity:saved.identity,jobId:handle.jobId,resultDetail:'full'});if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
  fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);console.log('PASS picnic repair completed preserving original construction origin');
 }finally{await c.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
