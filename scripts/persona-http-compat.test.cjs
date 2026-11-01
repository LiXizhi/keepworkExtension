const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {handlePersonaHttp}=require('../src/mcp/personaHttp.ts');
test('legacy HTTP payloads remain accepted; unsupported features have additive codes and no execution',async t=>{
 const calls=[];
 const personas={read:()=>({id:'agent',messages:[]}),list:()=>[{id:'agent'}],submit:(owner,id,input)=>{if(input.contextMode&&!['conversation','isolated'].includes(input.contextMode))throw Object.assign(Error('Unsupported contextMode'),{code:'UNSUPPORTED_FEATURE'});calls.push(input);return {id,job:{state:'queued'}};}};
 const server=http.createServer((req,res)=>void handlePersonaHttp(req,res,new URL(req.url,'http://localhost'),personas,{}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/agents/personas`;
 const headers={Origin:'https://keepwork.com','X-Agent-Owner':'a'.repeat(48),'Content-Type':'application/json'};
 const send=(path,input)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(input)});
 const old={requestId:'old',text:'hello'};const legacy=await send('/agent/messages',old);assert.equal(legacy.status,200);assert.equal((await legacy.json()).job.state,'queued');assert.deepEqual(calls,[old]);
 const unknown=await send('/agent/future-operation',{});assert.equal(unknown.status,404);assert.deepEqual(await unknown.json(),{error:'Unknown Agent operation',code:'UNSUPPORTED_FEATURE'});
 const future=await send('/agent/messages',{requestId:'future',text:'hello',contextMode:'future'});assert.equal(future.status,422);assert.equal((await future.json()).code,'UNSUPPORTED_FEATURE');assert.equal(calls.length,1);
 const ordinary=await send('/agent/messages',{requestId:'next',text:'still works'});assert.equal(ordinary.status,200);await ordinary.json();assert.equal(calls.length,2);
 const list=await fetch(url,{headers});assert.equal(list.status,200);assert.ok(Array.isArray((await list.json()).agents));
});
