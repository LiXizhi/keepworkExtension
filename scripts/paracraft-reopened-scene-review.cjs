// Prepare a read-only resumed-scene job using a freshly observed world identity.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const [reportFile,outArg]=process.argv.slice(2);assert(reportFile&&outArg,'Usage: REOPENED_NATIVE_REPORT OUTPUT');
const report=JSON.parse(fs.readFileSync(reportFile)),out=path.resolve(outArg),result=report.result;
assert(report.identity.worldPath.includes('/CreationAcceptance')&&/^[\w-]+$/.test(result.name));fs.mkdirSync(out,{recursive:true});
const handle=path.join(out,'context.json');fs.writeFileSync(handle,JSON.stringify({identity:report.identity,session:report.performance.authoringSession,sceneName:result.name},null,2));
let movie='';if(result.animation){const local=result.animation.moviePosition.map((n,i)=>n-result.origin[i]);assert(local.every(Number.isInteger));movie=`s:openMovie("review",{${local.join(',')}});s:seek("review",0);wait(1)\n`;}
const code=`local s=createScene({name="birdbath_garden",resume=true})\n${movie}local result=commonlib.Json.Decode([====[${JSON.stringify(result)}]====]);local info=s:inspect();local groups={}\nfor name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end\nresult.groups=groups;result.modelReferences=info.models;result.origin=s.origin;return result`;
const source=path.join(out,'review.lua');fs.writeFileSync(source,code);
execFileSync(process.execPath,['scripts/paracraft-scoped-revision-native.cjs',handle,source,out],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/paracraft-template-native.cjs','8099',report.identity.worldPath,source,out,'--capture-existing'],{stdio:'inherit'});
