// Native circuit skill acceptance. Explicit disposable world and engine port required.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [portArg,worldPath,outArg,repoArg]=process.argv.slice(2);
const useSkill=process.argv[6]==='skill';
assert(portArg&&worldPath&&outArg&&repoArg,'Usage: node scripts/paracraft-circuits-native.cjs PORT WORLD_PATH OUTPUT PARAWORLD_ROOT');
assert(/\/CreationAcceptance_Circuits_[^/]+\/$/.test(worldPath),'Disposable circuits world required');
const out=path.resolve(outArg),repo=path.resolve(repoArg);fs.mkdirSync(out,{recursive:true});
const chat='circuits-skill-acceptance-20261006';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function cli(action,params={}) {
 const body=JSON.stringify({v:1,action,params});
 const value=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:Number(portArg),path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('Native observation timeout')));req.end(body);});
 assert(value.ok&&value.result.ok,JSON.stringify(value));return value.result;
}
function lesson(number,offset) {
 const file=path.join(repo,'config/Aries/creator/blocktemplates/buildingtask/circuit',number,number+'.blocks.xml');
 const text=fs.readFileSync(file,'utf8').match(/<pe:blocks>([\s\S]*?)<\/pe:blocks>/)?.[1];assert(text);
 // Only flat native numeric rows are accepted; never execute resource text as code.
 const rows=[...text.matchAll(/\{([^{}]+)\}/g)].map(m=>{
  assert(/^[\d\s,.-]+$/.test(m[1]));const row=m[1].split(',').map(s=>s.trim()).filter(Boolean).map(Number);
  assert(row.length===4||row.length===5);assert(row.every(Number.isFinite));return row;
 });assert(rows.length);
 const min=[0,1,2].map(i=>Math.min(...rows.map(r=>r[i])));
 return {number,offset,rows:rows.map(r=>[r[0]-min[0]+offset[0],r[1]-min[1]+offset[1],r[2]-min[2]+offset[2],r[3],r[4]||0])};
}
function lua(value){if(Array.isArray(value))return '{'+value.map(lua).join(',')+'}';if(typeof value==='string')return JSON.stringify(value);return String(value);}
const layouts=useSkill?[]:[lesson('03',[1,0,1]),lesson('17',[1,0,7]),lesson('18',[12,0,1]),lesson('23',[12,0,8]),lesson('04',[12,0,5])];
const custom=[];function cell(x,y,z,id,data=0){custom.push([x,y,z,id,data]);}
// One lever feeds two parallel lamp branches.
for(let x=1;x<=7;x++)for(let z=15;z<=19;z++)cell(x,0,z,62);
cell(1,1,17,190,5);for(let x=2;x<=5;x++)cell(x,1,17,189);
for(const z of [15,16,18,19])cell(5,1,z,189);cell(5,0,14,62);cell(5,0,20,62);cell(5,1,14,199);cell(5,1,20,199);
// Long wire and a repeater restore the far-end signal.
for(let x=23;x<=47;x++)cell(x,0,2,62);
cell(23,1,2,190,5);for(let x=24;x<=34;x++)cell(x,1,2,189);cell(35,1,2,197,1);
for(let x=36;x<=46;x++)cell(x,1,2,189);cell(47,1,2,199);
// Four-stage timing: direct lamp followed by three repeaters at their fourth setting.
for(let x=23;x<=31;x++)for(let z=8;z<=10;z++)if(z!==9||![24,26,28,30].includes(x))cell(x,0,z,62);
cell(23,1,9,190,5);cell(24,1,9,189);cell(24,0,9,199);
for(const x of [25,27,29]){cell(x,1,9,197,13);cell(x+1,1,9,189);cell(x+1,0,9,199);}
layouts.push({number:'fanout',rows:custom.filter(r=>r[0]<12)}, {number:'long',rows:custom.filter(r=>r[0]>=23&&r[2]===2)}, {number:'timing',rows:custom.filter(r=>r[0]>=23&&r[2]>=8)});
const mixed=useSkill?{rows:[]}:lesson('18',[12,0,15]);mixed.number='mixed';
mixed.rows=mixed.rows.filter(r=>!(r[0]===17&&r[1]===1&&r[2]===15));
mixed.rows.push([17,1,15,197,0]);for(let x=18;x<=21;x++)mixed.rows.push([x,0,15,62,0]);
for(let x=18;x<=20;x++)mixed.rows.push([x,1,15,189,0]);
mixed.rows.push([21,1,15,190,5],[20,0,14,62,0],[20,1,14,190,5]);layouts.push(mixed);
async function main(){
 const cap=await cli('get_creation_capabilities');assert.equal(cap.identity.worldPath,worldPath);const identity=cap.identity;
 fs.writeFileSync(path.join(out,'identity.json'),JSON.stringify(identity,null,2));
 const before=await cli('get_scene_info');
 let code=`local s=createScene({name="circuit_acceptance",dimensions={49,5,22}});local layouts=${lua(layouts.map(l=>[l.number,l.rows]))};local ports={};for _,layout in ipairs(layouts)do s:group(layout[1]);local p={inputs={},outputs={},wires={},repeaters={}};ports[layout[1]]=p;table.sort(layout[2],function(a,b)return a[2]<b[2]end);for _,r in ipairs(layout[2])do local id,data=r[4],r[5];if id==207 then id=199 end;if id==198 then id=197 end;if id==189 then data=0 end;if id==190 or id==105 then data=data%8 end;s:block({position={r[1],r[2],r[3]},blockId=id,data=data});local a=s:position({r[1],r[2],r[3]});if id==190 or id==105 then p.inputs[#p.inputs+1]=a elseif id==199 then p.outputs[#p.outputs+1]=a elseif id==189 then p.wires[#p.wires+1]=a elseif id==197 then p.repeaters[#p.repeaters+1]=a end end end;return {origin=s.origin,ports=ports,eye=s:cameraPoint({24,34,-17}),lookat=s:cameraPoint({24,0,10})};`;
 if(useSkill){
  const guide=fs.readFileSync(path.resolve('skills/paracraft-create/references/circuits.md'),'utf8');
  const example=guide.match(/```lua\r?\n([\s\S]*?)```/)?.[1];assert(example&&example.includes('local kind = "mixed"'));
  const mapping={'03':'lamp','17':'or','18':'and',fanout:'fanout',long:'long','04':'button',timing:'delay',mixed:'mixed'};
  code='local ports,views={},{};\n'+Object.entries(mapping).map(([key,kind])=>`do local r=(function()\n${example.replace('local kind = "mixed"','local kind = "'+kind+'"')}\nend)();ports[${lua(key)}]={inputs=r.inputs,outputs=r.outputs};views[${lua(key)}]=r;end;`).join('\n')+'\nreturn {ports=ports,views=views};';
  fs.writeFileSync(path.join(out,'skill-source.md'),guide);
 }
 fs.writeFileSync(path.join(out,'generator.lua'),code);
 const requestFile=path.join(out,'request.json');
 const request=fs.existsSync(requestFile)?JSON.parse(fs.readFileSync(requestFile,'utf8')):{expectedIdentity:identity,authoringSession:chat,requestId:'circuits-initial-'+Date.now(),code,timeoutSeconds:120};
 assert.deepEqual(request.expectedIdentity,identity,'Stored request belongs to a different world session');
 fs.writeFileSync(requestFile,JSON.stringify(request,null,2));
 const handleFile=path.join(out,'handle.json');
 const handle=fs.existsSync(handleFile)?JSON.parse(fs.readFileSync(handleFile,'utf8')):await cli('run_code',request);fs.writeFileSync(handleFile,JSON.stringify(handle,null,2));
 let built;do{await sleep(300);built=await cli('code_job',{expectedIdentity:identity,authoringSession:chat,jobId:handle.jobId});}while(built.state==='running');
 fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(built,null,2));assert.equal(built.state,'completed',built.error);
 const result=built.result;for(const p of Object.values(result.ports))for(const k of ['inputs','outputs','wires','repeaters']){if(!Array.isArray(p[k]))p[k]=[];p[k].sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);}
 fs.writeFileSync(path.join(out,'ports.json'),JSON.stringify(result,null,2));
 const nativePrefix=`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local i=C.World.Identity();assert(i.worldPath==${lua(worldPath)} and i.sessionId==${identity.sessionId});`;
 const probe=async code=>(await cli('run_npl_code',{code:nativePrefix+code})).result;
 const activate=async p=>probe(`local p=${lua(p)};local b=B:GetBlock(unpack(p));assert(b and (b.id==190 or b.id==105));return b:OnClick(p[1],p[2],p[3],"left");`);
 const observe=async()=>probe(`local ports=${lua(Object.entries(result.ports).map(([k,v])=>[k, [...v.inputs,...v.outputs,...v.wires,...v.repeaters]]))};local r={};for _,entry in ipairs(ports)do local cells={};r[entry[1]]=cells;for _,p in ipairs(entry[2])do cells[#cells+1]={position=p,id=B:GetBlockId(unpack(p)),data=B:GetBlockData(unpack(p))}end end;return r;`);
 await probe(`for _,p in ipairs(${lua(Object.values(result.ports).flatMap(p=>p.inputs))})do local b=B:GetBlock(unpack(p));if b.id==190 and B:GetBlockData(unpack(p))>=8 then b:OnActivated(unpack(p))end end;return true;`);
 await sleep(1000);const tests=[];
 const lamps=async key=>{const r=await observe();return result.ports[key].outputs.map(p=>r[key].find(c=>c.position.join(',')===p.join(',')).id===207?1:0);};
 const record=async(key,input,expected)=>{const actual=await lamps(key);tests.push({circuit:key,input,expected,actual,passed:JSON.stringify(actual)===JSON.stringify(expected)});fs.writeFileSync(path.join(out,'state-tests.json'),JSON.stringify({tests,observed:await observe()},null,2));};
 for(const key of ['03','fanout','long']){const p=result.ports[key];await record(key,[0],p.outputs.map(()=>0));await activate(p.inputs[0]);await sleep(700);await record(key,[1],p.outputs.map(()=>1));await activate(p.inputs[0]);await sleep(700);await record(key,[0],p.outputs.map(()=>0));}
 for(const [key,truth]of [['17',[0,1,1,1]],['18',[0,0,1,0]]]){
  const p=result.ports[key];let current=[0,0];for(const [index,state]of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]],[0,[0,0]]]){for(let j=0;j<2;j++)if(current[j]!==state[j])await activate(p.inputs[j]);current=state;await sleep(700);await record(key,state,[truth[index]]);}
 }
 const mp=result.ports.mixed;let mixedCurrent=[0,0,0];
 for(const state of [[0,0,0],[0,1,0],[0,0,1],[0,1,1],[1,0,0],[1,1,0],[1,0,1],[1,1,1],[0,0,0]]){for(let j=0;j<3;j++)if(mixedCurrent[j]!==state[j])await activate(mp.inputs[j]);mixedCurrent=state;await sleep(700);await record('mixed',state,[state[0]&&(state[1]||state[2])?1:0]);}
 const bp=result.ports['04'];await record('04',[0],[0]);await activate(bp.inputs[0]);await sleep(150);await record('04',[1],[1]);await sleep(1400);await record('04',[0],[0]);
 // Timed observations occur in the engine every 20 ms, so transport latency cannot fabricate order.
 const timedToggle=async()=>{
  await probe(`local inputs=${lua(result.ports.timing.inputs)};local outputs=${lua(result.ports.timing.outputs)};local start=ParaGlobal.timeGetTime();local trace={};local timer;timer=commonlib.Timer:new({callbackFunc=function(t)local row={ms=ParaGlobal.timeGetTime()-start,states={}};for _,p in ipairs(outputs)do row.states[#row.states+1]=B:GetBlockId(unpack(p))==207 and 1 or 0 end;trace[#trace+1]=row;if row.ms>2200 then t:Change();end end});commonlib.setfield("CircuitSkillTrace",{trace=trace,timer=timer});timer:Change(0,20);local p=inputs[1];B:GetBlock(unpack(p)):OnClick(p[1],p[2],p[3],"left");return true;`);
  await sleep(2600);return probe('return CircuitSkillTrace.trace;');
 };
 const timingOn=await timedToggle();fs.writeFileSync(path.join(out,'timing-on.json'),JSON.stringify(timingOn,null,2));
 const timingOff=await timedToggle();fs.writeFileSync(path.join(out,'timing-off.json'),JSON.stringify(timingOff,null,2));await record('timing',[0],result.ports.timing.outputs.map(()=>0));
 const first=result.ports.timing.outputs.map((p,j)=>timingOn.find(r=>r.states[j]===1)?.ms);assert(first.every(Number.isFinite));assert(first.every((t,j)=>j===0||t>first[j-1]+150),JSON.stringify(first));
 const firstOff=result.ports.timing.outputs.map((p,j)=>timingOff.find(r=>r.states[j]===0)?.ms);assert(firstOff.every(Number.isFinite));assert(firstOff.every((t,j)=>j===0||t>firstOff[j-1]+150),JSON.stringify(firstOff));
 const report={identity,mode:useSkill?'skill-example':'native-templates',result,tests,timingOn,timingOff,timingFirstOnMs:first,timingFirstOffMs:firstOff,observed:await observe(),before,after:await cli('get_scene_info'),log:await cli('tail_log')};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 assert(tests.every(t=>t.passed),'Failed state cases: '+JSON.stringify(tests.filter(t=>!t.passed)));
 // Native idle animation changes avatar facing even with no test running.
 // Preserve player location/scale and the independently observed main camera.
 for(const k of ['position','blockPosition','scaling'])assert.deepEqual(report.after.player[k],report.before.player[k],'Player '+k+' changed');
 assert.deepEqual(report.after.camera,report.before.camera,'Main camera moved');
 console.log(JSON.stringify({passed:tests.length,timingFirstOnMs:first,timingFirstOffMs:firstOff,output:out}));
}
main().catch(e=>{fs.writeFileSync(path.join(out,'failure.txt'),e.stack||e.message);console.error(e);process.exitCode=1;});
