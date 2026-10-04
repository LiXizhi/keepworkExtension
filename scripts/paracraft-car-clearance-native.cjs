const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const [reportArg]=process.argv.slice(2);
assert(reportArg,'Usage: node scripts/paracraft-car-clearance-native.cjs NATIVE_CAR_REPORT');
const report=JSON.parse(fs.readFileSync(reportArg,'utf8'));
const dir=path.dirname(reportArg),identity=report.identity;
assert(report.result.animation.wheelRadiusMeters===0.3125);
async function cli(action,params){
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('capture timeout')));req.end(body);
 });assert(reply.ok,JSON.stringify(reply));assert.notEqual(reply.result.ok,false,JSON.stringify(reply.result));return reply.result;
}
(async()=>{
 const cap=await cli('get_creation_capabilities',{});assert.deepEqual(cap.identity,identity);
 assert(/^[\w-]+$/.test(report.result.name)&&Number.isInteger(identity.sessionId));
 const steer=report.result.animation.steering?.maximumRadians||0;
 assert(Number.isFinite(steer)&&steer>=0&&steer<=Math.PI/2);
 const code=`local worldPath=${JSON.stringify(identity.worldPath)};local sessionId=${identity.sessionId};local sceneName=${JSON.stringify(report.result.name)};local steer=${steer};\n`+
  fs.readFileSync(path.join(__dirname,'paracraft-car-clearance.lua'),'utf8');
 const audit=(await cli('run_npl_code',{code})).result;
 assert(audit.minimumBodyGapMeters>0.001);
 const captures=[];
 for(const part of ['body','wheel']){
  const capture=await cli('camera_capture',{expectedIdentity:identity,authoringSession:report.performance.authoringSession,
   asset:{filename:report.result.files[part],yaw:0.65,elevation:0.2,size:512}});
  assert(capture.base64&&capture.isolated&&capture.sessionId===identity.sessionId);
  fs.writeFileSync(path.join(dir,part+'.png'),Buffer.from(capture.base64,'base64'));
  delete capture.base64;captures.push({part,capture});
 }
 fs.writeFileSync(path.join(dir,'clearance.json'),JSON.stringify({identity,audit,captures},null,2));
 console.log('PASS native car: all source carriers fresh, swept tire geometry clear at four axles, isolated parts');
 console.log(audit);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
