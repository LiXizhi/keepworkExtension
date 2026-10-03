// Opt-in: node scripts/paracraft-multichat-native.cjs <exact-disposable-world-path>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
async function main() {
  const worldPath = process.argv[2];assert.ok(worldPath, 'Exact disposable world path required');
  const client = new Client({name:'codex-multichat-native',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8089/mcp')));
  const parse = r => { assert.ok(!r.isError, r.content[0]?.text);const v=JSON.parse(r.content[0].text);assert.notEqual(v.ok,false,JSON.stringify(v));return v.result||v; };
  const prefix=randomUUID(), A=prefix+'-a', B=prefix+'-b';
  let clientId, identity;
  const raw = (session,action,params={},petId='main') => client.callTool({name:'paracraft_cli',arguments:{action,clientId,chatSessionId:session,petId,params}});
  const call = async (...args) => parse(await raw(...args));
  const awaitJob = async (session,job) => {
    for(let i=0;i<300;i++) {
      const r=await call(session,'code_job',{expectedIdentity:identity,jobId:job.jobId});
      if(r.state!=='running') return r;
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error('Job did not settle: '+job.jobId);
  };
  try {
    const list=await call(A,'clients');const clients=Array.isArray(list)?list:list.clients;
    const matches=clients.filter(c=>c.worldPath===worldPath);assert.equal(matches.length,1);
    clientId=matches[0].clientId;const capabilities=await call(A,'get_creation_capabilities');identity=capabilities.identity;
    assert.equal(capabilities.authoringSessions,true);
    const before=await call(A,'get_scene_info');
    const input={expectedIdentity:identity,requestId:'same',code:'wait(3); return 42'};
    const a=await call(A,'run_code',input), b=await call(B,'run_code',input);
    assert.notEqual(a.jobId,b.jobId);
    assert.equal((await call(A,'run_code',input)).jobId,a.jobId);
    assert.equal((await raw(A,'run_code',{...input,requestId:'second'})).isError,true);
    assert.equal((await raw(B,'code_job',{expectedIdentity:identity,jobId:a.jobId,operation:'cancel'})).isError,true);
    await call(A,'code_job',{expectedIdentity:identity,jobId:a.jobId,operation:'cancel'});
    assert.equal((await awaitJob(B,b)).result,42);
    const options={expectedIdentity:identity,requestId:'scout',dimensions:[4,5,4],radius:32};
    const sa=await call(A,'find_build_site',options),sb=await call(B,'find_build_site',options);
    const ra=await awaitJob(A,sa),rb=await awaitJob(B,sb);
    assert.equal(ra.state,'completed',ra.error);assert.equal(rb.state,'completed',rb.error);
    const pa=(await call(A,'get_scene_info',{anchor:'pet'})).pet;
    const pb=(await call(B,'get_scene_info',{anchor:'pet'})).pet;
    assert.ok(pa.available && pb.available);assert.notEqual(pa.name,pb.name);
    const wrong=await call(B,'run_code',{expectedIdentity:identity,requestId:'wrong-site',code:`return createScene({dimensions={4,5,4},site="${ra.result.siteId}"})`});
    assert.equal((await awaitJob(B,wrong)).state,'failed');
    const side=await call(A,'find_build_site',{...options,requestId:'side'},'side');
    assert.equal((await awaitJob(A,side)).state,'completed');
    const ps=(await call(A,'get_scene_info',{anchor:'pet'},'side')).pet;
    assert.notEqual(ps.name,pa.name);
    assert.deepEqual((await call(A,'get_scene_info',{anchor:'pet'})).pet.blockPosition,pa.blockPosition);
    for(const [session,petId] of [[A,'main'],[A,'side'],[B,'main']]) {
      const image=await raw(session,'camera_capture',{expectedIdentity:identity,nearPet:true},petId);
      assert.ok(!image.isError && image.content.some(c=>c.type==='image'));
    }
    const after=await call(A,'get_scene_info');
    assert.deepEqual(after.player,before.player);assert.deepEqual(after.camera,before.camera);
    console.log('PASS native multichat: independent jobs/dedup/cancellation/sites, serial per chat, three pet references, scoped captures, stationary player/camera');
  } finally { await client.close(); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
