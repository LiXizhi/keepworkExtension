// Native behavioral acceptance for the skill's physical CodeBlock example.
// Initialize a disposable CreationAcceptance_CodeBlocks_* world first.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [port,worldPath,output]=process.argv.slice(2);
assert(port&&worldPath&&output,'Usage: node scripts/paracraft-codeblocks-native.cjs PORT WORLD_PATH OUTPUT');
assert(/\/CreationAcceptance_(?:CodeBlocks|Engine)_[^/]+\/$/.test(worldPath),'Disposable world required');
const out=path.resolve(output);fs.mkdirSync(out,{recursive:true});
const chat='codeblocks-skill-20261007',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const metrics={calls:0,requestBytes:0,responseBytes:0,actions:{}};
const started=Date.now();
const lua=v=>Array.isArray(v)?'{'+v.map(lua).join(',')+'}':JSON.stringify(v);
async function cli(action,params={}) {
  const body=JSON.stringify({action,params});
  metrics.calls++;metrics.requestBytes+=Buffer.byteLength(body);metrics.actions[action]=(metrics.actions[action]||0)+1;
  const r=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:Number(port),path:'/ajax/paracraft_cli',method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{metrics.responseBytes+=Buffer.byteLength(text);try{resolve(JSON.parse(text));}catch(e){reject(e);}});
    });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('Native observation timeout')));req.end(body);
  });
  assert(r.ok&&r.result.ok,JSON.stringify(r));return r.result;
}
async function main(){
  const identity=(await cli('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);
  const instructions=await cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity});
  assert(typeof instructions.content==='string','Initialize and read world instructions before running');
  await cli('world_files',{operation:'read',path:'docs/README.md',expectedIdentity:identity});
  await cli('read_official_wiki',{path:'creation.md'});
  const before=await cli('get_scene_info');
  const read=f=>JSON.parse(fs.readFileSync(path.join(out,f),'utf8').replace(/^\uFEFF/,''));
  const save=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2));
  let built;
  if(fs.existsSync(path.join(out,'build.json'))){
    built=read('build.json');assert.deepEqual(built.identity,identity,'Build belongs to another world session');
  }else{
    const source=fs.readFileSync(path.resolve(__dirname,'../skills/paracraft-create/examples/codeblock-playground.lua'),'utf8');
    const request=fs.existsSync(path.join(out,'request.json'))?read('request.json'):
      {expectedIdentity:identity,authoringSession:chat,requestId:'codeblock-playground-'+Date.now(),code:source};
    assert.deepEqual(request.expectedIdentity,identity);save('request.json',request);
    const handle=fs.existsSync(path.join(out,'job.json'))?read('job.json'):await cli('run_code',request);save('job.json',handle);
    const deadline=Date.now()+130000;
    do{await sleep(300);built=await cli('code_job',{expectedIdentity:identity,authoringSession:chat,jobId:handle.jobId});
      assert(Date.now()<deadline,'Build still pending; recover job instead of replaying');}while(built.state==='running');
    save('build.json',built);
  }
  assert.equal(built.state,'completed',built.error);
  const r=built.result,stations=r.stations;
  const fence=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local i=C.World.Identity();assert(i.worldPath==${lua(worldPath)} and i.sessionId==${identity.sessionId});local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");`;
  const probe=async source=>(await cli('run_npl_code',{code:fence+source})).result;
  const block=id=>`E.GetBlockEntity(unpack(${lua(stations[id].code)}))`;
  const actor=id=>`${block(id)}:GetCodeBlock():GetActor()`;
  const game=()=>probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${lua(r.stateKey)});return g and {phase=g.phase,score=g.score,epoch=g.epoch};`);
  const actors=()=>probe(`local rows={};for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do rows[#rows+1]={id=a:GetActorValue("tokenId"),epoch=a:GetActorValue("roundEpoch")};end;return rows;`);
  const toggle=async id=>probe(`local p=${lua(stations[id].lever)};assert(B:GetBlockId(unpack(p))==190);B:GetBlock(unpack(p)):OnClick(p[1],p[2],p[3],"left");return true;`);
  const click=async id=>probe(`${actor(id)}:OnClick("left");return true;`);
  const checks=[];
  function check(name,value,detail){checks.push({name,passed:!!value,detail});save('checks.json',checks);assert(value,name+': '+JSON.stringify(detail));}
  async function until(fn,predicate,seconds=5){const end=Date.now()+seconds*1000;let v,delay=150;do{v=await fn();if(predicate(v))return v;await sleep(Math.min(delay,Math.max(0,end-Date.now())));delay=Math.min(1000,delay*1.5);}while(Date.now()<end);throw Error('Observation timeout: '+JSON.stringify(v));}
  for(const id of r.startOrder){
    const match=await probe(`local e=${block(id)};local m=e:FindNearByMovieEntity();return {position=m and {m:GetBlockPos()},sourceLength=#e:GetCommand(),powered=e:IsPowered()==true};`);
    assert.deepEqual(match.position,stations[id].movie);assert(match.sourceLength>100);assert(!match.powered,'Use an inactive example');
    await toggle(id);await until(()=>probe(`local e=${block(id)};local c=e:GetCodeBlock();return {powered=e:IsPowered()==true,loaded=c and c:IsLoaded()==true,actor=c and c:GetActor()~=nil};`),v=>v.powered&&v.loaded&&v.actor);
    check(id+' native lever and actor association',true);
  }
  check('initial idle',(await game()).phase==='idle');
  await click('host');await until(game,g=>g.phase==='running');await until(actors,a=>a.length===6);
  check('five native clones',(await actors()).filter(a=>a.id).length===5);
  const hit=async id=>probe(`for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do if a:GetActorValue("tokenId")==${id} then a:OnClick("left");return true end end;return false;`);
  await hit(1);await until(game,g=>g.score===1);await hit(1);await sleep(150);
  check('same target scores once',(await game()).score===1);
  await probe(`for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do local id=a:GetActorValue("tokenId");if id and id>=2 then a:OnClick("left") end end;return true;`);
  await until(game,g=>g.phase==='won');await until(actors,a=>a.length===1);
  check('win clears clones',(await game()).score===5);
  await click('host');await until(game,g=>g.phase==='running'&&g.score===0);await until(actors,a=>a.length===6);
  check('restart resets score and respawns',true);
  const oldEpoch=(await game()).epoch;
  await hit(1);await until(game,g=>g.score===1);await click('host');
  await until(game,g=>g.phase==='running'&&g.epoch>oldEpoch&&g.score===0);await until(actors,a=>a.length===6);
  check('mid-round restart clears old hits and actors',true);
  const rapidEpoch=(await game()).epoch;
  await probe(`for n=1,8 do ${actor('host')}:OnClick("left") end;return true;`);
  await until(game,g=>g.phase==='running'&&g.epoch>rapidEpoch);await sleep(250);
  check('rapid repeated start clicks do not multiply clones',(await actors()).length===6);
  await until(game,g=>g.phase==='lost',25);await until(actors,a=>a.length===1);
  check('natural deadline expires and clears clones',true);
  const npc=()=>probe(`local a=${actor('npc')};return {state=a:GetActorValue("behaviorState"),position={a:GetPosition()}};`);
  const start=await npc();await sleep(450);const moved=await npc();
  check('patrol moves',JSON.stringify(start.position)!==JSON.stringify(moved.position),{start,moved});
  await click('npc');await until(npc,n=>n.state==='follow');
  const distance=()=>probe(`local a=${actor('npc')};local b=${actor('host')};local x,y,z=a:GetPosition();local u,v,w=b:GetPosition();return math.sqrt((x-u)^2+(y-v)^2+(z-w)^2);`);
  const d0=await distance();await sleep(1200);const d1=await distance();check('follow approaches named actor',d1<d0,{d0,d1});
  await click('npc');await until(npc,n=>n.state==='idle');await sleep(250);const idle=await npc();await sleep(450);
  check('idle stays still',JSON.stringify(idle.position)===JSON.stringify((await npc()).position));
  await click('npc');await until(npc,n=>n.state==='patrol');check('patrol resumes',true);
  // Capture the rendered active actors through the independent native viewport.
  const capture=await cli('camera_capture',{expectedIdentity:identity,authoringSession:chat,eye:r.eye,lookat:r.lookat});
  save('capture.json',capture);
  if(capture.base64)fs.writeFileSync(path.join(out,'playground.jpg'),Buffer.from(capture.base64,'base64'));
  await click('host');await until(game,g=>g.phase==='running');await until(actors,a=>a.length===6);
  await toggle('host');await until(game,g=>g.phase==='stopped');await until(actors,a=>a.length===1);
  check('controller power-off cleans live clones',true);
  await toggle('host');await until(game,g=>g.phase==='idle');await click('host');await until(game,g=>g.phase==='running');await until(actors,a=>a.length===6);
  check('power cycle can start a fresh round',true);
  await toggle('tokens');await click('host');await until(game,g=>g.phase==='not_ready');
  check('missing target station reports not ready',true);
  await toggle('tokens');await click('host');await until(game,g=>g.phase==='running');await until(actors,a=>a.length===6);
  check('target station can be reenabled and retried',true);
  await probe(['host','tokens','npc'].map(id=>`do local p=${lua(stations[id].lever)};B:GetBlock(unpack(p)):OnClick(p[1],p[2],p[3],"left") end;`).join('')+'return true;');
  await sleep(250);
  for(const id of ['host','tokens','npc']){
    check(id+' stops on power-off',await probe(`local e=${block(id)};return not e:IsPowered() and not e:GetCodeBlock():IsLoaded();`));
  }
  const after=await cli('get_scene_info');
  for(const k of ['position','blockPosition','scaling'])assert.deepEqual(after.player[k],before.player[k]);
  assert.deepEqual(after.camera,before.camera);check('player and main camera preserved',true);
  save('report.json',{identity,built:r,checks,before,after,log:await cli('tail_log')});
  const files=[];
  for(const doc of ['docs/codeblocks.md','docs/changes.md']){
    const old=await cli('world_files',{operation:'read',path:doc,expectedIdentity:identity});
    const content=`# CodeBlock skill acceptance\nRequest ${built.requestId}.\nThree native CodeBlock/MovieClip/lever stations: ${JSON.stringify(stations)}.\n${checks.length} behavioral checks passed; native dispatch tested, OS screen picking not tested.\nRuntime construction exists, all three stations are off. Toy mesh exported: ${r.model}.\nNative world NOT saved. Skill source: examples/codeblock-playground.lua.\n`;
    files.push({path:doc,expectedContent:old.content,content});
  }
  const docs=await cli('world_docs',{operation:'update',expectedIdentity:identity,files});
  assert(docs.files.every(f=>['updated','unchanged'].includes(f.status)),'Document update did not complete: '+JSON.stringify(docs.files));
  metrics.elapsedMs=Date.now()-started;save('metrics.json',metrics);
  console.log(JSON.stringify({passed:checks.length,worldPath,output:out,metrics}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
