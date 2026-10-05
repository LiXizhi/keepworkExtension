// Check actual captured native transforms against design meters and floor contact.
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const [reportArg,boundsArg,nativeArg]=process.argv.slice(2);assert(reportArg&&boundsArg&&nativeArg);
const report=JSON.parse(fs.readFileSync(reportArg,'utf8')),b=JSON.parse(fs.readFileSync(boundsArg,'utf8')).legBounds;
const native=JSON.parse(fs.readFileSync(nativeArg,'utf8')),unit=native.result.blocksize;
assert.deepEqual(native.identity,report.identity);assert(Number.isFinite(unit)&&unit>0);
const rotate=(p,q)=>{
 const cross=(a,c)=>[a[1]*c[2]-a[2]*c[1],a[2]*c[0]-a[0]*c[2],a[0]*c[1]-a[1]*c[0]];
 const v=q.slice(0,3),t=cross(v,p).map(n=>2*n),u=cross(v,t);
 return p.map((n,i)=>n+q[3]*t[i]+u[i]);
};
const samples=[];
for(const frame of report.images){
 const parts=frame.metadata.assembly.actors,time=frame.timeSeconds,feet=[];
 for(const name of ['front_left','front_right','rear_left','rear_right']){
  const part=parts.find(p=>p.name===name),bone=part.bones.find(p=>p.name==='root');assert(part.scale===1);
  const phase=['front_left','rear_right'].includes(name)?1:-1;
  let lift=0;
  if(time>=1){
   const fraction=time*4-Math.floor(time*4);
   const at=t=>{const wave=Math.sin(2*Math.PI*t)*phase;return 3/64*Math.abs(wave*0.3)+Math.max(0,wave)/64;};
   const lower=Math.floor(time*4)/4;lift=at(lower)*(1-fraction)+at(lower+0.25)*fraction;
  }
  assert(Math.abs(bone.translation[1]/unit-lift)<2e-5,'Bone lift is not in design meters');
  let minY=Infinity;
  for(const x of [b.min_x,b.max_x])for(const z of [b.min_z,b.max_z]){
   const p=rotate([x,b.min_y,z],bone.rotation);
   minY=Math.min(minY,part.positionMeters[1]+(p[1]+bone.translation[1])/unit);
  }
  assert(minY>=-2e-5,`${name} clips below floor at ${time}: ${minY}`);
  if(time<=1||time===3)assert(Math.abs(minY)<2e-5,'Rest feet not planted');
  feet.push({name,minY,liftMeters:bone.translation[1]/unit});
 }
 const q=name=>parts.find(p=>p.name===name).bones[0].rotation;
 assert(Math.abs(q('front_left').reduce((sum,n,i)=>sum+n*q('rear_right')[i],0))>0.9999,'Diagonal pair not synchronized');
 assert(Math.abs(q('front_right').reduce((sum,n,i)=>sum+n*q('rear_left')[i],0))>0.9999,'Other diagonal pair not synchronized');
 samples.push({timeSeconds:time,feet});
}
assert(samples.some(s=>s.timeSeconds===1.125),'Missing between-key pose');
fs.writeFileSync(path.join(path.dirname(reportArg),'foot-check.json'),JSON.stringify({samples,unit,scaleOne:true,restFeetPlanted:true,interpolatedPoseChecked:true},null,2));
console.log(`PASS ${samples.length} native poses: meter-based lift, diagonal gait and no below-floor foot corners`);
