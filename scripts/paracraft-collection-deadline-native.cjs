// Controlled deadline boundary in addition to the native suite's real 20 s timeout.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const h=require('./paracraft-engine-games-native.cjs');
const [,worldPath,out,buildFile]=process.argv.slice(2);assert(buildFile,'Pass collection build.json after OUTPUT');
const checks=[],save=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)),pos=p=>'{'+p.join(',')+'}';
const check=(name,value)=>{checks.push({name,passed:!!value});save('checks.json',checks);assert(value,name);console.log('PASS '+name);};
const block=id=>`E.GetBlockEntity(unpack(${pos(h.scene.stations[id].code)}))`;
const state=()=>h.probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${JSON.stringify(h.scene.stateKey)});return {phase=g.phase,score=g.score,epoch=g.epoch};`);
const click=()=>h.probe(`${block('host')}:GetCodeBlock():GetActor():OnClick("left");return true;`);
async function main(){
 await h.loadExisting(buildFile);
 for(const id of ['host','tokens','npc'])await h.power(id,false);
 await h.power('tokens',true);await h.sleep(450);await h.power('host',true);
 await click();await h.until(state,g=>g.phase==='running');
 await h.until(()=>h.probe(`return #${block('tokens')}:GetCodeBlock():GetActors();`),n=>n===6);
 await h.probe(`for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do local id=a:GetActorValue("tokenId");if id and id<=4 then a:OnClick("left") end end;return true;`);
 await h.until(state,g=>g.score===4);check('different station clock origins still allow valid scoring',true);
 // Test fixture changes only the deadline, never phase/score/win state. The late
 // last-target request must be adjudicated by the production controller.
 await h.probe(`local g=GameLogic.GetCodeGlobal():GetGlobal(${JSON.stringify(h.scene.stateKey)});g.deadline=${block('host')}:GetCodeBlock():GetTime();for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do if a:GetActorValue("tokenId")==5 then a:OnClick("left") end end;return true;`);
 await h.until(state,g=>g.phase==='lost');check('deadline equality rejects final target instead of winning',(await state()).score===4);
 await click();await h.until(state,g=>g.phase==='running'&&g.score===0);
 await h.until(()=>h.probe(`return #${block('tokens')}:GetCodeBlock():GetActors();`),n=>n===6);
 await h.probe(`for _,a in ipairs(${block('tokens')}:GetCodeBlock():GetActors())do if a:GetActorValue("tokenId") then for n=1,40 do a:OnClick("left") end end end;return true;`);
 await h.until(state,g=>g.phase==='won');check('200 native requests still score exactly five',(await state()).score===5);
 for(const id of ['host','tokens','npc'])await h.power(id,false);
 save('report.json',{identity:h.identity,checks,log:await h.cli('tail_log',{lines:10})});console.log(JSON.stringify({passed:checks.length,output:out}));
}
main().catch(async e=>{save('failure.json',{error:String(e),checks});try{for(const id of ['host','tokens','npc'])await h.power(id,false);}catch(cleanup){save('cleanup-error.json',{error:String(cleanup)});}console.error(e);process.exitCode=1;});
