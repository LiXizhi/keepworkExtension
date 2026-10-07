// Explicit opt-in integration check; no credentials or provider payloads are printed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {AgentSessions,ownerKey}=require('../src/core/agentSessions.ts');
const {handleAgentHttp}=require('../src/mcp/agentHttp.ts');
async function main(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-codex-smoke-'));
  const manager=new AgentSessions(path.join(dir,'registry.json'));
  const origin=new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').origin;
  const capability='smoke-owner-'.repeat(4),owner=ownerKey(origin,capability);
  let session;
  try{
    const status=await manager.status();
    console.log(JSON.stringify({available:status.available,authenticated:status.authenticated,modelCount:status.models.length,error:status.error}));
    assert.ok(status.available&&status.authenticated,'Codex installation and login required');
    const roots=['repo-a','repo-b'].map(name=>{const p=path.join(dir,name);fs.mkdirSync(p);execFileSync('git',['init',p],{stdio:'ignore',windowsHide:true});return p;});
    const unicode='中文任务：检查日历和待办事项。📅';
    fs.writeFileSync(path.join(roots[0],'unicode.md'),unicode,'utf8');
    session=await manager.create(owner,{conversationId:'smoke-'+Date.now(),roots});
    await manager.turn(session.id,owner,{requestId:'smoke-turn',text:'This is an integration test in two temporary repositories. Read unicode.md in the primary folder using a shell command and include its exact content in your final reply. Create a file named smoke.txt containing exactly AICHAT_CODEX_SMOKE in EACH of the two workspace folders listed above. Do not modify anything else. Then reply SMOKE_COMPLETE plus the file content.'});
    const end=Date.now()+180000;
    while(Date.now()<end){
      const s=await manager.read(session.id,owner);
      assert.equal(s.pending.length,0,'Full Access smoke must execute without approval or input requests');
      if(['completed','failed','interrupted','error'].includes(s.status)) {assert.equal(s.status,'completed');break;}
      await new Promise(r=>setTimeout(r,500));
    }
    assert.equal((await manager.read(session.id,owner)).status,'completed','Real Codex turn did not complete within the smoke timeout');
    for(const root of roots) assert.equal(fs.readFileSync(path.join(root,'smoke.txt'),'utf8').trim(),'AICHAT_CODEX_SMOKE');
    const items=(await manager.read(session.id,owner)).items;
    assert.ok(items.some(i=>i.type==='commandExecution'&&i.aggregatedOutput?.includes(unicode)),'Real command output must preserve UTF-8 Chinese and emoji');
    assert.ok(items.some(i=>i.type==='agentMessage'&&i.text?.includes(unicode)),'Real assistant must receive uncorrupted Unicode');
    console.log('PASS: real Codex command output and reply preserve Chinese/emoji; both temporary repositories written; snapshot reconnect verified.');
    if(process.env.AICHAT_REAL_UI_SMOKE){
      let uiTurns=0;
      const server=require('node:http').createServer((req,res)=>{
        if(req.headers.origin!==origin){res.writeHead(403);res.end();return;}
        res.setHeader('Access-Control-Allow-Origin',origin);
        res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Agent-Owner');
        res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
        const url=new URL(req.url,'http://localhost');
        if(req.method==='POST'&&url.pathname.endsWith('/turns')) uiTurns++;
        if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({agentSessionApi:'v1'}));return;}
        void handleAgentHttp(req,res,url,manager);
      });
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      try{
        const helper=path.resolve(process.env.AICHAT_SOURCE_DIR || path.join(__dirname,'../../apps/official/apps/tools/AIChat'),'tests/helpers/harness_real_reconnect.mjs');
        const {verifyRealHarnessReconnect}=await import(require('node:url').pathToFileURL(helper).href);
        await verifyRealHarnessReconnect({url:`http://127.0.0.1:${server.address().port}`,capability,session,roots,extension:path.resolve(__dirname,'..'),expectedOutput:unicode});
        assert.equal(uiTurns,0,'Reconnection must never resubmit a prompt');
        console.log('PASS: browser and desktop reconnected twice through the real agent HTTP API; no prompt resubmission.');
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    }
    await manager.update(session.id,owner,{remove:true});
  }finally{
    if(session) try { await manager.update(session.id,owner,{remove:true}); } catch { /* already archived, or shutdown will interrupt */ }
    manager.close();
    const resolved=path.resolve(dir),parent=path.resolve(os.tmpdir());
    if(path.dirname(resolved)===parent&&path.basename(resolved).startsWith('keepwork-codex-smoke-')) {
      await new Promise(r=>setTimeout(r,500));
      fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
