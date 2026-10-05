const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const {creationSchemas}=require('../src/mcp/paracraftTools.ts');
const hub=require('../src/core/paracraftClients.ts');
const {createMcpServer}=require('../src/mcp/server.ts');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const identity={clientId:'memory-test',worldPath:'fixture/',sessionId:1};
test('world memory schemas require identity and retain lazy world-object detail access',()=>{
 assert(!creationSchemas.analyze_world.safeParse({clientId:identity.clientId}).success);
 assert(creationSchemas.analyze_world.safeParse({clientId:identity.clientId,expectedIdentity:identity,kind:'module',bounds:{min:[0,0,0],max:[1,2,3]}}).success);
 assert(!creationSchemas.world_docs.safeParse({clientId:identity.clientId,expectedIdentity:identity,operation:'save'}).success);
 for(const view of ['auto','summary','objects']) assert(creationSchemas.analyze_world.safeParse({clientId:identity.clientId,expectedIdentity:identity,view}).success);
 assert(!creationSchemas.analyze_world.safeParse({clientId:identity.clientId,expectedIdentity:identity,view:'all'}).success);
 assert(creationSchemas.read_scene_object.safeParse({clientId:identity.clientId,ref:{kind:'world_object',id:'world1/EntityCode:0,1,0',worldSession:'memory-test:1'},details:true}).success);
});
test('single MCP gateway discovers and forwards native world-memory actions',async()=>{
 const server=createMcpServer({port:8089,root:process.cwd(),requireAuth:false,startedAt:new Date().toISOString()});
 const client=new Client({name:'memory-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);await hub.registerClient({clientId:identity.clientId});
 try {
  for(const action of ['world_docs','analyze_world']){
   const help=await client.callTool({name:'paracraft_cli',arguments:{action:'help',params:{action}}});
   assert(JSON.parse(help.content[0].text).inputSchema.properties.expectedIdentity);
   const params=action==='world_docs'?{operation:'init',expectedIdentity:identity}:{kind:'code',expectedIdentity:identity,view:'summary'};
   const pending=client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,params}});
   const [probe]=await hub.pollJobs(identity.clientId,1000);assert.equal(probe.request.action,'get_creation_capabilities');
   hub.completeJob(identity.clientId,probe.jobId,{ok:true,result:{ok:true,identity,worldDocuments:true,worldAnalysis:true}});
   const [job]=await hub.pollJobs(identity.clientId,1000);assert.equal(job.request.action,action);assert.deepEqual(job.request.params.expectedIdentity,identity);
   if(action==='analyze_world') assert.equal(job.request.params.view,'summary');
   hub.completeJob(identity.clientId,job.jobId,{ok:true,result:{ok:true,worldSaved:false}});
   const response=await pending;assert(!response.isError);
  }
  const pending=client.callTool({name:'paracraft_cli',arguments:{action:'world_docs',clientId:identity.clientId,params:{operation:'init',expectedIdentity:identity}}});
  const [probe]=await hub.pollJobs(identity.clientId,1000);
  hub.completeJob(identity.clientId,probe.jobId,{ok:true,result:{ok:true,identity}});
  const rejected=await pending;assert(rejected.isError);assert.match(rejected.content[0].text,/unsupported_capability/);
  assert.deepEqual(await hub.pollJobs(identity.clientId,10),[]);
 }finally{hub.unregisterClient(identity.clientId);await client.close();await server.close();}
});
