// Terminal failure recovery: keep geometry/assets/origin; rebuild only the movie.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const [failedDir,outArg]=process.argv.slice(2);assert(failedDir&&outArg);const failed=JSON.parse(fs.readFileSync(path.join(failedDir,'job.json'))),out=path.resolve(outArg);assert(failed.request.template==='trotting_dog');fs.mkdirSync(out,{recursive:true});
require.extensions['.ts']=(module,file)=>module._compile(require('typescript').transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const compiled=require('../src/mcp/paracraftTemplates.ts').compileCreationTemplate({...failed.request,templateHash:undefined},failed.session);assert.equal(compiled.metadata.sceneName,failed.sceneName);
const start=compiled.code.indexOf('s:group("movie")');assert(start>0);const prefix=`local s=createScene({name="birdbath_garden",resume=true})
local unit=s:cameraPoint({1,0,0})[1]-s:cameraPoint({0,0,0})[1]
local files={body="blocktemplates/"..s.name.."_body.x",leg="blocktemplates/"..s.name.."_leg.x",tail="blocktemplates/"..s.name.."_tail.x"}
s:requireModels({files.body,files.leg,files.tail})
s:remove("movie")
`;
const code=prefix+compiled.code.slice(start).replace('s:save();local info=',`s:save([====[${compiled.code}]====]);local info=`);
const handle=path.join(out,'context.json'),source=path.join(out,'repair.lua');fs.writeFileSync(handle,JSON.stringify({identity:failed.identity,session:failed.session,sceneName:failed.sceneName},null,2));fs.writeFileSync(source,code);fs.writeFileSync(path.join(out,'canonical.lua'),compiled.code);
execFileSync(process.execPath,['scripts/paracraft-scoped-revision-native.cjs',handle,source,out],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/paracraft-template-native.cjs','8099',failed.identity.worldPath,source,out,'--capture-existing'],{stdio:'inherit'});
