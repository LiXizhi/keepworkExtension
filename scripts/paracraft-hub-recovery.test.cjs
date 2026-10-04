const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const config=require('../src/core/config.ts');
const {paracraftRequest,registerCreationTools}=require('../src/mcp/paracraftTools.ts');
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');

test('dead hub discovery uses configured port before a single request, while a live hub wins',async()=>{
 const original=config.readInstance,token=config.readToken;let requests=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({url:req.url,body});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{ok:true,jobId:'one'}}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  config.readToken=()=>'';
  config.readInstance=()=>({pid:2147483647,port:1});
  await paracraftRequest({viaHub:true,port},'client','run_code',{requestId:'once',code:'return 1'});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/paracraft/client/run_code');assert.equal(JSON.parse(requests[0].body).requestId,'once');
  config.readInstance=()=>({pid:process.pid,port});
  await paracraftRequest({viaHub:true,port:1});assert.equal(requests.length,2);assert.equal(requests[1].url,'/paracraft/clients');
  const mcp=new McpServer({name:'recovery',version:'1'}),client=new Client({name:'recovery',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();registerCreationTools(mcp,{viaHub:true,port:1});await mcp.connect(a);await client.connect(b);
  try{const r=await client.callTool({name:'paracraft_cli',arguments:{action:'launch',params:{projectId:987654,waitSeconds:0}}});assert(!r.isError);assert.equal(requests.length,3);assert.equal(requests[2].url,'/paracraft/launch');}finally{await client.close();await mcp.close();}
  config.readInstance=()=>({pid:process.pid,port:1});
  await assert.rejects(paracraftRequest({viaHub:true,port},'client','run_code',{requestId:'never-retry'}));assert.equal(requests.length,3,'A failed live endpoint retried a mutation on fallback');
 }finally{config.readInstance=original;config.readToken=token;await new Promise(r=>server.close(r));}
});
