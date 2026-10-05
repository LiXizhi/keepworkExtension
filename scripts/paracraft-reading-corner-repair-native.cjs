// Repair only missing models in a terminal failed cutaway, retaining its frame.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const [failedDir,outArg]=process.argv.slice(2);assert(failedDir&&outArg);const failed=JSON.parse(fs.readFileSync(path.join(failedDir,'job.json'))),request=failed.request,out=path.resolve(outArg);assert(request.template==='reading_corner');fs.mkdirSync(out,{recursive:true});
require.extensions['.ts']=(module,file)=>module._compile(require('typescript').transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const compiled=require('../src/mcp/paracraftTemplates.ts').compileCreationTemplate({...request,templateHash:undefined},failed.session);assert.equal(compiled.metadata.sceneName,failed.sceneName);
const handle=path.join(out,'context.json');fs.writeFileSync(handle,JSON.stringify({identity:failed.identity,session:failed.session,sceneName:failed.sceneName},null,2));
const code=`local s=createScene({name="birdbath_garden",resume=true})
s:requireModels({"${request.assets.bench}","${request.assets.plant}"})
s:group("bench");s:model({position={2,0,1},offset={0,0,0.125},filename="${request.assets.bench}",scale=1,facing=math.pi})
s:group("plant");s:model({position={1,0,1},filename="${request.assets.plant}",scale=1,facing=0})
wait(1)
s:save([====[${compiled.code}]====])
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,modelReferences=info.models,designMeters={width=4,depth=4,wallHeight=3,seat=0.4375,plantHeight=0.875,rugWidth=3,rugDepth=2},
overview={eye=s:cameraPoint({6,4.2,6}),lookat=s:cameraPoint({1.5,0.8,1.5})},detail={eye=s:cameraPoint({4,1.8,5}),lookat=s:cameraPoint({1.8,0.5,1.6})}}`;
const source=path.join(out,'repair.lua');fs.writeFileSync(source,code);fs.writeFileSync(path.join(out,'canonical.lua'),compiled.code);
execFileSync(process.execPath,['scripts/paracraft-scoped-revision-native.cjs',handle,source,out],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/paracraft-template-native.cjs','8099',failed.identity.worldPath,source,out,'--capture-existing'],{stdio:'inherit'});
