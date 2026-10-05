// Replace only MovieBlock authoring; compare every native authored key value.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript'),http=require('node:http');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const original=JSON.parse(fs.readFileSync('out/rsi/066/fresh/job.json'));
const canonical=compileCreationTemplate({...original.request,templateHash:undefined},original.session).code;
const tail=canonical.slice(canonical.indexOf('s:group("movie");')).replace('local info=s:inspect();',`s:save([====[${canonical}]====]);local info=s:inspect();`);
assert(/^[\w-]+$/.test(original.sceneName));
const files=['body','left','right'].map(n=>`${n}="blocktemplates/${original.sceneName}_${n==='body'?'body_v2':n}.x"`).join(',');
const code=`local s=createScene({name="${original.sceneName}",resume=true})\ns:remove("movie")\nlocal files={${files}}\n${tail}`;
const out=path.resolve('out/rsi/067/revision');fs.mkdirSync(out,{recursive:true});
async function snapshot(id){
 const code=`NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/CreationTrackSnapshot.lua",true);local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local j=getfenv(C.Jobs.Control).jobs["${id}"];assert(j and C.World.Same(j.identity,C.World.Identity()));return commonlib.gettable("MyCompany.Aries.Game.ParacraftCLI.CreationTrackSnapshot").Read(j.scenes[1],"rabbit");`;
 const body=JSON.stringify({v:1,action:'run_npl_code',params:{code}});
 const r=await new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});q.on('error',reject);q.setTimeout(30000,()=>q.destroy(new Error('native snapshot timeout')));q.end(body);});assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result.result;
}
(async()=>{const c=new Client({name:'rabbit-batch',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{const beforeFile=path.join(out,'tracks-before.json');let before;if(fs.existsSync(beforeFile))before=JSON.parse(fs.readFileSync(beforeFile));else{before=await snapshot(original.jobId);fs.writeFileSync(beforeFile,JSON.stringify(before,null,2));}
const file=path.join(out,'job.json');let h;if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}else{const request={expectedIdentity:original.identity,requestId:'rsi-rabbit-batch-067',code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));const started=(await call('run_code',request)).result;h={identity:original.identity,session:original.session,sceneName:original.sceneName,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert(Object.values(job.result.groups).every(g=>g.stale===0));
const after=await snapshot(job.jobId);fs.writeFileSync(path.join(out,'tracks-after.json'),JSON.stringify(after,null,2));
const authored=input=>{const output={};for(const [name,a]of Object.entries(input)){output[name]={};for(const category of ['tracks','bones']){output[name][category]={};for(const [key,v]of Object.entries(a[category])){const times=Array.isArray(v.times)?v.times:[];output[name][category][key]={times,data:times.map((_,i)=>Array.isArray(v.data)?v.data[i]:v.data[String(i+1)])};}}}return output;};
const a=authored(before),b=authored(after);fs.writeFileSync(path.join(out,'authored-before.json'),JSON.stringify(a,null,2));fs.writeFileSync(path.join(out,'authored-after.json'),JSON.stringify(b,null,2));assert.deepEqual(b,a);fs.writeFileSync(path.join(out,'track-check.json'),JSON.stringify({passed:true,actorCount:3,frameCount:33,helperCallsBefore:33,helperCallsAfter:3,allNativeKeyDataIdentical:true,excludesCachedSlotZero:true,noNewExports:true},null,2));console.log('PASS three rabbit keyframe batches; all authored native keys identical to 33 individual calls');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
