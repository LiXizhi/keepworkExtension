// Resume the known failed rabbit at its fixed origin; reuse all exported geometry.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const original=JSON.parse(fs.readFileSync('out/rsi/066/build/job.json'));
const canonical=compileCreationTemplate({...original.request,templateHash:undefined},original.session).code;
const marker='s:group("movie");';assert(canonical.includes(marker));assert(/^[\w-]+$/.test(original.sceneName));
const tail=canonical.slice(canonical.indexOf(marker)).replace('local info=s:inspect();',`s:save([====[${canonical}]====]);local info=s:inspect();`);
const files=['body','left','right'].map(n=>`${n}="blocktemplates/${original.sceneName}_${n}.x"`).join(',');
const code=`local s=createScene({name="${original.sceneName}",resume=true})\ns:remove("movie")\nlocal files={${files}}\n${tail}`;
const out=path.resolve('out/rsi/066/repaired');fs.mkdirSync(out,{recursive:true});
(async()=>{const c=new Client({name:'rabbit-repair',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{const file=path.join(out,'job.json');let h;if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}else{const request={expectedIdentity:original.identity,requestId:'rsi-rabbit-movie-repair-066',code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));const started=(await call('run_code',request)).result;h={identity:original.identity,session:original.session,sceneName:original.sceneName,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert(Object.values(job.result.groups).every(g=>g.stale===0));console.log('PASS fixed-origin rabbit MovieBlock repair; original mesh exports retained');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
