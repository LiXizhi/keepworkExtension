const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const [reportArg]=process.argv.slice(2);
assert(reportArg,'Usage: node scripts/paracraft-aircraft-clearance-native.cjs NATIVE_AIRCRAFT_REPORT');
const report=JSON.parse(fs.readFileSync(reportArg,'utf8')),identity=report.identity;
assert(/^[\w-]+$/.test(report.result.name)&&Number.isInteger(identity.sessionId));
async function cli(action,params){
 const body=JSON.stringify({v:1,action,params});
 const reply=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('audit timeout')));req.end(body);
 });assert(reply.ok,JSON.stringify(reply));assert.notEqual(reply.result.ok,false,JSON.stringify(reply.result));return reply.result;
}
(async()=>{
 assert.deepEqual((await cli('get_creation_capabilities',{})).identity,identity);
 const code=`local worldPath=${JSON.stringify(identity.worldPath)};local sessionId=${identity.sessionId};local sceneName=${JSON.stringify(report.result.name)};\n`+
  fs.readFileSync(path.join(__dirname,'paracraft-aircraft-clearance.lua'),'utf8');
 const audit=(await cli('run_npl_code',{code})).result;
 assert(audit.minimumCowlingGapMeters>0&&audit.groundGapMeters>0);
 fs.writeFileSync(path.join(path.dirname(reportArg),'clearance.json'),JSON.stringify({identity,audit},null,2));
 if(report.result.animation.banking){
  const attachmentCode=`local worldPath=${JSON.stringify(identity.worldPath)};local sessionId=${identity.sessionId};local moviePosition={${report.result.animation.moviePosition.join(',')}};\n`+
   fs.readFileSync(path.join(__dirname,'paracraft-aircraft-attachments.lua'),'utf8');
  const attachments=(await cli('run_npl_code',{code:attachmentCode})).result;
  fs.writeFileSync(path.join(path.dirname(reportArg),'attachments.json'),JSON.stringify({identity,attachments},null,2));
  console.log(attachments);
  assert(attachments.maximumAttachmentErrorMeters<0.001&&attachments.maximumPropellerAxisVectorError<0.001&&attachments.loopContinuous);
 }
 console.log('PASS native aircraft rotor sweep, shaft contact and ground clearance');console.log(audit);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
