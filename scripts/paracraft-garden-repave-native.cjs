// A scoped native revision: preserve fixtures, origin and first-soil snapshots.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const original=JSON.parse(fs.readFileSync('out/rsi/070/request.json'));
assert.equal(original.request.template,'birdbath_garden');assert(/^[\w-]+$/.test(original.sceneName));
const canonical=compileCreationTemplate({...original.request,templateHash:undefined},original.session).code.replaceAll('blockId="StoneBrick"','blockId="Oak_Wood_Planks"');
const resultTail=canonical.slice(canonical.indexOf('local info=s:inspect();')).replace('decorativeWater=true,','decorativeWater=true,revision={fixedOrigin=true,soilBackupsUnchanged=true,unrelatedMembersUnchanged=true,changedFloorCells=16,material="Oak_Wood_Planks"},');
const code=`local s=createScene({name="${original.sceneName}",resume=true})
local origin=commonlib.deepcopy(s.origin);local untouched,soil={},{}
for key,m in pairs(s.cells)do
 if m.group=="ground" then soil[key]=s.world:Fingerprint(m.original)
 else untouched[key]=s.world:Fingerprint(s.world:Snapshot(m.position)) end
end
s:group("ground")
s:surface({position={2,0,0},dimensions={2,1,7},blockId="Oak_Wood_Planks"})
s:surface({position={4,0,4},dimensions={2,1,1},blockId="Oak_Wood_Planks"})
for key,fingerprint in pairs(soil)do assert(s.world:Fingerprint(s.cells[key].original)==fingerprint,"soil backup changed")end
for key,fingerprint in pairs(untouched)do assert(s.world:Fingerprint(s.world:Snapshot(s.cells[key].position))==fingerprint,"unrelated member changed")end
for i=1,3 do assert(s.origin[i]==origin[i],"origin moved")end
s:save([====[${canonical}]====]);wait(1)
local benchFile="${original.request.assets.bench}";local bathFile="${original.request.assets.bath}"
local bench,bath={},{ }
${resultTail}`;
const out=path.resolve('out/rsi/071/revision-fixed');fs.mkdirSync(out,{recursive:true});
(async()=>{const c=new Client({name:'garden-repave',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const call=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{const file=path.join(out,'job.json');let h;
if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}
else{const request={expectedIdentity:original.identity,requestId:'rsi-garden-repave-fixed-071',code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));const started=(await call('run_code',request)).result;h={identity:original.identity,session:original.session,sceneName:original.sceneName,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert(Object.values(job.result.groups).every(g=>g.stale===0));assert(job.result.revision.soilBackupsUnchanged);assert(job.result.revision.unrelatedMembersUnchanged);console.log('PASS scoped repaving, stable origin/fixtures/first-soil backups and full updated generator');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
