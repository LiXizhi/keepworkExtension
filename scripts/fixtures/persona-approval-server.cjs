// Disposable loopback test harness. Production HTTP/persona/session/stdio paths; no real CLI.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {CodexHarness}=require('../../src/core/codexHarness.ts');
const {AgentSessions}=require('../../src/core/agentSessions.ts');
const {Personas}=require('../../src/core/personas.ts');
const {handlePersonaHttp}=require('../../src/mcp/personaHttp.ts');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'persona-approval-e2e-'));
let native=new CodexHarness(process.execPath,[path.join(__dirname,'fake-codex-approval.cjs'),path.join(home,'fixture-rules.json')]);
let sessions=new AgentSessions(path.join(home,'sessions.json'),native);
const messaging={setAgentRootResolver:()=>{},watch:()=>()=>{},agentBindings:()=>[],setAgentPrompt:()=>{},detachAgent:()=>{}};
let personas=new Personas(path.join(home,'personas'),sessions,messaging);
let rejectNext=false;
const server=http.createServer(async(req,res)=>{
    const origin=String(req.headers.origin||'');
    if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)){res.writeHead(403).end();return;}
    res.setHeader('Access-Control-Allow-Origin',origin||'*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Agent-Owner');
    if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
    const url=new URL(req.url,'http://127.0.0.1');
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/fixture/restart'){
        personas.close();sessions.close();
        native=new CodexHarness(process.execPath,[path.join(__dirname,'fake-codex-approval.cjs'),path.join(home,'fixture-rules.json')]);
        sessions=new AgentSessions(path.join(home,'sessions.json'),native);
        personas=new Personas(path.join(home,'personas'),sessions,messaging);
        send({ok:true});return;
    }
    if(url.pathname==='/fixture/state'){send(await native.call('fixture/state'));return;}
    if(url.pathname==='/fixture/reject-next'){rejectNext=true;send({ok:true});return;}
    if(url.pathname.endsWith('/respond')&&rejectNext){rejectNext=false;send({error:'fixture retry required'},503);return;}
    if(url.pathname.startsWith('/agents/personas')){req.headers.origin ||= `http://${req.headers.host}`;await handlePersonaHttp(req,res,url,personas,messaging);return;}
    if(url.pathname==='/agents/backends'){send({codex:{available:true,authenticated:true,models:[{id:'fixture',isDefault:true}]}});return;}
    const source=process.argv[2];
    if(source&&url.pathname==='/persistent-approval-fixture.html'){
        const sdk=fs.readFileSync(path.join(source,'tests/fixtures/sdk-smoke.js'),'utf8');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/app.css"><style>body{margin:0;height:100vh}.main{height:100vh}</style><body data-experience="simple"><div class="experience-recents-head"></div><main class="main"></main><script>${sdk}</script>`);return;
    }
    if(source&&req.method==='GET'){
        const file=path.resolve(source,'.'+decodeURIComponent(url.pathname));
        if(file.startsWith(path.resolve(source)+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
            res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});res.end(fs.readFileSync(file));return;
        }
    }
    send({});
});
server.listen(0,'127.0.0.1',()=>process.send?.({url:`http://127.0.0.1:${server.address().port}`}));
function close(){personas.close();sessions.close();server.closeAllConnections();server.close(()=>{fs.rmSync(home,{recursive:true,force:true});process.exit(0);});}
process.on('message',m=>{if(m==='close')close();});process.on('disconnect',close);
