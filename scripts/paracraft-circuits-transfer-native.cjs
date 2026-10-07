// Novel circuits synthesized from boolean/state requirements; no lesson/template reads.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [portArg,worldPath,outArg]=process.argv.slice(2);
assert(portArg&&worldPath&&outArg,'Usage: node scripts/paracraft-circuits-transfer-native.cjs PORT WORLD_PATH OUTPUT');
assert(/\/CreationAcceptance_Circuits_Transfer_[^/]+\/$/.test(worldPath),'Explicit disposable transfer world required');
const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
const session='circuit-transfer-20261006',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function cli(action,params={}){const body=JSON.stringify({v:1,action,params});return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:Number(portArg),path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{const r=JSON.parse(data);assert(r.ok&&r.result.ok,JSON.stringify(r));resolve(r.result)}catch(e){reject(e)}})});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('Native observation timeout')));req.end(body);});}
const lua=x=>Array.isArray(x)?'{'+x.map(lua).join(',')+'}':typeof x==='string'?JSON.stringify(x):String(x);
const dirs=[[-1,0],[1,0],[0,-1],[0,1]],op=[1,0,3,2];
function design(name,dimensions){
 const cells=new Map(),nets=new Map(),inputs={},outputs={},gates={},doors=[];
 const key=(x,y,z)=>[x,y,z].join(',');
 function put(x,y,z,id,data=0){const k=key(x,y,z),old=cells.get(k);assert(x>=0&&x<dimensions[0]&&y>=0&&y<dimensions[1]&&z>=0&&z<dimensions[2],name+' out of bounds '+k);if(old){if(old[3]===id&&old[4]===data)return;if(old[3]===62&&y===0&&id===199){cells.set(k,[x,y,z,id,data]);return;}throw new Error(name+' conflicting cells '+k+' '+old[3]+' / '+id)}cells.set(k,[x,y,z,id,data]);}
 function support(x,z){if(!cells.has(key(x,0,z)))put(x,0,z,62)}
 function rep(x,z,d,setting=1){support(x,z);const k=key(x,1,z);if(cells.get(k)?.[3]===189)cells.delete(k);put(x,1,z,197,d+4*(setting-1));return [x,1,z]}
 function input(label,x,z,id=190){support(x,z);put(x,1,z,id,5);inputs[label]=[x,1,z];return inputs[label]}
 function lamp(label,x,z,y=1){if(y===1)support(x,z);put(x,y,z,199);outputs[label]=[x,y,z];return outputs[label]}
 function gate(label,x,z,outDirection,inputDirections){support(x,z);put(x,1,z,143);const [dx,dz]=dirs[outDirection];const torchData=[1,3,4,2][outDirection];put(x+dx,1,z+dz,191,torchData);support(x+dx,z+dz);const g={torch:[x+dx,1,z+dz],out:rep(x+2*dx,z+2*dz,outDirection),inputs:{}};
  for(const [port,d]of Object.entries(inputDirections)){const [ix,iz]=dirs[d];rep(x+ix,z+iz,op[d]);g.inputs[port]=[x+2*ix,1,z+2*iz];}
  gates[label]=g;return g;
 }
 function route(net,points){for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];assert(a[0]===b[0]||a[1]===b[1]);const steps=Math.abs(b[0]-a[0])+Math.abs(b[1]-a[1]);const dx=Math.sign(b[0]-a[0]),dz=Math.sign(b[1]-a[1]);for(let j=0;j<=steps;j++){const x=a[0]+dx*j,z=a[1]+dz*j,k=key(x,1,z),old=cells.get(k);const seen=nets.get(k);assert(!seen||seen===net,name+' net crossing '+k+' '+seen+' / '+net);nets.set(k,net);support(x,z);if(!old)put(x,1,z,189);else assert([189,197,190,105].includes(old[3]),name+' route through '+old[3]+' at '+k);}}}
 function latch(label,x,z,resetSide=0){
  const q=gate(label+'.Q',x+8,z+8,1,{reset:resetSide,feedback:3});
  const nq=gate(label+'.NQ',x+8,z+14,0,{set:1,feedback:2});
  route(label+'.Q',[[x+10,z+8],[x+12,z+8],[x+12,z+12],[x+8,z+12]]);
  route(label+'.NQ',[[x+6,z+14],[x+4,z+14],[x+4,z+10],[x+8,z+10]]);
  return {q,nq,set:[x+10,z+14],reset:[x+8+2*dirs[resetSide][0],z+8+2*dirs[resetSide][1]]};
 }
 return {name,dimensions,cells,inputs,outputs,gates,doors,put,support,rep,input,lamp,gate,route,latch};
}
// Four independent inputs: enabled AND any entrance AND NOT lock, with three outputs.
const lighting=design('transfer_lighting',[37,5,24]);
{
 const d=lighting;d.input('A',2,8);d.input('B',8,2);d.input('E',2,20);d.input('Lock',22,2);
 d.gate('NoPresence',8,8,1,{A:0,B:2});d.gate('Disabled',8,20,1,{E:0});d.gate('Allowed',22,14,1,{NoPresence:0,Disabled:3,Lock:2});
 d.route('A',[[2,8],[6,8]]);d.route('B',[[8,2],[8,6]]);d.route('E',[[2,20],[6,20]]);d.route('Lock',[[22,2],[22,12]]);
 d.route('NoPresence',[[10,8],[20,8],[20,14]]);d.rep(16,8,1);
 d.route('Disabled',[[10,20],[22,20],[22,16]]);d.rep(18,20,1);
 d.route('Allowed',[[24,14],[27,14],[27,10]]);d.route('Allowed',[[27,14],[27,18]]);d.route('Allowed',[[27,14],[31,14]]);
 d.lamp('Left',27,10,0);d.lamp('Right',27,18,0);d.lamp('Far',31,14,0);
}
// Two independently latched achievements, common reset, and a real two-cell door.
const puzzle=design('transfer_puzzle',[45,5,40]);
{
 const d=puzzle,m1=d.latch('M1',0,0),m2=d.latch('M2',24,0);
 d.input('A',16,14,105);d.input('B',40,14,105);d.input('Reset',20,2);
 d.route('Set1',[[16,14],[10,14]]);d.route('Set2',[[40,14],[34,14]]);
 d.route('Reset',[[20,2],[20,4],[0,4],[0,32],[20,32]]);d.route('Reset',[[2,4],[2,8],[6,8]]);d.route('Reset',[[20,4],[26,4],[26,8],[30,8]]);
 d.rep(2,7,3);d.rep(10,4,0);d.rep(25,4,1);d.rep(0,14,3);d.rep(0,24,3);d.rep(10,32,1);
 d.gate('Completed',22,32,3,{NQ1:2,NQ2:1,Reset:0});
 d.route('M1.NQ',[[6,14],[5,14],[5,28],[22,28],[22,30]]);d.rep(5,23,3);d.rep(14,28,1);
 d.route('M2.NQ',[[30,14],[29,14],[29,32],[24,32]]);d.rep(29,22,3);
 d.route('Completed',[[22,34],[22,36],[23,36]]);d.rep(24,36,1);d.route('Completed',[[23,36],[24,36]]);
 d.lamp('Ready',22,36,0);d.support(25,36);d.doors.push([25,1,36]);d.outputs.Door=[25,1,36];d.outputs.DoorUpper=[25,2,36];
}
// A button-latched RUN signal enables a newly drawn NOR feedback oscillator.
// Stop allows the pipeline to drain; all outputs must stay off within two seconds.
const warning=design('transfer_warning',[35,5,29]);
{
 const d=warning,m=d.latch('Run',0,0);d.input('Start',16,14,105);d.cells.delete('7,1,8');d.input('Stop',7,8,105);d.cells.get('7,1,8')[4]=1;
 d.route('Set',[[16,14],[10,14]]);
 d.gate('Pulse',24,10,1,{feedback:0,NotRun:2});
 d.route('Run.NQ',[[6,14],[5,14],[5,6],[24,6],[24,8]]);d.rep(5,9,2);d.rep(14,6,1);
 d.route('Pulse',[[26,10],[32,10],[32,18],[20,18],[20,10],[22,10]]);d.rep(32,13,3,4);d.rep(28,18,0,4);d.rep(20,15,2,4);
 d.route('Pulse',[[30,10],[30,3],[21,3]]);d.rep(26,3,0,1);d.rep(24,3,0,2);d.rep(22,3,0,2);
 d.lamp('First',25,3,0);d.lamp('Second',23,3,0);d.lamp('Third',21,3,0);
}
const designs=[lighting,puzzle,warning];
async function main(){
 const identity=(await cli('get_creation_capabilities')).identity;assert.equal(identity.worldPath,worldPath);const before=await cli('get_scene_info');
 const body=designs.map(d=>{const rows=[...d.cells.values()];return `do local s=createScene({name=${lua(d.name)},dimensions=${lua(d.dimensions)},origin={base.origin[1]+${[0,50,105][designs.indexOf(d)]},base.origin[2],base.origin[3]}});s:group("native_circuit");local rows=${lua(rows)};table.sort(rows,function(a,b)return a[2]<b[2]end);for _,r in ipairs(rows)do s:block({position={r[1],r[2],r[3]},blockId=r[4],data=r[5]})end;for _,p in ipairs(${lua(d.doors)})do s:block({position=p,blockId=230,data=3});s:block({position={p[1],p[2]+1,p[3]},blockId=194,data=3})end;local function abs(p)return s:position(p)end;local inputs,outputs,gates={},{},{};${Object.entries(d.inputs).map(([k,p])=>`inputs[${lua(k)}]=abs(${lua(p)});`).join('')}${Object.entries(d.outputs).map(([k,p])=>`outputs[${lua(k)}]=abs(${lua(p)});`).join('')}${Object.entries(d.gates).map(([k,g])=>`gates[${lua(k)}]=abs(${lua(g.torch)});`).join('')}result[${lua(d.name)}]={inputs=inputs,outputs=outputs,gates=gates,origin=s.origin,eye=s:cameraPoint({${d.dimensions[0]/2},28,-10}),lookat=s:cameraPoint({${d.dimensions[0]/2},1,${d.dimensions[2]/2}})};end;`;}).join('\n');
 const code='local result={};local base=createScene({name="transfer_site",dimensions={145,5,44}});\n'+body+'\nreturn result;';const requestFile=path.join(out,'request.json');let request;
 if(fs.existsSync(requestFile)){request=JSON.parse(fs.readFileSync(requestFile));assert.deepEqual(request.expectedIdentity,identity)}else{request={expectedIdentity:identity,authoringSession:session,requestId:'transfer-'+Date.now(),code,timeoutSeconds:180};fs.writeFileSync(requestFile,JSON.stringify(request,null,2));fs.writeFileSync(path.join(out,'generator.lua'),code);fs.writeFileSync(path.join(out,'design.json'),JSON.stringify(designs.map(d=>({name:d.name,dimensions:d.dimensions,rows:[...d.cells.values()],inputs:d.inputs,outputs:d.outputs,gates:d.gates,doors:d.doors})),null,2));}
 const handleFile=path.join(out,'handle.json');const handle=fs.existsSync(handleFile)?JSON.parse(fs.readFileSync(handleFile)):await cli('run_code',request);fs.writeFileSync(handleFile,JSON.stringify(handle,null,2));let built;
 do{await sleep(300);built=await cli('code_job',{expectedIdentity:identity,authoringSession:session,jobId:handle.jobId})}while(built.state==='running');fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(built,null,2));assert.equal(built.state,'completed',built.error);
 const ports=built.result,tests=[];const prefix=`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local i=C.World.Identity();assert(i.worldPath==${lua(worldPath)} and i.sessionId==${identity.sessionId});`;
 const probe=async code=>(await cli('run_npl_code',{code:prefix+code})).result;
 const click=async p=>probe(`local p=${lua(p)};local b=B:GetBlock(unpack(p));assert(b.id==190 or b.id==105);return b:OnClick(p[1],p[2],p[3],"left");`);
 const state=async name=>probe(`local r={};${Object.entries({...ports[name].outputs,...ports[name].gates}).map(([k,p])=>`r[${lua(k)}]={id=B:GetBlockId(${p.join(',')}),data=B:GetBlockData(${p.join(',')})};`).join('')}return r;`);
 async function record(name,label,expected){const actual=await state(name);const failures=Object.entries(expected).filter(([k,id])=>actual[k].id!==id);const t={name,label,expected,actual,passed:failures.length===0};tests.push(t);fs.writeFileSync(path.join(out,'cases.json'),JSON.stringify({identity,ports,tests},null,2));return t.passed;}
 await sleep(900);
 const li=ports.transfer_lighting.inputs;let prev=[0,0,0,0];
 for(let i=0;i<16;i++){const n=i^(i>>1),values=[n&1,(n>>1)&1,(n>>2)&1,(n>>3)&1];for(let j=0;j<4;j++)if(values[j]!==prev[j])await click(li[['A','B','E','Lock'][j]]);prev=values;await sleep(1500);const on=values[2]&&(values[0]||values[1])&&!values[3];await record('transfer_lighting','A,B,E,Lock='+values,{Left:on?207:199,Right:on?207:199,Far:on?207:199});}
 for(let j=0;j<4;j++)if(prev[j])await click(li[['A','B','E','Lock'][j]]);
 const pi=ports.transfer_puzzle.inputs;await click(pi.Reset);await sleep(2500);await click(pi.Reset);await sleep(1800);
 await record('transfer_puzzle','reset idle',{Ready:199,Door:230,DoorUpper:194,'M1.Q':191,'M2.Q':191});
 await click(pi.A);await sleep(1700);await record('transfer_puzzle','A pulse completed and released',{Ready:199,Door:230,'M1.Q':192,'M2.Q':191});
 await click(pi.A);await sleep(1400);await record('transfer_puzzle','A repeat preserves progress',{Ready:199,Door:230,'M1.Q':192,'M2.Q':191});
 await click(pi.B);await sleep(1800);await record('transfer_puzzle','both past achievements open door',{Ready:207,Door:231,DoorUpper:195,'M1.Q':192,'M2.Q':192});
 await click(pi.Reset);await sleep(2500);await record('transfer_puzzle','reset clears both memories and closes door',{Ready:199,Door:230,DoorUpper:194,'M1.Q':191,'M2.Q':191});
 await click(pi.A);await click(pi.B);await sleep(1700);await click(pi.Reset);await sleep(900);await record('transfer_puzzle','buttons during held reset do not leave progress',{Ready:199,Door:230,'M1.Q':191,'M2.Q':191});
 await click(pi.B);await sleep(1700);await click(pi.A);await sleep(1700);await record('transfer_puzzle','reverse order also completes',{Ready:207,Door:231,'M1.Q':192,'M2.Q':192});
 await click(pi.Reset);await sleep(1200);await click(pi.Reset);await sleep(800);
 const wi=ports.transfer_warning.inputs;await click(wi.Stop);await sleep(2500);await record('transfer_warning','startup stop initializes memory',{First:199,Second:199,Third:199,'Run.Q':191});
 async function trace(duration){await probe(`local outputs=${lua(Object.values(ports.transfer_warning.outputs))};local trace,start={},ParaGlobal.timeGetTime();local timer=commonlib.Timer:new({callbackFunc=function(t)local row={ms=ParaGlobal.timeGetTime()-start,states={}};for _,p in ipairs(outputs)do row.states[#row.states+1]=B:GetBlockId(unpack(p))==207 and 1 or 0 end;trace[#trace+1]=row;if row.ms>=${duration} then t:Change()end end});commonlib.setfield("TransferTrace",{trace=trace,timer=timer});timer:Change(0,40);return true;`);await sleep(duration+300);return probe('return TransferTrace.trace;')}
 await click(wi.Start);const running=await trace(10000);fs.writeFileSync(path.join(out,'running.json'),JSON.stringify(running,null,2));await record('transfer_warning','RUN latched after Start button released',{'Run.Q':192});
 await click(wi.Stop);const stopped=await trace(4500);fs.writeFileSync(path.join(out,'stopped.json'),JSON.stringify(stopped,null,2));await record('transfer_warning','stopped and drained',{First:199,Second:199,Third:199,'Run.Q':191});
 await click(wi.Start);const restarted=await trace(6500);fs.writeFileSync(path.join(out,'restarted.json'),JSON.stringify(restarted,null,2));await click(wi.Stop);await sleep(2200);await record('transfer_warning','second stop',{First:199,Second:199,Third:199,'Run.Q':191});
 const rises=rows=>Object.values(ports.transfer_warning.outputs).map((p,j)=>rows.filter((r,i)=>r.states[j]===1&&(i===0||rows[i-1].states[j]===0)).map(r=>r.ms));
 const runRises=rises(running),restartRises=rises(restarted);
 const sequenced=edges=>Array.from({length:Math.min(...edges.map(e=>e.length))},(_,i)=>edges[1][i]-edges[0][i]>=120&&edges[2][i]-edges[1][i]>=120).every(Boolean);
 const sequencePassed=sequenced(runRises)&&sequenced(restartRises);
 const clockPassed=runRises.every(r=>r.length>=2)&&restartRises.every(r=>r.length>=2)&&sequencePassed&&stopped.filter(r=>r.ms>=2000).every(r=>r.states.every(s=>s===0));
 const after=await cli('get_scene_info');assert.deepEqual(after.player.position,before.player.position);assert.equal(after.player.scaling,before.player.scaling);assert.deepEqual(after.camera,before.camera);
 const report={identity,ports,tests,runRises,restartRises,sequencePassed,clockPassed,before,after,log:await cli('tail_log')};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 assert(tests.every(t=>t.passed),'Failed cases: '+tests.filter(t=>!t.passed).map(t=>t.label).join('; '));assert(clockPassed,'Clock trace failed '+JSON.stringify({runRises,restartRises}));
 console.log(JSON.stringify({passed:tests.length,runRises,restartRises,output:out}));
}
main().catch(e=>{fs.writeFileSync(path.join(out,'failure.txt'),e.stack||e.message);console.error(e);process.exitCode=1;});
