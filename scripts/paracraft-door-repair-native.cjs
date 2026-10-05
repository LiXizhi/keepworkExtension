// Terminal failure recovery: retain the existing timber/floor; add missing doors only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const [failedArg,outArg]=process.argv.slice(2);assert(failedArg&&outArg);const h=JSON.parse(fs.readFileSync(path.join(failedArg,'job.json'))),out=path.resolve(outArg);assert(h.request.template==='doorway');fs.mkdirSync(out,{recursive:true});
require.extensions['.ts']=(module,file)=>module._compile(require('typescript').transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const compiled=require('../src/mcp/paracraftTemplates.ts').compileCreationTemplate({...h.request,templateHash:undefined},h.session);assert.equal(compiled.metadata.sceneName,h.sceneName);
const index=compiled.code.indexOf('s:group("entries")');assert(index>0);
const source='local s=createScene({name="birdbath_garden",resume=true})\n'+compiled.code.slice(index).replace('s:save();local info=',`s:save([====[${compiled.code}]====]);local info=`);
const patch=path.join(out,'repair.lua');fs.writeFileSync(patch,source);fs.writeFileSync(path.join(out,'canonical.lua'),compiled.code);
execFileSync(process.execPath,['scripts/paracraft-scoped-revision-native.cjs',path.join(failedArg,'job.json'),patch,out],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/paracraft-template-native.cjs','8099',h.identity.worldPath,patch,out,'--capture-existing'],{stdio:'inherit'});
