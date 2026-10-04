// Simulate older capability replies around a real hub; no rejected mutation reaches it.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const saved=JSON.parse(fs.readFileSync('out/rsi/046/build/job.json')),out=path.resolve('out/rsi/047');fs.mkdirSync(out,{recursive:true});
(async()=>{
 let mode='old',reads=0,mutations=0;
 const proxy=http.createServer(async(req,res)=>{
  req.resume();if(!req.url.endsWith('/get_creation_capabilities')){mutations++;res.writeHead(500);res.end('unexpected mutation');return;}
  try{reads++;const r=await fetch('http://127.0.0.1:8089'+req.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const body=await r.json();assert(body.ok&&body.result.ok);if(mode==='old')delete body.result.voxelBoxBatch;else body.result.identity.sessionId++;
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
  }catch(e){res.writeHead(500);res.end(JSON.stringify({ok:false,error:e.message}));}
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const port=proxy.address().port;
 const bootstrap=`const fs=require('node:fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);require('./src/core/config.ts').readInstance=()=>({pid:process.pid,port:${port}});require('./src/mcp/stdio.ts').startStdioServer({port:${port},root:process.cwd()});`;
 const client=new Client({name:'cap-native-proxy',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['-e',bootstrap],cwd:path.resolve(__dirname,'..')}));
 const args={action:'run_template',clientId:saved.identity.clientId,chatSessionId:saved.session,params:saved.request};const errors=[];
 try{for(mode of ['old','changed']){const r=await client.callTool({name:'paracraft_cli',arguments:args});assert(r.isError);const error=r.content[0].text;assert.match(error,mode==='old'?/unsupported_capability: voxelBoxBatch/:/world_session_changed/);errors.push({mode,error});}assert.equal(reads,2);assert.equal(mutations,0);}finally{await client.close();await new Promise(r=>proxy.close(r));}
 const live=new Client({name:'cap-native-live',version:'1'});await live.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 try{const r=await live.callTool({name:'paracraft_cli',arguments:args});assert(!r.isError,r.content[0].text);const recovered=JSON.parse(r.content[0].text).result;assert.equal(recovered.jobId,saved.jobId);assert.equal(recovered.state,'completed');
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity:saved.identity,errors,capabilityReads:reads,rejectedMutationsForwarded:mutations,recoveredJobId:recovered.jobId,noNewConstruction:true},null,2));console.log('PASS fresh stdio rejects unavailable/changed capabilities before writes; live engine recovers original job');
 }finally{await live.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
