const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),ts=require('typescript');
test('AIChat connection conflict returns occupied path and requires explicit compare-and-switch',async()=>{
 const old=require.extensions['.ts'];require.extensions['.ts']=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
 let handle,Occupied;try{handle=require('../src/mcp/personaHttp.ts').handlePersonaHttp;Occupied=require('../src/core/messaging.ts').ChannelOccupiedError;}finally{require.extensions['.ts']=old;}
 let current='C:/one';const switches=[];
 const messaging={async connectAgent(owner,id,root){if(root!==current)throw new Occupied('dingtalk',current,root);return {root,listening:true};},async switchChannel(channel,root,expected){if(expected!==current)throw new Occupied(channel,current,root);switches.push({channel,root,expected});current=root;}};
 const server=http.createServer((req,res)=>handle(req,res,new URL(req.url,'http://localhost'),{read:()=>({root:'C:/two',prompt:'fixture'})},messaging));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/agents/personas/agent/channel-connect';
 const post=body=>fetch(url,{method:'POST',headers:{Origin:'https://keepwork.com','X-Agent-Owner':'12345678-1234-1234-1234-123456789012','Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  let response=await post({root:'C:/two'});assert.equal(response.status,409);const conflict=await response.json();
  assert.equal(conflict.code,'CHANNEL_OCCUPIED');assert.equal(conflict.occupiedRoot,'C:/one');assert.equal(conflict.requestedRoot,'C:/two');assert.equal(conflict.confirmationRequired,true);assert.equal(switches.length,0);
  response=await post({root:'C:/two',switchFromRoot:'stale'});assert.equal(response.status,409);assert.equal(current,'C:/one');
  response=await post({root:'C:/two',switchFromRoot:conflict.occupiedRoot});assert.equal(response.status,200);assert.equal((await response.json()).root,'C:/two');assert.equal(switches.length,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
