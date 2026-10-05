// Correct measured design metadata/source without rebuilding or exporting geometry.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const original=JSON.parse(fs.readFileSync('out/rsi/061/build-corrected/job.json')),old=JSON.parse(fs.readFileSync('out/rsi/061/build-corrected/latest-job.json'));
const out=path.resolve('out/rsi/061/metadata-corrected');fs.mkdirSync(out,{recursive:true});
const canonical=compileCreationTemplate({...original.request,templateHash:undefined},original.session).code;
const vec=v=>'{'+v.map(n=>{assert(Number.isFinite(n));return n;}).join(',')+'}';
const code=`local s=createScene({name="${original.sceneName}",dimensions={7,3,6},terrainDepth=1,resume=true})
s.source=[====[${canonical}]====];s:save()
local info=s:inspect();local groups={};for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,prop={filename="${old.result.prop.filename}",expectedMeters={1.5,0.9375,0.46875},seatMeters=0.4375},overview={eye=${vec(old.result.overview.eye)},lookat=${vec(old.result.overview.lookat)}},detail={eye=${vec(old.result.detail.eye)},lookat=${vec(old.result.detail.lookat)}}}`;
(async()=>{const c=new Client({name:'bench-metadata',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{const file=path.join(out,'job.json');let h;if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}else{const request={expectedIdentity:original.identity,requestId:'rsi-bench-metadata-corrected-061',code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));const started=(await call('run_code',request)).result;h={identity:original.identity,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert.deepEqual(job.result.origin,old.result.origin);assert(Object.values(job.result.groups).every(g=>g.stale===0));assert.equal(Object.keys(job.artifacts||{}).length,0);console.log('PASS bench metadata/source correction; fixed origin, no geometry rebuild or export');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
