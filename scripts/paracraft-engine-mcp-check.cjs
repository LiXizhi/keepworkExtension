// Read-only fresh-session discovery/recovery check; never repeats construction.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const [requestFile,jobFile]=process.argv.slice(2);assert(requestFile&&jobFile,'Pass saved native request.json and job.json');
const request=JSON.parse(fs.readFileSync(requestFile,'utf8')),job=JSON.parse(fs.readFileSync(jobFile,'utf8'));
const client=new Client({name:'engine-skill-acceptance',version:'1'});
async function main(){
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8089/mcp')));
 const call=async(action,params)=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:request.expectedIdentity.clientId,chatSessionId:request.authoringSession,params}});assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content.find(c=>c.type==='text').text);};
 const info=await call('template_info',{template:'engine_games'});assert.equal(info.template,'engine_games');
 const guide=await call('skill',{path:'references/game-engine.md'});assert(guide.content.includes('Paracraft'));
 const recovered=await call('code_job',{expectedIdentity:request.expectedIdentity,requestId:request.requestId});
 const result=recovered.result||recovered;assert.equal(result.jobId,job.jobId);assert.equal(result.state,'completed');
 console.log(JSON.stringify({template:info.template,sourceBytes:info.sourceBytes,guideBytes:Buffer.byteLength(guide.content),recoveredJob:result.jobId,state:result.state}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>client.close());
