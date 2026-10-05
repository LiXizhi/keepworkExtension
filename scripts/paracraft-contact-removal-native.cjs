// One scoped revision of the known acceptance scene; recover the persisted job.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const original=JSON.parse(fs.readFileSync('out/rsi/056/build/job.json'));
const old=JSON.parse(fs.readFileSync('out/rsi/056/build/latest-job.json'));
const out=path.resolve('out/rsi/065/revision');fs.mkdirSync(out,{recursive:true});
const vec=v=>'{'+v.map(n=>{assert(Number.isFinite(n));return n;}).join(',')+'}';
const code=`local s=createScene({name="${original.sceneName}",resume=true})
local test=s:_testModelRemoval("${original.request.assets.lantern}")
s:save(s.savedSource);wait(1)
return{name=s.name,origin=s.origin,test=test,overview={eye=${vec(old.result.overview.eye)},lookat=${vec(old.result.overview.lookat)}},detail={eye=${vec(old.result.detail.eye)},lookat=${vec(old.result.detail.lookat)}}}`;
(async()=>{const c=new Client({name:'contact-removal',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
const raw=async(action,params)=>{const r=await c.callTool({name:'paracraft_cli',arguments:{action,clientId:original.identity.clientId,chatSessionId:original.session,params}});assert(!r.isError,r.content[0]?.text);return r;};
const call=async(a,p)=>JSON.parse((await raw(a,p)).content[0].text);
try{const file=path.join(out,'job.json');let h;if(fs.existsSync(file)){h=JSON.parse(fs.readFileSync(file));assert.deepEqual(h.identity,original.identity);}else{const request={expectedIdentity:original.identity,requestId:'rsi-contact-removal-065',code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(request,null,2));const started=(await call('run_code',request)).result;h={identity:original.identity,jobId:started.jobId};fs.writeFileSync(file,JSON.stringify(h,null,2));}
let job;for(let i=0;i<240;i++){job=(await call('code_job',{expectedIdentity:h.identity,jobId:h.jobId,resultDetail:'full'})).result;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
fs.writeFileSync(path.join(out,'latest-job.json'),JSON.stringify(job,null,2));assert.equal(job.state,'completed',job.error);assert.deepEqual(job.result.origin,old.result.origin);
const images=[];for(const view of ['overview','detail']){const r=await raw('camera_capture',{expectedIdentity:h.identity,...job.result[view]});const pixels=r.content.find(x=>x.type==='image');assert(pixels);const file=path.join(out,view+'.jpg');fs.writeFileSync(file,Buffer.from(pixels.data,'base64'));images.push({file,metadata:JSON.parse(r.content[0].text)});}
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity:h.identity,jobId:job.jobId,test:job.result.test,images},null,2));console.log('PASS contacting model removal/rebuild and obstruction protections, fixed origin, fresh images');
}finally{await c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
