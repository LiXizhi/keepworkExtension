// Native HTTP decoding validation only; never submit a creation/world mutation.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const out=path.resolve('out/rsi/068');fs.mkdirSync(out,{recursive:true});
function native(method,body,query=''){
 return new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli'+query,method,headers:body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});q.on('error',reject);q.setTimeout(30000,()=>q.destroy(new Error('native request timeout')));q.end(body);});
}
(async()=>{
 const results=[];
 const valid=await native('POST',JSON.stringify({v:1,id:'readonly-native-068',action:'get_creation_capabilities',params:{}}));assert(valid.ok&&valid.action==='get_creation_capabilities'&&valid.id==='readonly-native-068');results.push({kind:'valid',action:valid.action,identity:valid.result.identity});
 const get=await native('GET',undefined,'?action=health');assert(get.ok&&get.action==='health');results.push({kind:'get',action:get.action});
 for(const [body,error]of [['{','invalid_json_body'],['{}','missing_action'],['{"action":"health","params":"bad"}','invalid_params']]){const r=await native('POST',body);assert.equal(r.ok,false);assert.equal(r.error,error);results.push({kind:'invalid',error:r.error});}
 const response=await fetch('http://127.0.0.1:8099/ajax/paracraft_cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({v:1,action:'get_creation_capabilities',params:{}})});const r=await response.json();assert.equal(r.ok,false);assert.equal(r.error,'invalid_json_body');results.push({kind:'older-engine-fetch-explicit-error',error:r.error});
 fs.writeFileSync(path.join(out,'http-report.json'),JSON.stringify({passed:6,noMutations:true,results},null,2));console.log('PASS native HTTP valid command, GET compatibility, invalid envelopes and fetch no false health');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
