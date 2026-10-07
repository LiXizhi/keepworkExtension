// Second pass: new input path, interrupted playback, native persistence and replay.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const h=require('./paracraft-engine-games-native.cjs');
const [,worldPath,out,buildFile]=process.argv.slice(2);assert(buildFile,'Pass original build.json after OUTPUT');
const checks=[],save=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2));
const check=(name,v)=>{checks.push({name,passed:!!v});save('checks.json',checks);assert(v,name);console.log('PASS '+name);};
const pos=p=>'{'+p.join(',')+'}',lua=JSON.stringify;
const block=id=>`E.GetBlockEntity(unpack(${pos(h.scene.stations[id].code)}))`;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function snapshot(){const rows={};for(const id of Object.keys(h.scene.stations)){rows[id]=await h.probe(`local e=${block(id)};local m=e:FindNearByMovieEntity();return {code=e:GetCommand(),movie=m and {m:GetBlockPos()},actors=m and m:GetAllActorData(),leverData=B:GetBlockData(unpack(${pos(h.scene.stations[id].lever)}))};`);rows[id].code=hash(rows[id].code);for(const a of rows[id].actors||[])delete a.skin;}return rows;}
async function main(){
 await h.loadExisting(buildFile);const r=h.scene;
 for(const id of Object.keys(r.stations))await h.power(id,false);
 const canonical=fs.readFileSync(path.resolve(__dirname,'../skills/paracraft-create/examples/engine-games.lua'),'utf8');
 const keyboard=canonical.match(/if kind=="lanes" then\n    for i=1,3 do[\s\S]*?\nend\n/)[0];
 const id=r.games.lanes.host,old=await h.source(id);
 if(!old.includes('registerKeyPressedEvent'))await h.edit(id,old.replace('registerClickEvent(function()requested=true end);','registerClickEvent(function()requested=true end);\n'+keyboard).replace('点击车道避障','按 1/2/3 或点击车道'));
 for(const k of ['lanes','sequence']){await h.power(r.games[k].inputs,true);await h.power(r.games[k].host,true);await h.start(k);}
 await h.probe('local cg=GameLogic.GetCodeGlobal();cg:BroadcastKeyPressedEvent(cg:GetKeyNameFromString("3"));return true;');
 await h.until(()=>h.state('lanes'),g=>g.lane===3);check('native keyboard dispatcher selects lane 3',true);
 await h.probe('local cg=GameLogic.GetCodeGlobal();cg:BroadcastKeyPressedEvent(cg:GetKeyNameFromString("1"));return true;');
 await h.until(()=>h.state('lanes'),g=>g.lane===1);check('native keyboard dispatcher selects lane 1',true);
 await h.capture('lanes','keyboard-lanes.jpg');
 for(const [id,step]of [[2,1],[1,2],[3,3]]){await h.hit('sequence',id);await h.until(()=>h.state('sequence'),g=>g.step===step);}
 await h.sleep(170);await h.start('sequence');
 const position=()=>h.probe(`return {${block(r.games.sequence.host)}:GetCodeBlock():GetActor():GetPosition()};`);
 const reset=await position();await h.sleep(1200);const later=await position();check('mid-animation reset kills playback timer without later drift',JSON.stringify(reset)===JSON.stringify(later));
 for(const id of Object.keys(r.stations))await h.power(id,false);
 const before=await snapshot();save('before.json',before);
 const sourcePath=`creation/${r.name}/source.lua`;const prior=await h.cli('world_files',{operation:'read',path:sourcePath,expectedIdentity:h.identity});
 await h.cli('world_files',{operation:'write',path:sourcePath,expectedIdentity:h.identity,expectedContent:prior.content,content:canonical});
 const mesh=hash(fs.readFileSync(path.join(worldPath,r.model)));
 const oldIdentity=h.identity;
 const saved=await h.cli('run_command',{world:{operation:'save',expectedWorldPath:worldPath}});check('native dedicated test world saves',saved.status==='saved'&&saved.completed&&saved.localOnly);
 await h.cli('run_command',{world:{operation:'open',name:path.basename(worldPath.slice(0,-1)),expectedWorldPath:worldPath,confirmSwitch:true}});
 await h.until(async()=>{const s=await h.cli('run_command',{world:{operation:'status'}});if(!s.worldEntered||s.worldPath!==worldPath)return false;return (await h.cli('get_creation_capabilities')).identity.sessionId!==oldIdentity.sessionId;},Boolean,40);
 await h.loadExisting(buildFile);check('reopen has fresh world session',h.identity.sessionId!==oldIdentity.sessionId);
 const after=await snapshot();save('after.json',after);check('six source hashes, actor tracks and levers survive reopen',JSON.stringify(before)===JSON.stringify(after));
 check('world-local character mesh bytes survive reopen',mesh===hash(fs.readFileSync(path.join(worldPath,r.model))));
 const persisted=await h.cli('world_files',{operation:'read',path:sourcePath,expectedIdentity:h.identity});check('revised generator source survives reopen',persisted.content===canonical);
 for(const k of Object.keys(r.games)){await h.power(r.games[k].inputs,true);await h.power(r.games[k].host,true);await h.start(k);check(k+' restarts after disk reload',(await h.state(k)).phase==='running');}
 for(const id of [2,1,3]){await h.hit('sequence',id);await h.sleep(180);}check('reopened puzzle can win',(await h.state('sequence')).phase==='won');
 for(const id of Object.keys(r.stations))await h.power(id,false);
 const refreshed=JSON.parse(fs.readFileSync(buildFile,'utf8'));refreshed.identity=h.identity;save('build.json',refreshed);
 const doc=await h.cli('world_files',{operation:'read',path:'docs/codeblocks.md',expectedIdentity:h.identity});
 const content=`# Engine games\nThree rule systems with six CodeBlock/MovieClip/lever stations.\n${JSON.stringify(r.stations)}\nInputs lever first, then host lever; click host to start/restart. Sequence: 2,1,3. Board: alternate legal cells, three in a row. Lanes: 1/2/3 keys or clicks, avoid red lane.\n31 behavior/transfer checks plus ${checks.length} lifecycle checks passed. Native dispatch and rendered feedback checked; OS screen picking and hardware keyboard not tested.\nGenerator: ${sourcePath}. Character mesh: ${r.model}. Native world saved and reopened; all controllers stopped afterward.\nProtected code edits changed native source after original construction: the original manifest retains stale code-member fingerprints intentionally. Use protected CodeBlock editing to revise these programs; do not blindly rebuild or erase manifest conflicts.\n`;
 await h.cli('world_docs',{operation:'update',expectedIdentity:h.identity,files:[{path:'docs/codeblocks.md',expectedContent:doc.content,content}]});
 const changes=await h.cli('world_files',{operation:'read',path:'docs/changes.md',expectedIdentity:h.identity});
 await h.cli('world_docs',{operation:'update',expectedIdentity:h.identity,files:[{path:'docs/changes.md',expectedContent:changes.content,content:'# Engine RSI acceptance\nNative dedicated world saved/reopened; three games and six controllers verified. Source, mesh and movie data persisted. Runtime tests after reopen stopped all controllers. First failed layout attempt left only an unused floor west of the three-game lab; it is not a playable station. Original creation manifest predates reviewed protected code revisions.\n'}]});
 save('report.json',{identity:h.identity,checks,mesh,log:await h.cli('tail_log',{lines:10})});console.log(JSON.stringify({passed:checks.length,output:out}));
}
main().catch(async e=>{save('failure.json',{error:String(e),checks});try{for(const id of Object.keys(h.scene.stations))await h.power(id,false);}catch(cleanup){save('cleanup-error.json',{error:String(cleanup)});}console.error(e);process.exitCode=1;});
