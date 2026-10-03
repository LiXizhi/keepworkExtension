// Opt-in: node scripts/paracraft-launch-native.cjs <Keepwork-project-id>
// Opens/reuses the project through MCP; does not edit or save it.
const assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
async function main() {
 const projectId=Number(process.argv[2]);assert.ok(Number.isSafeInteger(projectId)&&projectId>0,'Positive project ID required');
 const client=new Client({name:'codex-native-protocol-launch',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8089/mcp')));
 const call=async(action,params={},clientId)=>{
  const r=await client.callTool({name:'paracraft_cli',arguments:{action,params,...(clientId?{clientId}:{})}});
  assert.ok(!r.isError,r.content[0]?.text);return JSON.parse(r.content[0].text);
 };
 try {
  let launch=await call('launch',{projectId,waitSeconds:20});
  const launchId=launch.launchId;
  for(let i=0;launch.state==='waiting'&&i<4;i++)launch=await call('launch_status',{launchId,waitSeconds:15});
  assert.equal(launch.state,'ready',JSON.stringify(launch));assert.ok(launch.clientId);
  const list=await call('clients');const clients=Array.isArray(list)?list:list.clients;
  const native=clients.find(c=>c.clientId===launch.clientId);
  assert.ok(native?.worldEntered);assert.equal(Number(native.kpProjectId),projectId);assert.notEqual(native.platform,'wasm');
  const health=await call('health',{},native.clientId);assert.notEqual(health.ok,false);
  const reuse=await call('launch',{projectId,waitSeconds:0});
  assert.equal(reuse.reused,true);assert.equal(reuse.clientId,native.clientId);
  console.log(JSON.stringify({ok:true,projectId,clientId:native.clientId,worldName:native.worldName,nplPort:native.nplPort,reused:true}));
 } finally {await client.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
