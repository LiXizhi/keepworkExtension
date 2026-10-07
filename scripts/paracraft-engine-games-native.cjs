// Native acceptance of different rule systems. Never runs against a user world.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [port,worldPath,output]=process.argv.slice(2);
assert(port&&output&&/\/CreationAcceptance_Engine_[^/]+\/$/.test(worldPath),'Usage: PORT disposable WORLD_PATH OUTPUT');
const out=path.resolve(output);fs.mkdirSync(out,{recursive:true});
const save=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2));
const read=f=>JSON.parse(fs.readFileSync(path.join(out,f),'utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),pos=p=>'{'+p.join(',')+'}',lua=JSON.stringify;
let identity,r;const checks=[],restoreSources=new Map();const chat='engine-rsi';
async function cli(action,params={}){
 const body=JSON.stringify({action,params});
 const v=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:Number(port),path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let s='';res.setEncoding('utf8');res.on('data',c=>s+=c);res.on('end',()=>{try{resolve(JSON.parse(s));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('CLI timeout; recover recorded request')));req.end(body);});
 assert(v.ok&&v.result.ok,JSON.stringify(v));return v.result;
}
async function until(fn,test,seconds=8){let v,delay=120;const end=Date.now()+seconds*1000;do{v=await fn();if(test(v))return v;await sleep(delay);delay=Math.min(500,delay*1.5);}while(Date.now()<end);throw Error('Observation timeout: '+JSON.stringify(v));}
async function probe(code){return (await cli('run_npl_code',{code:`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local i=C.World.Identity();assert(i.worldPath==${lua(worldPath)} and i.sessionId==${identity.sessionId});local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");`+code})).result;}
const block=id=>`E.GetBlockEntity(unpack(${pos(r.stations[id].code)}))`;
const actor=id=>`${block(id)}:GetCodeBlock():GetActor()`;
const state=k=>probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${lua(r.games[k].stateKey)});return g and {phase=g.phase,epoch=g.epoch,step=g.step,player=g.player,winner=g.winner,hp=g.hp,lane=g.lane,wave=g.wave,danger=g.danger};`);
const count=k=>probe(`return #${block(r.games[k].inputs)}:GetCodeBlock():GetActors();`);
const toggle=id=>probe(`local p=${pos(r.stations[id].lever)};B:GetBlock(unpack(p)):OnClick(p[1],p[2],p[3],"left");return true;`);
const clickHost=k=>probe(`local c=${block(r.games[k].host)}:GetCodeBlock();local a=c and c:GetActor();if not a then return false end;a:OnClick("left");return true;`);
const hit=(k,id)=>probe(`for _,a in ipairs(${block(r.games[k].inputs)}:GetCodeBlock():GetActors())do if a:GetActorValue("inputId")==${id} then a:OnClick("left");return true end end;return false;`);
function check(name,condition){checks.push({name,passed:!!condition});save('checks.json',checks);assert(condition,name);console.log('PASS '+name);}
async function start(k){const old=await state(k);await until(()=>clickHost(k),Boolean);await until(()=>state(k),g=>g.phase==='running'&&g.epoch>old.epoch);await until(()=>count(k),n=>n===(k==='board'?17:4));}
async function power(id,on){
 const leverOn=await probe(`return B:GetBlockData(unpack(${pos(r.stations[id].lever)}))>=8;`);
 if(leverOn!==on)await toggle(id);
 let previous;
 await until(async()=>{
  const q=await probe(`local e=${block(id)};local c=e:GetCodeBlock();return {powered=e:IsPowered()==true,loaded=c and c:IsLoaded()==true,actor=c and c:GetActor() and tostring(c:GetActor())};`);
  if(!on)return !q.powered&&!q.loaded;
  const stable=q.powered&&q.loaded&&q.actor&&q.actor===previous;previous=q.actor;return stable;
 },Boolean);
}
async function source(id){return (await cli('run_command',{codeBlock:{operation:'read',position:r.stations[id].code,worldPath}})).code;}
async function edit(id,code){await power(id,false);await probe('return true;');const old=await source(id);await cli('run_command',{codeBlock:{operation:'update',position:r.stations[id].code,worldPath,expectedCode:old,code}});assert.equal(await source(id),code);}
async function capture(k,file){
 const idx=['sequence','board','lanes'].indexOf(k),x=idx*11+5;
 const view=await probe(`return {eye={B:real_bottom(${r.origin[0]+x},${r.origin[1]+13},${r.origin[2]+1})},lookat={B:real_bottom(${r.origin[0]+x},${r.origin[1]+1},${r.origin[2]+12})}};`);
 const c=await cli('camera_capture',{expectedIdentity:identity,authoringSession:chat,...view});if(c.base64)fs.writeFileSync(path.join(out,file),Buffer.from(c.base64,'base64'));
}
async function main(){
 identity=(await cli('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);
 for(const f of ['AGENTS.md','docs/README.md'])assert((await cli('world_files',{operation:'read',path:f,expectedIdentity:identity})).content);
 await cli('read_official_wiki',{path:'creation.md'});
 if(fs.existsSync(path.join(out,'build.json'))){const b=read('build.json');assert.deepEqual(b.identity,identity);r=b.result;}
 else {
  let source=fs.readFileSync(path.resolve(__dirname,'../skills/paracraft-create/examples/engine-games.lua'),'utf8');
  source=source.replace('return {name=name,origin=s.origin','s:save();\nreturn {name=name,origin=s.origin');
  const requestId='engine-games-'+Date.now();
  if(process.argv.includes('--template')){
   const ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
   const input={template:'engine_games',expectedIdentity:identity,requestId,saveSource:true};
   const compiled=require('../src/mcp/paracraftTemplates.ts').compileCreationTemplate(input,chat);source=compiled.code;
   save('template.json',{...compiled.metadata,sourceBytes:Buffer.byteLength(source),requestBytes:Buffer.byteLength(JSON.stringify(input))});
  }
  const params=fs.existsSync(path.join(out,'request.json'))?read('request.json'):{expectedIdentity:identity,authoringSession:chat,requestId,code:source};save('request.json',params);
  const h=await cli('run_code',params);save('job.json',h);
  const b=await until(()=>cli('code_job',{expectedIdentity:identity,authoringSession:chat,jobId:h.jobId}),j=>j.state!=='running',130);save('build.json',b);assert.equal(b.state,'completed',b.error);r=b.result;
 }
 assert(r&&r.games,'Build not complete; inspect job before retrying');
 for(const id of Object.keys(r.stations))await power(id,false);
 const seqCurrent=await source(r.games.sequence.host);
 if(seqCurrent.includes('点亮全部三个机关'))await edit(r.games.sequence.host,seqCurrent.replace('g.step=0;g.hits={};g.player=1;','g.step=0;g.player=1;').replace('if not g.hits[id] then g.hits[id]=true;g.step=g.step+1 end','if id==order[g.step+1] then g.step=g.step+1 else g.step=0 end').replace('点亮全部三个机关：','按 2 → 1 → 3 解锁：'));
 // Apply the reviewed visual revision to previously built examples via guarded edits.
 for(const k of Object.keys(r.games)){const id=r.games[k].inputs;const old=await source(id);if(!old.includes('say(tostring(msg.id))'))await edit(id,old.replace('    show();','    show();\n    if kind~="board" then say(tostring(msg.id)) end'));}
 for(const k of Object.keys(r.games)){await power(r.games[k].inputs,true);await power(r.games[k].host,true);}
 check('six physical lever/CodeBlock/MovieClip chains start',true);
 await start('sequence');await hit('sequence',1);await sleep(180);check('wrong sequence input resets progress',(await state('sequence')).step===0);
 for(const [id,step]of [[2,1],[1,2],[3,3]]){await hit('sequence',id);await until(()=>state('sequence'),g=>g.step===step);}
 check('ordered sequence wins',(await state('sequence')).phase==='won');
 const position=()=>probe(`return {${actor(r.games.sequence.host)}:GetPosition()};`);
 await sleep(1100);const raised=await position();
 await start('sequence');const reset=await position();
 check('triggered native movie raises actor and reset restores it',Math.abs(raised[0]-reset[0])<0.01&&raised[1]-reset[1]>1);
 for(let n=0;n<8;n++)await clickHost('sequence');await sleep(500);check('rapid resets retain exactly three input clones',await count('sequence')===4);
 await start('board');await hit('board',1);await until(()=>state('board'),g=>g.step===1);await hit('board',1);await sleep(180);check('occupied board cell rejected',(await state('board')).step===1);
 for(const id of [5,2,6,3]){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}
 check('4x4 connect-three wins via native clicks',(await state('board')).winner===1);
 await hit('board',4);await sleep(160);check('terminal board rejects more moves',(await state('board')).step===5);
 await start('board');check('board restart clears cells and player',(await state('board')).step===0&&(await state('board')).player===1);
 // Legal no-three arrangement, alternating turns: full draw tests a different terminal.
 for(const id of [1,3,2,4,7,5,8,6,9,11,10,12,15,13,16,14]){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}
 check('full board draw',(await state('board')).phase==='draw');
 await capture('board','board-draw.jpg');
 for(const [label,moves]of [['vertical',[1,2,5,3,9]],['diagonal',[1,2,6,3,11]],['anti-diagonal',[3,1,6,2,9]]]){
  await start('board');for(const id of moves){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}check(label+' native board win',(await state('board')).winner===1);
 }
 await start('board');for(const id of [4,1,5,2,6]){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}check('board row boundary does not wrap into a win',(await state('board')).phase==='running');
 await start('lanes');const p0=await probe(`return {${actor(r.games.lanes.host)}:GetPosition()};`);
 for(let wave=0;wave<6;wave++){let g=await state('lanes');await hit('lanes',g.danger);await until(()=>state('lanes'),v=>v.wave>g.wave||v.phase!=='running',3);if((await state('lanes')).phase!=='running')break;}
 check('hazards cause natural defeat',(await state('lanes')).phase==='lost');
 await start('lanes');
 for(let wave=0;wave<6;wave++){let g=await state('lanes');await hit('lanes',g.danger%3+1);await until(()=>state('lanes'),v=>v.wave>g.wave||v.phase!=='running',3);}
 check('avoiding telegraphed lanes wins',(await state('lanes')).phase==='won'&&(await state('lanes')).hp===3);
 const p1=await probe(`return {${actor(r.games.lanes.host)}:GetPosition()};`);check('courier visibly travels through the scene',p1[2]-p0[2]>2);
 // Transfer A: unordered unique-switch puzzle. Same scene, different valid traces.
 const sequenceId=r.games.sequence.host,original=await source(sequenceId);
 restoreSources.set(sequenceId,original);
 const unordered=original.replace('g.step=0;g.player=1;','g.step=0;g.hits={};g.player=1;')
  .replace('if id==order[g.step+1] then g.step=g.step+1 else g.step=0 end','if not g.hits[id] then g.hits[id]=true;g.step=g.step+1 end')
  .replace('按 2 → 1 → 3 解锁：','点亮全部三个机关：');
 await edit(sequenceId,unordered);await power(sequenceId,true);await start('sequence');
 for(const [id,step]of [[3,1],[3,1],[2,2],[1,3]]){await hit('sequence',id);await sleep(160);check('unordered puzzle input '+id+' leaves '+step+' unique switches',(await state('sequence')).step===step);}
 check('changed unordered puzzle reaches victory',(await state('sequence')).phase==='won');
 await edit(sequenceId,original);await power(sequenceId,true);await start('sequence');await capture('sequence','sequence-active.jpg');
 // Old-epoch actor input is genuinely dispatched through native OnClick and ignored.
 await probe(`for _,a in ipairs(${block(r.games.sequence.inputs)}:GetCodeBlock():GetActors())do if a:GetActorValue("inputId")==2 then a:SetActorValue("epoch",-1);a:OnClick("left");end end;return true;`);
 await sleep(180);check('stale clone cannot change current puzzle',(await state('sequence')).step===0);
 await start('sequence');
 // Transfer B: connect four. Three in a row must now remain nonterminal.
 const boardId=r.games.board.host,boardOriginal=await source(boardId);
 restoreSources.set(boardId,boardOriginal);
 await edit(boardId,boardOriginal.replace('if n>=3 then','if n>=4 then').replace('三连棋','四连棋'));
 await power(boardId,true);await start('board');
 for(const id of [1,5,2,6,3]){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}
 check('connect-four variant rejects premature three-in-row victory',(await state('board')).phase==='running');
 for(const id of [7,4]){const old=(await state('board')).step;await hit('board',id);await until(()=>state('board'),g=>g.step===old+1);}
 check('connect-four variant wins on fourth cell',(await state('board')).winner===1);
 await edit(boardId,boardOriginal);await power(boardId,true);await start('board');
 check('simultaneous games retain independent state',(await state('sequence')).step===0&&(await state('board')).step===0&&(await state('lanes')).phase==='won');
 await power(r.games.sequence.inputs,false);await startMissing();
 async function startMissing(){await clickHost('sequence');await until(()=>state('sequence'),g=>g.phase==='not_ready');check('missing input dependency reports not_ready',true);}
 await power(r.games.sequence.inputs,true);await start('sequence');check('dependency can recover without rebuilding scene',await count('sequence')===4);
 await start('lanes');await capture('lanes','lanes-active.jpg');
 for(const k of Object.keys(r.games)){await power(r.games[k].host,false);await until(()=>count(k),n=>n===1);check(k+' controller stop cleans owned clones',(await state(k)).phase==='stopped');}
 for(const id of Object.keys(r.stations))await power(id,false);
 const overview=await cli('camera_capture',{expectedIdentity:identity,authoringSession:chat,eye:r.eye,lookat:r.lookat});if(overview.base64)fs.writeFileSync(path.join(out,'lab.jpg'),Buffer.from(overview.base64,'base64'));
 const log=await cli('tail_log',{lines:10});save('report.json',{identity,checks,scene:r,log});
 console.log(JSON.stringify({passed:checks.length,output:out}));
}
async function loadExisting(file){identity=(await cli('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);for(const f of ['AGENTS.md','docs/README.md'])assert((await cli('world_files',{operation:'read',path:f,expectedIdentity:identity})).content);const b=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(b.identity.worldPath,worldPath);r=b.result;return {identity,scene:r};}
module.exports={cli,probe,power,source,edit,start,hit,state,count,capture,until,sleep,loadExisting,get identity(){return identity;},get scene(){return r;}};
if(require.main===module)main().catch(async e=>{save('failure.json',{error:String(e),identity,checks});try{for(const [id,code]of restoreSources)await edit(id,code);if(r)for(const id of Object.keys(r.stations))await power(id,false);}catch(cleanup){save('cleanup-error.json',{error:String(cleanup)});}console.error(e);process.exitCode=1;});
