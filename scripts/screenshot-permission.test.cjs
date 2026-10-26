const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);
const { ScreenshotPermission } = require('../src/core/screenshotPermission.ts');
const { PetPermissionBridge } = require('../src/core/petPermissionBridge.ts');
const { ComputerController } = require('../src/core/computer.ts');
const { connectPermissionPet } = require('../src/pet/permissionClient.cjs');
function permissionFixture() {
  let value=false, pending, calls=0;
  const pet = { request(request,signal) { calls++; return new Promise((resolve,reject) => { pending={...request,resolve,reject,signal}; signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}); }); } };
  const service = new ScreenshotPermission(pet,()=>value,v=>{value=v;});
  return {service,pet,read:()=>value,calls:()=>calls,pending:()=>pending};
}
test('allow once prompts again; always survives a new service; disable restores prompting',async()=>{
 const f=permissionFixture(); let p=f.service.authorize('a','PPT teacher'); f.pending().resolve('once'); await p; assert.equal(f.read(),false);
 p=f.service.authorize('a','PPT teacher'); f.pending().resolve('always'); await p; assert.equal(f.read(),true);
 const restarted=new ScreenshotPermission(f.pet,f.read,()=>{}); await restarted.authorize('b','Other client'); assert.equal(f.calls(),2);
 f.service.disable(); p=f.service.authorize('b','Other client'); assert.equal(f.calls(),3); f.pending().resolve('cancel'); await assert.rejects(p,/denied/);
});
test('permission has no time limit; denial never becomes remembered approval',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']}); const f=permissionFixture(); let done=false;
 const p=f.service.authorize('a','Teacher').then(()=>{done=true;}); t.mock.timers.tick(24*60*60*1000); await Promise.resolve(); assert.equal(done,false); assert.equal(f.service.waitingOwner,'a');
 f.pending().resolve('once'); await p; assert.equal(f.read(),false);
});
test('cancellation, session closure, settings revocation and shutdown invalidate late choices',async()=>{
 for(const cancel of [(f,c)=>c.abort(),f=>f.service.cancelOwner('a'),f=>f.service.disable(),f=>f.service.close()]){
  const f=permissionFixture(), c=new AbortController(), p=f.service.authorize('a','teacher',c.signal); const pending=f.pending(); cancel(f,c);
  await assert.rejects(p,/cancelled/); pending.resolve('always'); assert.equal(f.read(),false); assert.equal(f.service.status().pending,false);
 }
});
test('only one approval can wait; invalid replies do not grant permission',async()=>{
 const f=permissionFixture(),p=f.service.authorize('a','teacher'); await assert.rejects(f.service.authorize('b','other'),/busy/);
 f.pending().resolve('forged'); await assert.rejects(p,/Invalid/); assert.equal(f.read(),false);
});
test('standalone capture dispatch is isolated from input execution and shares the desktop lock',async()=>{
 const f=permissionFixture(); let captures=0,inputs=0;
 const shot=JSON.stringify({width:1920,height:1080,data:'aW1hZ2U='});
 const controller=new ComputerController('win32',async()=>{inputs++; return shot;},async(owner,client,signal)=>{await f.service.authorize(owner,client,signal);captures++;return shot;});
 const result=controller.run({action:'screenshot'},'owner',undefined,'PPT'); assert.equal(captures,0); assert.equal(inputs,0);
 await assert.rejects(controller.run({action:'click',x:1,y:1}),/busy/); f.pending().resolve('always');
 const image=await result; assert.equal(image.content[1].type,'image'); assert.equal(JSON.parse(image.content[0].text).inputSent,false); assert.equal(captures,1);
 await controller.run({action:'click',x:1,y:1}); assert.equal(inputs,1);
});
async function bridgeFixture(t,launch) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-pet-test-')); const bridge=new PetPermissionBridge(launch,()=>home);
 await bridge.start(); t.after(()=>{bridge.close();fs.rmSync(home,{recursive:true,force:true});});
 const record=JSON.parse(fs.readFileSync(path.join(home,'pet-permission-bridge.json'),'utf8'));
 return {bridge,home,record};
}
async function peer(record,role='desktop',token=record.token) {
 const socket=net.createConnection({port:record.port,host:'127.0.0.1'}); socket.on('error',()=>{});
 await once(socket,'connect'); const ready=once(socket,'data'); socket.write(JSON.stringify({role,token})+'\n'); await ready; return socket;
}
test('authenticated existing pet is reused; stale choices ignored; cancellation clears bubble',async t=>{
 const f=await bridgeFixture(t,()=>{throw Error('must reuse pet');}); const socket=await peer(f.record); t.after(()=>socket.destroy());
 const controller=new AbortController(), data=once(socket,'data'), pending=f.bridge.request({id:'one',client:'Teacher'},controller.signal);
 assert.equal(JSON.parse((await data)[0]).type,'permission'); let done=false; pending.finally(()=>{done=true;}).catch(()=>{});
 socket.write(JSON.stringify({type:'choice',id:'stale',choice:'always'})+'\n'); await new Promise(resolve=>setImmediate(resolve)); assert.equal(done,false);
 const cancelled=once(socket,'data'); controller.abort(); await assert.rejects(pending,/cancelled/); assert.equal(JSON.parse((await cancelled)[0]).type,'cancel');
});
test('missing desktop launches one companion, authenticates, and returns user choice',async t=>{
 let launches=0,disconnect,resolveChoice; let home;
 const f=await bridgeFixture(t,()=>{launches++;disconnect=connectPermissionPet({requestPermission:()=>new Promise(resolve=>{resolveChoice=resolve;}),cancelPermission(){}},{role:'companion',home,retire(){}});const child=new EventEmitter();child.kill=()=>{};child.exitCode=null;return child;}); home=f.home; t.after(()=>disconnect?.());
 const pending=f.bridge.request({id:'capture',client:'Teacher'},new AbortController().signal);
 while(!resolveChoice) await new Promise(resolve=>setImmediate(resolve)); resolveChoice('once'); assert.equal(await pending,'once'); assert.equal(launches,1);
});
test('companion disconnect cancels the request and permits a later fresh request',async t=>{
 const f=await bridgeFixture(t,()=>{throw Error('not launched');}); const socket=await peer(f.record);
 const data=once(socket,'data'),p=f.bridge.request({id:'one',client:'Teacher'},new AbortController().signal); await data; socket.destroy(); await assert.rejects(p,/disconnected/);
 const next=await peer(f.record); t.after(()=>next.destroy()); const nextData=once(next,'data'),q=f.bridge.request({id:'two',client:'Teacher'},new AbortController().signal); await nextData;
 next.write(JSON.stringify({type:'choice',id:'two',choice:'cancel'})+'\n'); assert.equal(await q,'cancel');
});
test('unauthenticated client cannot become permission peer',async t=>{
 const f=await bridgeFixture(t,()=>{throw Error('launcher unavailable');}); const socket=net.createConnection({host:'127.0.0.1',port:f.record.port}); socket.on('error',()=>{}); await once(socket,'connect');
 const closed=once(socket,'close'); socket.write(JSON.stringify({role:'desktop',token:'wrong'})+'\n'); await closed;
 await assert.rejects(f.bridge.request({id:'one',client:'Teacher'},new AbortController().signal),/launcher unavailable/);
});

test('a second companion is retired and an idle companion yields to the desktop pet',async t=>{
 const f=await bridgeFixture(t,()=>{throw Error('unexpected launch');});const first=await peer(f.record,'companion');t.after(()=>first.destroy());
 const second=net.createConnection({host:'127.0.0.1',port:f.record.port});second.on('error',()=>{});await once(second,'connect');const reply=once(second,'data');second.write(JSON.stringify({token:f.record.token,role:'companion'})+'\n');assert.equal(JSON.parse((await reply)[0]).type,'retire');second.destroy();
 const retired=once(first,'data'),desktop=await peer(f.record,'desktop');t.after(()=>desktop.destroy());assert.equal(JSON.parse((await retired)[0]).type,'retire');
 const data=once(desktop,'data'),pending=f.bridge.request({id:'desktop',client:'Teacher'},new AbortController().signal);await data;desktop.write(JSON.stringify({type:'choice',id:'desktop',choice:'once'})+'\n');assert.equal(await pending,'once');
});
