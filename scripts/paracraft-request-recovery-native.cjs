// Opt-in live-registry-preserving hot validation; no Jobs.lua reload/reset.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg);const job=JSON.parse(fs.readFileSync(jobArg)),identity=job.identity;
assert(job.state==='completed'&&identity.worldPath.includes('CreationAcceptance'));const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){const body=JSON.stringify({v:1,action,params});return await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{const r=JSON.parse(data);assert(r.ok&&r.result.ok,JSON.stringify(r));resolve(r.result);}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native read timeout')));req.end(body);});}
(async()=>{
 assert.deepEqual((await native('get_creation_capabilities')).identity,identity);
 const patch=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local Jobs=C.Jobs;assert(debug and debug.getupvalue);local env={C=C,Jobs=Jobs};
 local function collect(f)for i=1,50 do local name,value=debug.getupvalue(f,i);if not name then break end;env[name]=value end end;collect(Jobs.Control);collect(Jobs.Start);assert(env.jobs and env.requests and env.stop and env.view);
 local priorCount=0;for _ in pairs(env.jobs)do priorCount=priorCount+1 end;local current=assert(env.jobs["${job.jobId}"]);local requestId=current.signature.params.requestId;
 local file=ParaIO.open("script/apps/Aries/Creator/Game/Code/Creation/Jobs.lua","r");assert(file:IsValid());local text=file:GetText(0,-1);file:close();setmetatable(env,{__index=_G});
 local function section(a,b)local first=assert(text:find(a,1,true));local last=assert(text:find(b,first+1,true));return text:sub(first,last-1)end
 local v=assert(loadstring(section("local function view(job)","local function stop(job" ).."return view"));setfenv(v,env);env.view=v();
 local control=assert(loadstring(section("function Jobs.Control(params)","function Jobs.Start(action,params)")));setfenv(control,env);control();
 local caps=assert(loadstring(section("function Jobs.Capabilities()","function Jobs.Tick()")));setfenv(caps,env);caps();assert(Jobs.Capabilities().requestJobLookup);
 local identity=current.identity;local params={expectedIdentity=identity,authoringSession=current.authoringSession,requestId=requestId};local recovered=Jobs.Control(params);assert(recovered.jobId==current.id and recovered.requestId==requestId and recovered.state==current.state);
 local function rejects(p,message)local r=Jobs.Control(p);assert(r.ok==false and r.error==message,r.error);end
 rejects({expectedIdentity=identity,authoringSession="other-chat",requestId=requestId},"unknown_job");
 rejects({expectedIdentity=identity,authoringSession=current.authoringSession,requestId="absent-request"},"unknown_job");
 rejects({expectedIdentity=identity,jobId=current.id,requestId=requestId},"provide exactly one jobId or requestId");
 rejects({expectedIdentity=identity},"provide exactly one jobId or requestId");
 rejects({expectedIdentity=identity,requestId=""},"invalid job selector");
 local wrong=commonlib.deepcopy(identity);wrong.worldPath="other-world/";rejects({expectedIdentity=wrong,authoringSession=current.authoringSession,requestId=requestId},"world_identity_required");
 wrong=commonlib.deepcopy(identity);wrong.sessionId=wrong.sessionId+1;rejects({expectedIdentity=wrong,authoringSession=current.authoringSession,requestId=requestId},"unknown_job");
 local count=0;for _ in pairs(env.jobs)do count=count+1 end;assert(count==priorCount);
 return {requestId=requestId,jobId=current.id,authoringSession=current.authoringSession,retainedJobs=count,passed=8};`;
 const patched=(await native('run_npl_code',{code:patch})).result;fs.writeFileSync(path.join(out,'native-check.json'),JSON.stringify(patched,null,2));
 const client=new Client({name:'request-recovery-native',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params,chatSessionId=patched.authoringSession)=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId,params}});assert(!r.isError,r.content.find(c=>c.type==='text')?.text);return JSON.parse(r.content.find(c=>c.type==='text').text);};
 try{
  const recovered=await call('code_job',{expectedIdentity:identity,requestId:patched.requestId});assert.equal(recovered.result.jobId,job.jobId);assert.equal(recovered.result.requestId,patched.requestId);
  const session='rsi-request-recovery',requestId='cancel-request-'+Date.now();
  const submitted=await native('run_code',{expectedIdentity:identity,authoringSession:session,requestId,code:'wait(30); return {done=true};'});
  fs.writeFileSync(path.join(out,'cancellation-handle.json'),JSON.stringify({identity,session,requestId,jobId:submitted.jobId},null,2));
  // Observe without using the response's job ID, then cancel the exact request.
  const running=await call('code_job',{expectedIdentity:identity,requestId},session);assert.equal(running.result.jobId,submitted.jobId);assert.equal(running.result.state,'running');
  const cancelled=await call('code_job',{expectedIdentity:identity,requestId,operation:'cancel'},session);assert.equal(cancelled.result.state,'cancelled');assert.equal(cancelled.result.jobId,submitted.jobId);
  const final=await native('code_job',{expectedIdentity:identity,authoringSession:session,jobId:submitted.jobId});assert.equal(final.state,'cancelled');
  fs.writeFileSync(path.join(out,'mcp-check.json'),JSON.stringify({recovered,cancelled,final},null,2));console.log('PASS original request lookup, retained native jobs, chat/world isolation, stdio recovery and request cancellation');
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
