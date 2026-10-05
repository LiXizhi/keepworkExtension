// Read the existing acceptance job; window restoration must never rebuild it.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const saved=JSON.parse(fs.readFileSync('out/rsi/057/build/job.json'));
const job=JSON.parse(fs.readFileSync('out/rsi/057/revision-corrected/latest-job.json'));
const out=path.resolve('out/rsi/058');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const c=new Client({name:'window-native',version:'1'});
 await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const raw=async(action,params={})=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:saved.identity.clientId,chatSessionId:saved.session,params}});assert(!r.isError,r.content[0]?.text);return r;};
 const call=async(a,p)=>JSON.parse((await raw(a,p)).content[0].text);
 try{
  const before=(await call('get_scene_info')).result;
  const restored=await call('bring_to_front');assert(restored.ok);
  const r=await raw('camera_capture',{expectedIdentity:saved.identity,...job.result.overview});
  const metadata=JSON.parse(r.content[0].text),pixels=r.content.find(x=>x.type==='image');
  assert(pixels&&metadata.sessionId===saved.identity.sessionId);
  fs.writeFileSync(path.join(out,'overview.jpg'),Buffer.from(pixels.data,'base64'));
  const after=(await call('get_scene_info')).result;
  assert.deepEqual(after.player,before.player);assert.deepEqual(after.camera,before.camera);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity:saved.identity,jobId:job.jobId,restored,metadata,playerUnchanged:true,cameraUnchanged:true,noCreationSubmitted:true},null,2));
  console.log('PASS native bring_to_front, fresh MCP image, stationary player/camera; no creation submitted');
 }finally{await c.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
