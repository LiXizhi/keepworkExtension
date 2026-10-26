const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
test('HTTP screenshot, settings, cancellation, and stdio forwarding use one authority',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-screenshot-http-')),originalHome=os.homedir;os.homedir=()=>home;
 let server;
 try {
  const {startHttpServer}=require('../src/mcp/http.ts');
  const {screenshotPermission}=require('../src/core/petPermissionBridge.ts');
  const capture=require('../src/core/desktopCapture.ts');
  const {createComputerHub}=require('../src/mcp/computerHub.ts');
  const {AichatNativeTools}=require('../src/core/aichatNativeTools.ts');
  let choose,captures=0; screenshotPermission.pet={request:(request,signal)=>new Promise((resolve,reject)=>{choose=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})};
  capture.captureDesktop=async()=>{captures++;return JSON.stringify({width:800,height:600,data:'aW1hZ2U='});};
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  server=await startHttpServer({port,root:home,requireAuth:true});
  const base=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${server.token}`,Origin:base,'Content-Type':'application/json'};
  const setting=(method='GET',body,extra={})=>fetch(base+'/admin/screenshot-permission',{method,headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await setting('GET',undefined,{Authorization:''})).status,401);
  assert.equal((await setting('POST',{alwaysAllowScreenshots:true},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await setting('POST',{alwaysAllowScreenshots:true},{Origin:''})).status,403);
  assert.equal((await (await setting()).json()).alwaysAllowScreenshots,false);
  async function waitForPrompt(){for(let i=0;i<100&&!screenshotPermission.status().pending;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(screenshotPermission.status().pending,true);}
  let enabling=setting('POST',{alwaysAllowScreenshots:true});await waitForPrompt();choose('always');assert.equal((await (await enabling).json()).alwaysAllowScreenshots,true);assert.equal(captures,0);
  const hub=createComputerHub(port,()=> 'stdio teacher fixture');t.after(()=>hub.close());
  let result=await hub.call({action:'screenshot'},new AbortController().signal);assert.equal(result.content[1].type,'image');assert.equal(captures,1);
  await setting('POST',{alwaysAllowScreenshots:false});assert.equal((await (await setting()).json()).alwaysAllowScreenshots,false);
  const abort=new AbortController();let pending=hub.call({action:'screenshot'},abort.signal);await waitForPrompt();abort.abort();await assert.rejects(pending);for(let i=0;i<100&&screenshotPermission.status().pending;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(screenshotPermission.status().pending,false);assert.equal(captures,1);
  pending=hub.call({action:'screenshot'},new AbortController().signal);await waitForPrompt();choose('once');result=await pending;assert.equal(result.content[1].type,'image');assert.equal(captures,2);assert.equal((await (await setting()).json()).alwaysAllowScreenshots,false);
  enabling=setting('POST',{alwaysAllowScreenshots:true});await waitForPrompt();const oldChoice=choose;await setting('POST',{alwaysAllowScreenshots:false});assert.equal((await enabling).status,400);oldChoice('always');assert.equal((await (await setting()).json()).alwaysAllowScreenshots,false);
  const native=new AichatNativeTools(()=>({url:base+'/mcp',token:server.token}));
  try {
   pending=native.call('computer_use',{action:'screenshot'},new AbortController().signal);await waitForPrompt();choose('once');assert.equal((await pending).content[1].type,'image');assert.equal(captures,3);
  } finally {native.close();}
  hub.close();
 } finally {if(server)await server.close();os.homedir=originalHome;fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
