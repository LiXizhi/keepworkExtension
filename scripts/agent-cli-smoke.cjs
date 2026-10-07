const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {AgentSessions,AGENT_BACKENDS}=require('../src/core/agentSessions.ts');const {handleAgentHttp}=require('../src/mcp/agentHttp.ts');
const {verify}=require('../skills/agent-cli-verify/scripts/verify.cjs');
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-cli-service-'));
 const manager=new AgentSessions(path.join(temp,'registry.json'));
 const server=require('node:http').createServer((req,res)=>{
   if(req.headers.origin!=='http://localhost:3000'){res.writeHead(403);res.end();return;}
   return handleAgentHttp(req,res,new URL(req.url,'http://localhost'),manager);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const args=process.argv.slice(2),i=args.indexOf('--backend'),backend=i<0?null:args[i+1];
 if(backend&&!AGENT_BACKENDS.includes(backend))throw new Error('Unsupported backend');
 const reportIndex=args.indexOf('--report');
 try{const report=await verify(`http://127.0.0.1:${server.address().port}`,{...(backend?{backends:[backend]}:{}),probeOnly:args.includes('--probe-only'),...(reportIndex<0?{}:{reportFile:path.resolve(args[reportIndex+1])})});if(!report.passed)process.exitCode=1;}
 finally{manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
