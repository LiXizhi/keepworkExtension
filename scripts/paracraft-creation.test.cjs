const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { paracraftResult, paracraftRequest, registerCreationTools, creationSchemas } = require('../src/mcp/paracraftTools.ts');
const { summarizeCreationJob } = require('../src/mcp/paracraftJobResult.ts');
const hub = require('../src/core/paracraftClients.ts');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('job recovery accepts exactly one bounded job ID or request ID',()=>{
 const expectedIdentity={clientId:'c',worldPath:'world/',sessionId:1};
 assert.equal(creationSchemas.code_job.parse({clientId:'c',expectedIdentity,requestId:'lost-response'}).requestId,'lost-response');
 assert.equal(creationSchemas.code_job.parse({clientId:'c',expectedIdentity,jobId:'creation-1'}).jobId,'creation-1');
 for(const args of [{},{jobId:'a',requestId:'b'},{requestId:''},{requestId:'x'.repeat(129)},{jobId:42}]){
  assert.throws(()=>creationSchemas.code_job.parse({clientId:'c',expectedIdentity,...args}));
 }
});

test('request recovery forwards only a read and rejects older engines explicitly',async()=>{
 const server=new McpServer({name:'request-recovery',version:'1'});registerCreationTools(server,{port:8089});
 const client=new Client({name:'request-recovery-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const clientId='request-recovery-test',expectedIdentity={clientId,worldPath:'test/',sessionId:3};await hub.registerClient({clientId});
 try{
  for(const supported of [true,false]){
   const pending=client.callTool({name:'paracraft_cli',arguments:{action:'code_job',clientId,chatSessionId:'same-chat',params:{expectedIdentity,requestId:'lost-first-response'}}});
   const [caps]=await hub.pollJobs(clientId,2000);assert.equal(caps.request.action,'get_creation_capabilities');hub.completeJob(clientId,caps.jobId,{ok:true,result:{ok:true,requestJobLookup:supported}});
   if(supported){
    const [read]=await hub.pollJobs(clientId,2000);assert.equal(read.request.action,'code_job');assert.equal(read.request.params.requestId,'lost-first-response');assert.equal(read.request.params.authoringSession,'same-chat');assert.equal(read.request.params.jobId,undefined);
    hub.completeJob(clientId,read.jobId,{ok:true,result:{ok:true,state:'completed',jobId:'creation-1',requestId:'lost-first-response'}});assert(!(await pending).isError);
   }else{
    const response=await pending;assert(response.isError);assert.match(response.content[0].text,/unsupported_capability/);assert.deepEqual(await hub.pollJobs(clientId,10),[]);
   }
  }
 }finally{hub.unregisterClient(clientId);await client.close();await server.close();}
});

test('MCP image content separates bytes from metadata and refuses cache/error', () => {
    const result = paracraftResult(200, { ok: true, result: { ok: true, base64: 'AQID', mimeType: 'image/jpeg', sessionId: 4, timestamp: 123 } }, true);
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].data, 'AQID');
    assert.equal(JSON.parse(result.content[0].text).sessionId, 4);
    assert.ok(!result.content[0].text.includes('AQID'));
    assert.equal(paracraftResult(200, { result: { cached: true, base64: 'AQID', mimeType: 'image/jpeg' } }, true).isError, true);
    assert.equal(paracraftResult(200, { ok: false, error: 'unsupported action' }).isError, true);
});

test('standard MCP client sends jobs and receives native images through engine poll', async () => {
    const server = new McpServer({ name: 'creation-test', version: '1' });
    registerCreationTools(server, { port: 8089 });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const clientId = 'creation-mcp-test';
    await hub.registerClient({ clientId });
    const identity = { clientId, worldPath: 'test/', sessionId: 3 };
    try {
        const list = await client.listTools();
        assert.deepEqual(list.tools.map(t => t.name), ['paracraft_cli']);
        for (const [action, args, reply] of [
            ['run_code', { expectedIdentity: identity, requestId: 'same-id', code: 'wait(1); return 42' }, { ok: true, jobId: 'creation-1' }],
            ['code_job', { expectedIdentity: identity, jobId: 'creation-1', operation: 'status' }, { ok: true, state: 'completed', sourceCompleted: true }],
            ['camera_capture', { expectedIdentity: identity, nearPet: true }, { ok: true, base64: 'AQID', mimeType: 'image/jpeg', sessionId: 3 }],
        ]) {
            const pending = client.callTool({ name: 'paracraft_cli', arguments: { action, clientId, params: args } });
            const [job] = await hub.pollJobs(clientId, 2000);
            assert.equal(job.request.action, action);
            assert.ok(job.request.params.authoringSession);
            assert.equal(job.request.params.petId, 'main');
            const {authoringSession, petId, ...forwarded} = job.request.params;
            assert.deepEqual(forwarded, args);
            hub.completeJob(clientId, job.jobId, { ok: true, result: reply });
            const result = await pending;
            assert.ok(!result.isError);
            if (action === 'camera_capture') assert.equal(result.content[1].type, 'image');
        }
    } finally { hub.unregisterClient(clientId); await client.close(); await server.close(); }
});

test('stdio transport uses singleton loopback hub and never repeats requests', async () => {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => { calls.push({ url, options }); return { status: 200, json: async () => ({ ok: true, result: { jobId: 'one' } }) }; };
    try {
        await paracraftRequest({ port: 8089, viaHub: true }, 'client', 'run_code', { requestId: 'recover', code: 'return 1' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/paracraft\/client\/run_code$/);
        assert.equal(JSON.parse(calls[0].options.body).requestId, 'recover');
    } finally { global.fetch = original; }
});

function denseJob() {
    return {ok:true,result:{ok:true,jobId:'same-job',state:'completed',sourceCompleted:true,runtimeActive:false,
        error:'retained diagnostic',output:'retained output',site:{origin:[1,5,1]},created:[{movie:[1,5,1]}],
        result:{name:'plane',files:{body:'blocktemplates/plane.x'},custom:[1,2,3],animation:{moviePosition:[1,5,1],times:[0,1,2],
            actors:[{name:'body',expectedMeters:[8,2.25,6.1875],rotationKeys:Array.from({length:129},(_,i)=>({time:i/64,rotation:[Math.sin(i),0,0,Math.cos(i)]}))}]}}}};
}
test('job summary omits only dense rotation detail, retains errors/references and never mutates authoritative results',()=>{
    const full=denseJob(),original=JSON.stringify(full),compact=summarizeCreationJob(full);
    assert.equal(JSON.stringify(full),original);
    assert.equal(compact.result.result.animation.actors[0].rotationKeys,undefined);
    assert.deepEqual(compact.result.resultDetails.omitted,[{path:'result.animation.actors[0].rotationKeys',count:129,firstSeconds:0,lastSeconds:2}]);
    for(const key of ['jobId','state','sourceCompleted','runtimeActive','error','output','site','created'])assert.deepEqual(compact.result[key],full.result[key]);
    assert.deepEqual(compact.result.result.files,full.result.result.files);assert.deepEqual(compact.result.result.custom,[1,2,3]);
    assert(JSON.stringify(compact).length<original.length/4);
    for(const body of [null,42,{ok:false,error:'wrong session'}, {ok:true,result:{ok:false,state:'failed',error:'failed'}},
        {ok:true,result:{state:'completed',result:{custom:[1,2,3]}}}])assert.equal(summarizeCreationJob(body),body);
});

test('single MCP gateway defaults to summary and recovers full results from the same job without forwarding display options',async()=>{
    const server=new McpServer({name:'compact-test',version:'1'});registerCreationTools(server,{port:8089});
    const client=new Client({name:'compact-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);const clientId='compact-test';await hub.registerClient({clientId});
    const expectedIdentity={clientId,worldPath:'test/',sessionId:2};
    try{
        for(const detail of [undefined,'full']){
            const pending=client.callTool({name:'paracraft_cli',arguments:{action:'code_job',clientId,chatSessionId:'same-chat',params:{expectedIdentity,jobId:'same-job',...(detail?{resultDetail:detail}:{})}}});
            const[job]=await hub.pollJobs(clientId,2000);
            assert.equal(job.request.action,'code_job');assert.equal(job.request.params.jobId,'same-job');
            assert.equal(job.request.params.authoringSession,'same-chat');assert.equal(job.request.params.resultDetail,undefined);
            const full=denseJob();hub.completeJob(clientId,job.jobId,full);
            const result=JSON.parse((await pending).content[0].text);assert.equal(result.result.jobId,'same-job');
            if(detail==='full')assert.deepEqual(result,full);else assert.equal(result.result.resultDetails.omitted[0].count,129);
        }
        assert.equal((await client.callTool({name:'paracraft_cli',arguments:{action:'code_job',clientId,params:{expectedIdentity,jobId:'same-job',resultDetail:'invalid'}}})).isError,true);
        assert.equal((await hub.pollJobs(clientId,0)).length,0,'Rejected view forwarded a native call');
    }finally{hub.unregisterClient(clientId);await client.close();await server.close();}
});

test('isolated asset feedback checks engine capability and returns PNG through the same CLI', async () => {
    const server=new McpServer({name:'asset-capture-test',version:'1'});registerCreationTools(server,{port:8089});
    const client=new Client({name:'asset-capture-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    const clientId='isolated-asset-test';await hub.registerClient({clientId});
    const identity={clientId,worldPath:'test/',sessionId:4};
    const args={expectedIdentity:identity,asset:{filename:'blocktemplates/person.x',animId:1,timeSeconds:0.5}};
    try{
        for(const supported of [false,true]){
            const pending=client.callTool({name:'paracraft_cli',arguments:{action:'camera_capture',clientId,params:args}});
            const[cap]=await hub.pollJobs(clientId,2000);assert.equal(cap.request.action,'get_creation_capabilities');
            hub.completeJob(clientId,cap.jobId,{ok:true,result:{isolatedAssetCapture:supported}});
            if(!supported){assert.match((await pending).content[0].text,/unsupported_capability/);assert.equal((await hub.pollJobs(clientId,0)).length,0);continue;}
            const[image]=await hub.pollJobs(clientId,2000);assert.equal(image.request.action,'camera_capture');
            assert.deepEqual(image.request.params.asset,args.asset);assert.deepEqual(image.request.params.expectedIdentity,identity);
            hub.completeJob(clientId,image.jobId,{ok:true,result:{ok:true,isolated:true,sessionId:4,mimeType:'image/png',base64:'AQID'}});
            const result=await pending;assert(!result.isError);assert.equal(result.content[1].mimeType,'image/png');
            assert.equal(JSON.parse(result.content[0].text).isolated,true);assert(!result.content[0].text.includes('AQID'));
        }
    }finally{hub.unregisterClient(clientId);await client.close();await server.close();}
});

test('isolated assembly capture is lazy and rejects older engines before seeking',async()=>{
 const server=new McpServer({name:'assembly-test',version:'1'});registerCreationTools(server,{port:8089});
 const client=new Client({name:'assembly-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);const clientId='assembly-test';await hub.registerClient({clientId});
 const expectedIdentity={clientId,worldPath:'test/',sessionId:2},assembly={moviePosition:[0,5,0],timeSeconds:1.25,actors:['body','front']};
 try{
  for(const supported of [false,true]){
   const pending=client.callTool({name:'paracraft_cli',arguments:{action:'camera_capture',clientId,params:{expectedIdentity,assembly}}});
   const[cap]=await hub.pollJobs(clientId,2000);assert.equal(cap.request.action,'get_creation_capabilities');
   hub.completeJob(clientId,cap.jobId,{ok:true,result:{isolatedAssemblyCapture:supported}});
   if(!supported){assert.match((await pending).content[0].text,/unsupported_capability/);assert.equal((await hub.pollJobs(clientId,0)).length,0);continue;}
   const[image]=await hub.pollJobs(clientId,2000);assert.deepEqual(image.request.params.assembly,assembly);
   hub.completeJob(clientId,image.jobId,{ok:true,result:{ok:true,isolated:true,mimeType:'image/png',sessionId:2,base64:'AQID'}});
   const result=await pending;assert(!result.isError);assert.equal(result.content[1].mimeType,'image/png');assert(!result.content[0].text.includes('AQID'));
  }
 }finally{hub.unregisterClient(clientId);await client.close();await server.close();}
});
