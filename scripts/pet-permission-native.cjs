// Native UI acceptance with an isolated permission bridge; never grants real capture permission.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
const { PetPermissionBridge } = require('../src/core/petPermissionBridge.ts');
async function main() {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-native-pet-'));
 const oldPetHome=process.env.KEEPWORK_PET_HOME;process.env.KEEPWORK_PET_HOME=home;
 const launchBridge=new PetPermissionBridge(undefined,()=>home);
 try {
  const cancel=new AbortController(), first=launchBridge.request({id:'native-launch',client:'Standalone MCP launch test'},cancel.signal);
  await new Promise((resolve,reject)=>{const limit=setTimeout(()=>{clearInterval(timer);reject(Error('Bundled pet did not launch'));},15000);const timer=setInterval(()=>{if(launchBridge.peer){clearInterval(timer);clearTimeout(limit);resolve();}},20);});
  cancel.abort();await assert.rejects(first,/cancelled/);
 } finally {launchBridge.close();if(oldPetHome===undefined)delete process.env.KEEPWORK_PET_HOME;else process.env.KEEPWORK_PET_HOME=oldPetHome;}
 const bridge=new PetPermissionBridge(()=>{throw Error('Existing companion must be reused');},()=>home);
 let application;
 try {
  await bridge.start();
  const env={...process.env,KEEPWORK_PET_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath:require('../apps/pet-companion/node_modules/electron'),args:[path.resolve(__dirname,'../src/pet/companion.cjs'),`--user-data-dir=${path.join(home,'profile')}`],env});
  await new Promise((resolve,reject)=>{const limit=setTimeout(()=>{clearInterval(timer);reject(Error('Companion did not register'));},10000);const timer=setInterval(()=>{if(bridge.peer){clearInterval(timer);clearTimeout(limit);resolve();}},20);});
  let pending=bridge.request({id:'once',client:'PPT teaching test'},new AbortController().signal);
  const page=await application.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#permission-bubble').waitFor({state:'visible'});
  assert.equal(await page.locator('#permission-client').textContent(),'请求方：PPT teaching test');
  const rect=await page.locator('#permission-bubble').boundingBox(), pet=await page.locator('#pet').boundingBox();
  assert.ok(rect.x>=0&&rect.y>=0&&rect.y+rect.height<=pet.y);
  await page.mouse.move(rect.x+15,rect.y+15);
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),true);
  const out=path.resolve(__dirname,'../out/pet-permission');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'permission-bubble.png')});
  await page.locator('[data-permission="once"]').click();assert.equal(await pending,'once');
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  bridge.restorePet();
  for(const choice of ['always','cancel']) {
   pending=bridge.request({id:choice,client:'PPT teaching test'},new AbortController().signal);
   await page.locator('#permission-bubble').waitFor({state:'visible'});await page.locator(`[data-permission="${choice}"]`).click();assert.equal(await pending,choice);bridge.restorePet();
  }
  const abort=new AbortController();pending=bridge.request({id:'cancelled',client:'PPT teaching test'},abort.signal);
  await page.locator('#permission-bubble').waitFor({state:'visible'});abort.abort();await assert.rejects(pending,/cancelled/);await page.locator('#permission-bubble').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log('Native permission pet passed: standalone UI, existing-peer reuse, above-pet bounds, all choices, hidden-before-grant, cancellation. No real screenshot approval persisted.');
 } finally { bridge.close();if(application)await application.close().catch(()=>{});fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
