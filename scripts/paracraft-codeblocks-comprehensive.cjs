// Additional native acceptance: isolated templates, stale events, stress and persistence.
// Uses only a disposable world; writes evidence outside the world.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate,creationTemplateInfo}=require('../src/mcp/paracraftTemplates.ts');
const [port,worldPath,output]=process.argv.slice(2);
assert(port&&worldPath&&output&&/\/CreationAcceptance_CodeBlocks_[^/]+\/$/.test(worldPath),'Disposable world, port and output required');
const out=path.resolve(output);fs.mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),lua=JSON.stringify,checks=[],metrics={calls:0,requestBytes:0,responseBytes:0};
const save=(file,data)=>fs.writeFileSync(path.join(out,file),JSON.stringify(data,null,2));
let identity;const owned=[];
async function cli(action,params={}){
 const body=JSON.stringify({action,params});metrics.calls++;metrics.requestBytes+=Buffer.byteLength(body);
 const r=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:Number(port),path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let s='';res.setEncoding('utf8');res.on('data',c=>s+=c);res.on('end',()=>{metrics.responseBytes+=Buffer.byteLength(s);try{resolve(JSON.parse(s));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('Native timeout')));req.end(body);});
 assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result;
}
async function until(fn,test,seconds=10){const deadline=Date.now()+seconds*1000;let v;do{v=await fn();if(test(v))return v;await sleep(400);}while(Date.now()<deadline);throw Error('Observation timeout: '+JSON.stringify(v));}
const probe=async code=>(await cli('run_npl_code',{code:`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local i=C.World.Identity();assert(i.worldPath==${lua(worldPath)} and i.sessionId==${identity.sessionId});local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");`+code})).result;
const pos=p=>'{'+p.join(',')+'}',block=(r,id)=>`E.GetBlockEntity(unpack(${pos(r.stations[id].code)}))`;
const actor=(r,id)=>`${block(r,id)}:GetCodeBlock():GetActor()`;
const toggle=(r,id)=>`do local p=${pos(r.stations[id].lever)};B:GetBlock(unpack(p)):OnClick(p[1],p[2],p[3],"left") end;`;
const state=r=>probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${lua(r.stateKey)});return g and {phase=g.phase,epoch=g.epoch,score=g.score};`);
function check(name,value){checks.push({name,passed:!!value});save('checks.json',checks);assert(value,name);}
async function instructions(){for(const file of ['AGENTS.md','docs/README.md']){const r=await cli('world_files',{operation:'read',path:file,expectedIdentity:identity});assert(typeof r.content==='string');}}
async function build(requestId){
 const input={template:'codeblock_playground',requestId,expectedIdentity:identity,saveSource:true};
 const compiled=compileCreationTemplate(input,'codeblocks-comprehensive');
 save(requestId+'-template.json',{...compiled.metadata,sourceBytes:Buffer.byteLength(compiled.code),modelRequestBytes:Buffer.byteLength(JSON.stringify({action:'run_template',params:input}))});
 const params={expectedIdentity:identity,authoringSession:'codeblocks-comprehensive',requestId,code:compiled.code};
 const handle=await cli('run_code',params);
 const result=await until(()=>cli('code_job',{expectedIdentity:identity,authoringSession:'codeblocks-comprehensive',jobId:handle.jobId}),r=>r.state!=='running',130);
 assert.equal(result.state,'completed',result.error);save(requestId+'-build.json',result);
 const retry=await cli('run_code',params);check(requestId+' request retry returns same job',retry.jobId===handle.jobId);
 owned.push(result.result);return result.result;
}
async function snapshot(rs){
 const rows=await probe('local rows={};'+rs.map(r=>Object.keys(r.stations).map(id=>`do local e=${block(r,id)};local m=e:FindNearByMovieEntity();local p=${pos(r.stations[id].lever)};rows[#rows+1]={code=e:GetCommand(),movie=m and {m:GetBlockPos()},actors=m and m:GetAllActorData(),lever=B:GetBlockId(unpack(p)),powered=e:IsPowered()==true} end;`).join('')).join('')+'return rows;');
 return rows.map(row=>({...row,code:crypto.createHash('sha256').update(row.code).digest('hex')}));
}
async function main(){
 identity=(await cli('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);await instructions();
 for(const request of ['game-a','game-b']){const file=path.join(out,request+'-build.json');if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(old.identity,identity,'Results belong to an earlier world session; inspect the saved report or use a fresh output directory for a new test');}}
 const before=await cli('get_scene_info');
 const a=await build('game-a'),b=await build('game-b');
 check('template metadata advertises exported asset',creationTemplateInfo('codeblock_playground').assetCount===1);
 check('two templates have isolated names, state and mesh paths',a.name!==b.name&&a.stateKey!==b.stateKey&&a.model!==b.model);
 for(const r of [a,b]){await probe(r.startOrder.map(id=>`if ${block(r,id)}:IsPowered() then ${toggle(r,id)} end;`).join('')+'return true;');await sleep(300);for(const id of r.startOrder){await probe(toggle(r,id)+'return true;');await until(()=>probe(`local c=${block(r,id)}:GetCodeBlock();return c and c:IsLoaded() and c:GetActor()~=nil;`),Boolean);}await probe(`${actor(r,'host')}:OnClick("left");return true;`);await until(()=>state(r),g=>g.phase==='running');}
 await probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${lua(a.stateKey)});for _,v in ipairs(${block(a,'tokens')}:GetCodeBlock():GetActors())do if v:GetActorValue("tokenId")==2 then v:SetActorValue("roundEpoch",g.epoch-1);v:OnClick("left");end end;return true;`);
 await sleep(200); // OnClick queues the coroutine; do not restore its epoch before dispatch.
 check('stale round click is ignored',(await state(a)).score===0);
 await probe(`for _,v in ipairs(${block(a,'tokens')}:GetCodeBlock():GetActors())do if v:GetActorValue("tokenId")==1 then for n=1,200 do v:OnClick("left") end end end;return true;`);
 await until(()=>state(a),g=>g.score===1);check('200 native clicks score exactly once',(await state(a)).score===1);
 check('simultaneous second game score remains independent',(await state(b)).score===0);
 const text=fs.readFileSync(path.resolve(__dirname,'../skills/paracraft-create/references/codeblock-patterns.md'),'utf8');
 const rules=text.match(/```lua\r?\n(local function hasLine[\s\S]*?)\r?\n```/)[1];
 const board=await probe(rules+`\nlocal count=0;for _,d in ipairs({{1,0},{0,1},{1,1},{1,-1}})do local b={};for k=-2,2 do b[(4+d[1]*k)..","..(4+d[2]*k)]=1 end;assert(hasLine(b,4,4,1,5));count=count+1;b[(4+d[1])..","..(4+d[2])]=nil;assert(not hasLine(b,4,4,1,5));count=count+1;b[(4+d[1])..","..(4+d[2])]=2;assert(not hasLine(b,4,4,1,5));count=count+1;end;return count;`);
 check('board rules: four directions, gaps and opponent blocking',board===12);
 await probe([a,b].map(r=>['host','tokens','npc'].map(id=>toggle(r,id)).join('')).join('')+'return true;');await sleep(400);
 const nativeBefore=await snapshot([a,b]);save('native-before.json',nativeBefore);check('six controllers stopped before persistence',nativeBefore.every(r=>!r.powered));
 const files={},assets={};for(const r of [a,b]){assets[r.model]=crypto.createHash('sha256').update(fs.readFileSync(path.join(worldPath,r.model))).digest('hex');for(const f of [`creation/${r.name}/source.lua`,`creation/${r.name}/manifest.json`]){const q=await cli('world_files',{operation:'read',path:f,expectedIdentity:identity});assert(q.content);files[f]=crypto.createHash('sha256').update(q.content).digest('hex');}}
 const saved=await cli('run_command',{world:{operation:'save',expectedWorldPath:worldPath}});check('native local save completed',saved.status==='saved'&&saved.completed&&saved.localOnly);
 const oldIdentity=identity;await cli('run_command',{world:{operation:'open',name:path.basename(worldPath.slice(0,-1)),expectedWorldPath:worldPath,confirmSwitch:true}});
 identity=await until(async()=>{const status=await cli('run_command',{world:{operation:'status'}});if(!status.worldEntered||status.worldPath!==worldPath)return null;return (await cli('get_creation_capabilities')).identity;},i=>i&&i.worldPath===worldPath&&i.sessionId!==oldIdentity.sessionId,45);
 await instructions();check('reopen refreshes world identity',identity.sessionId!==oldIdentity.sessionId);
 const nativeAfter=await until(()=>snapshot([a,b]),r=>r.length===6&&r.every(v=>v.movie&&v.actors),20);
 save('native-after.json',nativeAfter);
 // Native movie reload fills default character skin even on self-colored .x meshes.
 // These templates do not use skin; compare their meaningful persistent fields.
 const comparable=rows=>rows.map(r=>({...r,actors:r.actors.map(({skin,...actor})=>actor)}));
 check('saved code hashes, movie assets/scales and levers survive reopen',JSON.stringify(comparable(nativeBefore))===JSON.stringify(comparable(nativeAfter)));
 for(const [f,hash]of Object.entries(files)){const q=await cli('world_files',{operation:'read',path:f,expectedIdentity:identity});assert.equal(crypto.createHash('sha256').update(q.content).digest('hex'),hash);}
 check('editable source and manifests survive reopen',true);
 for(const [f,hash]of Object.entries(assets))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(worldPath,f))).digest('hex'),hash);
 check('exported mesh bytes survive reopen',true);
 for(const r of [a,b]){for(const id of ['tokens','host']){await probe(toggle(r,id)+'return true;');await until(()=>probe(`local c=${block(r,id)}:GetCodeBlock();return c and c:IsLoaded() and c:GetActor()~=nil;`),Boolean);}await probe(`${actor(r,'host')}:OnClick("left");return true;`);await until(()=>state(r),g=>g.phase==='running');}
 check('both reopened games can start with fresh actors',true);
 await probe([a,b].map(r=>['host','tokens'].map(id=>toggle(r,id)).join('')).join('')+'return true;');await sleep(400);
 const after=await cli('get_scene_info');check('player position survives creation and reopen',JSON.stringify(before.player.blockPosition)===JSON.stringify(after.player.blockPosition));
 const capture=await cli('camera_capture',{expectedIdentity:identity,authoringSession:'codeblocks-comprehensive',eye:a.eye,lookat:a.lookat});if(capture.base64)fs.writeFileSync(path.join(out,'reopened.jpg'),Buffer.from(capture.base64,'base64'));
 const log=await cli('tail_log',{lines:10});
 const old=await cli('world_files',{operation:'read',path:'docs/changes.md',expectedIdentity:identity});
 const updated=await cli('world_docs',{operation:'update',expectedIdentity:identity,files:[{path:'docs/changes.md',expectedContent:old.content,content:`# CodeBlock comprehensive acceptance\n${checks.length} checks passed. Two isolated templates: ${a.name}, ${b.name}.\nNative world saved and reopened; source, manifests, code hashes, movie actors and levers verified. Reopened gameplay passed; controllers stopped. OS screen picking not tested.\n`}]});assert(updated.files.every(f=>['updated','unchanged'].includes(f.status)));
 save('report.json',{identity,checks,metrics,files,assets,nativeBefore,nativeAfter,log,templates:[a,b]});console.log(JSON.stringify({passed:checks.length,identity,metrics,output:out}));
}
main().catch(async e=>{save('failure.json',{error:String(e),identity,checks,metrics});try{const current=(await cli('get_creation_capabilities')).identity;if(current.worldPath===worldPath){identity=current;await probe(owned.map(r=>r.startOrder.map(id=>`if ${block(r,id)}:IsPowered() then ${toggle(r,id)} end;`).join('')).join('')+'return true;');}}catch(cleanup){save('cleanup-error.json',{error:String(cleanup)});}console.error(e);process.exitCode=1;});

