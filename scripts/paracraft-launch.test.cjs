const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, f);
const {createParacraftLauncher, desktopProtocolUrl, openDesktopProtocol} = require('../src/core/paracraftLaunch.ts');

test('protocol grammar rejects shell/URL injection', async () => {
  assert.equal(desktopProtocolUrl(), 'paracraft://protocol="paracraft" debug="main"');
  assert.equal(desktopProtocolUrl(530), 'paracraft://cmd/loadworld 530 debug="main"');
  for (const id of [0,-1,1.1,Infinity,'530','530 & calc',Number.MAX_SAFE_INTEGER+1]) assert.throws(() => desktopProtocolUrl(id));
  await assert.rejects(openDesktopProtocol('https://example.com'), /invalid_protocol_url/);
});

test('client-only startup reuses an idle desktop without requiring a world or login', async () => {
  let opened=0;
  const launcher=createParacraftLauncher(async()=>[
    {clientId:'wasm',platform:'wasm',worldEntered:false},
    {clientId:'occupied',worldEntered:true},
    {clientId:'entering-project',worldEntered:false,kpProjectId:530},
    {clientId:'idle',worldEntered:false},
  ],async()=>opened++);
  const result=await launcher.launch();
  assert.equal(result.target,'client');assert.equal(result.state,'ready');
  assert.equal(result.clientId,'idle');assert.equal(result.reused,true);assert.equal(opened,0);
  assert.equal(result.initialClientIds,undefined);
});

test('client-only launches coalesce and await new registration without switching existing worlds', async () => {
  let clients=[{clientId:'existing',worldEntered:true}],opened=[];
  const launcher=createParacraftLauncher(async()=>clients,async url=>opened.push(url));
  const [a,b]=await Promise.all([launcher.launch(),launcher.launch()]);
  assert.equal(a.launchId,b.launchId);assert.equal(a.state,'waiting');
  assert.deepEqual(opened,[desktopProtocolUrl()]);
  clients.push({clientId:'wasm',platform:'wasm',worldEntered:false});
  assert.equal((await launcher.status(a.launchId)).state,'waiting');
  clients.push({clientId:'new-desktop',worldEntered:false});
  const result=await launcher.status(a.launchId);
  assert.equal(result.state,'ready');assert.equal(result.clientId,'new-desktop');
  assert.equal(result.target,'client');assert.equal(result.initialClientIds,undefined);
  assert.equal(clients[0].worldEntered,true);
});
test('reuse a ready desktop, not WASM or an entering/other world', async () => {
  let opened=0;
  const launcher=createParacraftLauncher(async()=>[
    {clientId:'wasm',platform:'wasm',kpProjectId:530,worldEntered:true},
    {clientId:'entering',kpProjectId:530,worldEntered:false},
    {clientId:'other',kpProjectId:531,worldEntered:true},
    {clientId:'ready',kpProjectId:'530',worldEntered:true},
  ],async()=>opened++);
  const r=await launcher.launch(530);
  assert.equal(r.state,'ready'); assert.equal(r.clientId,'ready');assert.equal(r.reused,true);assert.equal(opened,0);
});
test('parallel chats share one launch; delayed registration and timeout recover through status', async () => {
  let clients=[],opened=0,clock=0,release;
  const launcher=createParacraftLauncher(()=>new Promise(r=>{release=()=>r(clients)}),async()=>opened++,()=>clock);
  const a=launcher.launch(530),b=launcher.launch(530);release();
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(ra.launchId,rb.launchId);assert.equal(opened,1);assert.equal(ra.state,'waiting');
  clients=[{clientId:'native',kpProjectId:530,worldEntered:true}];
  const pending=launcher.status(ra.launchId);release();const ready=await pending;
  assert.equal(ready.state,'ready');assert.equal(ready.clientId,'native');assert.equal(opened,1);
  clients=[];const next=launcher.launch(531);release();const rn=await next;
  clock=60001;const timeout=launcher.status(rn.launchId);release();const failed=await timeout;
  assert.equal(failed.state,'failed');assert.equal(failed.ok,false);assert.match(failed.error,/launch_timeout/);
  assert.equal((await launcher.status('unknown')).error,'unknown_launch');
});
test('protocol failures settle and permit an explicit later attempt', async () => {
  let opened=0;
  const launcher=createParacraftLauncher(async()=>[],async()=>{opened++;throw Error('handler absent')});
  const r=await launcher.launch(530);assert.equal(r.state,'failed');assert.match(r.error,/protocol_launch_failed/);
  await launcher.launch(530);assert.equal(opened,2);
});
