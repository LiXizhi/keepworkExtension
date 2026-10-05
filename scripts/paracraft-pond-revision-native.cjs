// Same-site native pond revision: prove original soil restoration before rebuilding.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const [handleArg,outArg]=process.argv.slice(2);assert(handleArg&&outArg);
const h=JSON.parse(fs.readFileSync(handleArg,'utf8')),out=path.resolve(outArg);assert(h.request.template==='pocket_pond');fs.mkdirSync(out,{recursive:true});
require.extensions['.ts']=(module,file)=>module._compile(require('typescript').transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const compiled=require('../src/mcp/paracraftTemplates.ts').compileCreationTemplate({...h.request,templateHash:undefined},h.session);assert.equal(compiled.metadata.sceneName,h.sceneName);
let canonical=compiled.code.replace('s:terrain({position={1,-2,1},dimensions={2,1,2},blockId="StoneBrick"})',
 's:terrain({position={2,-2,1},dimensions={1,1,2},blockId="StoneBrick"})\ns:terrain({position={1,-2,2},dimensions={1,1,1},blockId="StoneBrick"})')
 .replace('s:surface({position={1,0,1},dimensions={2,1,2},blockId="Still_Water"})',
 's:surface({position={2,0,1},dimensions={1,1,2},blockId="Still_Water"})\ns:surface({position={1,0,2},dimensions={1,1,1},blockId="Still_Water"})')
 .replace('position={1,0,1},blockId="LilyPad"','position={2,0,2},blockId="LilyPad"')
 .replace('groundBackups=12','groundBackups=10,waterAreaMetersSquared=3');
assert(canonical!==compiled.code&&!canonical.includes(']====]'));
const start=canonical.indexOf('s:group("basin")'),end=canonical.indexOf('s:group("planting")'),tail=canonical.indexOf('wait(2)');assert(start>0&&end>start&&tail>end);
const prefix=`local s=createScene({name="birdbath_garden",resume=true})
local baseline,untouched={},{}
for key,m in pairs(s.cells)do
 if m.group=="basin"or m.group=="aquatic"then
  baseline[#baseline+1]={position=m.position,originalFingerprint=s.world:Fingerprint(m.original)}
 else untouched[key]=m.fingerprint end
end
assert(#baseline==9)
s:remove("aquatic");s:remove("basin")
for _,m in ipairs(baseline)do assert(s.world:Fingerprint(s.world:Snapshot(m.position))==m.originalFingerprint,"original pond soil not restored")end
`;
let source=prefix+canonical.slice(start,end)+canonical.slice(tail);
source=source.replace('nativePlants=4,','restoredBeforeRebuild=9,untouchedMembers=7,nativePlants=4,');
source=source.replace('s:save();local info=',`for key,fp in pairs(untouched)do assert(s.cells[key].fingerprint==fp and s.world:Fingerprint(s.world:Snapshot(s.cells[key].position))==fp,"unrelated path/plant changed")end\ns:save([====[${canonical}]====]);local info=`);
const patch=path.join(out,'revision.lua');fs.writeFileSync(patch,source);fs.writeFileSync(path.join(out,'canonical.lua'),canonical);
execFileSync(process.execPath,['scripts/paracraft-scoped-revision-native.cjs',handleArg,patch,out],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/paracraft-template-native.cjs','8099',h.identity.worldPath,patch,out,'--capture-existing'],{stdio:'inherit'});
