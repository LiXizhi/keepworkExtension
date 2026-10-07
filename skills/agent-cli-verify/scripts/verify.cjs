const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');

const SUPPORTED_BACKENDS=require('../references/backends.json');
async function verify(baseUrl,{backends,probeOnly=false,reportFile=path.resolve('out/agent-cli-verify/report.json'),timeoutMs=180000}={}) {
 const base=new URL(baseUrl);
 if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash)throw new Error('A loopback daemon URL without credentials is required');
 const owner=crypto.randomUUID();
 const headers={Origin:'http://localhost:3000','X-Agent-Owner':owner,'Content-Type':'application/json',...(process.env.KEEPWORK_MCP_TOKEN?{Authorization:'Bearer '+process.env.KEEPWORK_MCP_TOKEN}:{})};
 const request=async (route,body,method=body===undefined?'GET':'POST')=>{
   const response=await fetch(new URL('/agents/'+route,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'HTTP '+response.status);return data;
 };
 const report={version:1,startedAt:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch},mode:probeOnly?'probe-only':'real',results:[]};
 let statuses;
 try { statuses=await request('backends'); }
 catch { statuses={}; }
 // Include newly discovered implementations so all-provider acceptance cannot silently omit one.
 if(!backends)backends=[...new Set([...SUPPORTED_BACKENDS,...Object.keys(statuses)])];
 for(const backend of backends) {
   const row={backend,status:'failed',checks:[],...(statuses[backend]?.cli?{cli:statuses[backend].cli}:{})};report.results.push(row);
   let temp,session;
   try {
     if(!statuses[backend]?.available){row.status='unavailable';row.reason=statuses[backend]?.error||'Backend not advertised or daemon not reachable';continue;}
     row.checks.push(statuses[backend].probe==='executable'?'cli-executable':'handshake');
     if(probeOnly){row.status='not_tested';row.reason='Probe only; real authenticated execution not tested';continue;}
     temp=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-cli-verify-'));
     const roots=['primary','reference'].map(name=>{const dir=path.join(temp,name);fs.mkdirSync(dir);return dir;});
     const marker='KEEPWORK_'+crypto.randomBytes(8).toString('hex')+'_中文😀';
     const turn=async (requestId,text)=>{
       const accepted=await request(`sessions/${session.id}/turns`,{requestId,text});
       const duplicate=await request(`sessions/${session.id}/turns`,{requestId,text});
       assert.equal(duplicate.submission.turnId,accepted.submission.turnId);
       const deadline=Date.now()+timeoutMs;
       while(Date.now()<deadline){
         const snapshot=await request(`sessions/${session.id}`);
         for(const pending of snapshot.pending||[]) {
           if(pending.method==='item/tool/requestUserInput')throw new Error('Unexpected user input during smoke');
           await request(`sessions/${session.id}/respond`,{id:pending.id,decision:'accept'});
         }
         if(!['starting','running','waiting','uncertain'].includes(snapshot.status)) {
           assert.equal(snapshot.status,'completed',snapshot.error||'Turn failed');return snapshot;
         }
         await new Promise(r=>setTimeout(r,500));
       }
       await request(`sessions/${session.id}/interrupt`,{}).catch(()=>{});
       throw new Error('Real turn timed out; not rerun');
     };
     session=await request('sessions',{backend,conversationId:crypto.randomUUID(),roots});
     assert.equal(session.backend,backend);row.checks.push('provider-routing');
     if(statuses[backend].probe==='executable')row.checks.push('handshake');
     const first=await turn('write',`Acceptance test. Operate only in these two temporary workspace folders. Write a UTF-8 file smoke.txt in EACH selected root containing exactly ${marker}. Use your native file or terminal tools. Remember this marker for the next turn and include it verbatim in your reply. Do not install anything, create agents or touch any other directory.`);
     for(const root of roots)assert.equal(fs.readFileSync(path.join(root,'smoke.txt'),'utf8').trim(),marker);
     assert.ok(first.items.some(i=>i.type==='agentMessage'&&i.text?.includes(marker)),'Unicode reply missing');row.checks.push('native-tools-two-roots','unicode-output','request-id-idempotency');
     const second=await turn('continue','Read both smoke.txt files. Use the marker you remembered from the previous turn to write continued.txt in each selected root with exactly that same marker. Reply with the marker. Operate only in the selected temporary folders.');
     for(const root of roots)assert.equal(fs.readFileSync(path.join(root,'continued.txt'),'utf8').trim(),marker);
     row.checks.push('multi-turn-continuation');
     const replay=await request(`sessions/${session.id}`);assert.deepEqual(replay.items,second.items);row.checks.push('snapshot-reconnect');
     await request(`sessions/${session.id}`,{archived:true},'PATCH');
     await request(`sessions/${session.id}`,{archived:false},'PATCH');
     assert.ok((await request(`sessions/${session.id}`)).items.some(i=>i.type==='agentMessage'&&i.text?.includes(marker)));row.checks.push('history-resume');
     row.status='passed';
   } catch(error) { row.reason=error.message; }
   finally {
     if(session)try{await request(`sessions/${session.id}`,{remove:true},'PATCH');row.checks.push('archive-cleanup');}catch{row.status='failed';row.reason='Session cleanup failed; interrupt/archive the test session in the local daemon';}
     if(temp){
       const target=path.resolve(temp),parent=path.resolve(os.tmpdir());
       if(path.dirname(target)!==parent||!path.basename(target).startsWith('keepwork-cli-verify-'))throw new Error('Unsafe temporary cleanup path');
       // CLI descendants may briefly retain handles after completion.
       try{fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{row.status='failed';row.reason='Temporary folder cleanup failed';}
     }
     console.log(`${backend}: ${row.status}${row.reason?' — '+row.reason:''}`);
   }
 }
 report.finishedAt=new Date().toISOString();report.passed=report.results.every(r=>r.status==='passed');
 fs.mkdirSync(path.dirname(reportFile),{recursive:true});fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
 console.log('Report: '+reportFile);return report;
}
module.exports={verify};
if(require.main===module){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const backend=option('--backend');if(backend&&!SUPPORTED_BACKENDS.includes(backend))throw new Error('Unsupported backend');
 verify(option('--url')||'http://127.0.0.1:8089',{...(backend?{backends:[backend]}:{}),probeOnly:args.includes('--probe-only'),...(option('--report')?{reportFile:path.resolve(option('--report'))}:{})}).then(r=>{if(!r.passed)process.exitCode=1;},e=>{console.error(e.message);process.exitCode=1;});
}
