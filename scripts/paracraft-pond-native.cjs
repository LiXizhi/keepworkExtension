// Opt-in named-group revision and fresh MCP feedback in a disposable world.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),ts=require('typescript');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {compileCreationTemplate}=require('../src/mcp/paracraftTemplates.ts');
const [buildArg,outArg]=process.argv.slice(2);assert(buildArg&&outArg);const build=JSON.parse(fs.readFileSync(buildArg)),identity=build.identity,result=build.result;
assert(build.state==='completed'&&identity.worldPath.includes('CreationAcceptance')&&result.bench);const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
async function native(action,params={}){const body=JSON.stringify({v:1,action,params});return await new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{const r=JSON.parse(data);assert(r.ok&&r.result.ok,JSON.stringify(r));resolve(r.result);}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('native observation timeout')));req.end(body);
});}
(async()=>{
 assert.deepEqual((await native('get_creation_capabilities')).identity,identity);
 const request=JSON.parse(fs.readFileSync(path.join(path.dirname(buildArg),'build/request.json')));delete request.templateHash;
 const compiled=compileCreationTemplate(request,build.authoringSession);
 const generator=compiled.code.replaceAll(compiled.metadata.sceneName,result.name);assert(generator.includes(result.name));assert(!generator.includes(']====]'));
 const code=`local s=createScene({name="${result.name}",resume=true});s:group("aquatic");for _,p in ipairs({{5,0,4},{7,0,6}})do s:block({position=p,blockId=222,data=2,replace=true})end;s:save([====[${generator}]====]);return {name=s.name};`;
 const handleFile=path.join(out,'revision-job.json');let handle;
 if(fs.existsSync(handleFile))handle=JSON.parse(fs.readFileSync(handleFile));else{
  const params={expectedIdentity:identity,authoringSession:build.authoringSession,requestId:'pond-orientation-'+Date.now(),code};fs.writeFileSync(path.join(out,'request.json'),JSON.stringify(params,null,2));
  const first=await native('run_code',params);handle={jobId:first.jobId,identity};assert(handle.jobId);fs.writeFileSync(handleFile,JSON.stringify(handle,null,2));
 }
 assert.deepEqual(handle.identity,identity);let revised;
 for(let i=0;i<60;i++){revised=await native('code_job',{expectedIdentity:identity,authoringSession:build.authoringSession,jobId:handle.jobId});if(revised.state!=='running')break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(revised.state,'completed',revised.error);fs.writeFileSync(path.join(out,'revision.json'),JSON.stringify(revised,null,2));
 const inspect=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");assert(C.World.Identity().sessionId==${identity.sessionId});local w=C.World:new():Init({});local file=ParaIO.open(w.identity.worldPath.."creation/${result.name}/manifest.json","r");assert(file:IsValid());local text=file:GetText(0,-1);file:close();local d=commonlib.Json.Decode(text);local water,pads,backups,cells=0,0,0,0;for _,m in pairs(d.cells)do cells=cells+1;local state=w:Snapshot(m.position);assert(w:Fingerprint(state)==m.fingerprint,"stale pond member");if state.id==75 or state.id==76 then water=water+1 end;if state.id==222 then assert(state.data==2);pads=pads+1 end;if m.group=="pond"or m.group=="walk"then assert(m.original and m.original.id~=0);backups=backups+1 end end;assert(pads==2 and water>10 and backups>70);local p=d.origin;for z=2,8 do for x=3,9 do local id=B:GetBlockId(p[1]+x,p[2]-1,p[3]+z);if id==75 or id==76 then assert(((x-6)/2.6)^2+((z-5)/2.2)^2<=1,"water escaped mask")end end end;return {cells=cells,water=water,pads=pads,terrainBackups=backups,manifest=ParaMisc.md5(text),origin=d.origin};`;
 const before=(await native('run_npl_code',{code:inspect})).result;
 const vectors=(await native('run_npl_code',{code:`local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine");local p={${result.origin.join(',')}};local function v(a)return {B:real_bottom(p[1]+a[1],p[2]+a[2],p[3]+a[3])}end;return {overview={eye=v({6,13,4}),lookat=v({6,0,5})},pads={eye=v({6,3,3}),lookat=v({6,0,5})}};`})).result;
 const client=new Client({name:'pond-native-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('apps/vscode-extension/dist/cli.js'),'--stdio']}));
 const call=async(action,params={})=>{const r=await client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId:build.authoringSession,params}});assert(!r.isError,r.content.find(c=>c.type==='text')?.text);return r;};
 try{
  const view=async()=>JSON.parse((await call('get_scene_info')).content.find(c=>c.type==='text').text).result;const initial=await view(),images=[],sceneImages=[];
  for(const [name,params]of Object.entries(vectors)){const r=await call('camera_capture',{expectedIdentity:identity,...params});const metadata=JSON.parse(r.content.find(c=>c.type==='text').text),image=r.content.find(c=>c.type==='image');assert(image&&metadata.sessionId===identity.sessionId);const file=path.join(out,name+'.jpg');fs.writeFileSync(file,Buffer.from(image.data,'base64'));sceneImages.push({file,metadata});}
  for(let i=0;i<3;i++){
   const r=await call('camera_capture',{expectedIdentity:identity,asset:{filename:result.bench.filename,yaw:0.7,elevation:0.2}});const metadata=JSON.parse(r.content.find(c=>c.type==='text').text),image=r.content.find(c=>c.type==='image');assert(image&&image.mimeType==='image/png');assert.equal(metadata.asset.scale,1);metadata.asset.meters.forEach((n,j)=>assert(Math.abs(n-result.bench.expectedMeters[j])<0.001));const file=path.join(out,'bench-'+i+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));images.push({file,metadata});
  }
  const final=await view(),after=(await native('run_npl_code',{code:inspect})).result;assert.deepEqual(after,before);assert.deepEqual(final.player,initial.player);assert.deepEqual(final.camera,initial.camera);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({identity,result,before,after,images,sceneImages,playerUnchanged:true,cameraUnchanged:true},null,2));console.log('PASS native pond backups/contained water/horizontal pads, three independent scale-1 bench PNGs, source and main view preserved');
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
