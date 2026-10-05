// Run after paracraft-world-memory-native.cjs in the same fenced disposable world.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {cli,job}=require('./paracraft-world-memory-native.cjs');
const out=path.resolve(process.argv[2]||'tmp/world-memory-acceptance');
const native=code=>cli('run_npl_code',{code});
const call=name=>native(`NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/WorldMemoryNative.lua");return MyCompany.Aries.Game.ParacraftCLI.WorldMemoryNative.${name}();`);
const world=params=>cli('run_command',{world:params});
async function entered(target){for(let i=0;i<90;i++){const r=await world({operation:'status'});if(r.worldEntered&&r.worldPath===target)return;await new Promise(r=>setTimeout(r,500));}throw new Error('open pending; inspect before resubmitting');}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 let identity=(await cli('get_creation_capabilities')).identity;
 assert(identity.worldPath.includes('/CreationAcceptance_WorldMemory_'));
 let overview=await cli('analyze_world',{expectedIdentity:identity});
 if(!overview.objects.some(o=>o.kind==='module'&&o.source==='runtime'))await call('AddObjects');
 overview=await cli('analyze_world',{expectedIdentity:identity});
 for(const kind of ['code','movie','sign','module'])assert(overview.objects.some(o=>o.kind===kind&&o.source==='saved'),`missing unloaded ${kind}`);
 assert(overview.objects.some(o=>o.kind==='code'&&o.relations.some(r=>r.evidence==='native_association')));
 const mod=overview.objects.find(o=>o.kind==='module'&&o.source==='runtime');assert(mod.relations.some(r=>r.kind==='contains'));
 const code=overview.objects.find(o=>o.kind==='code'&&o.source==='runtime');const codeDetail=await cli('read_scene_object',{ref:code.ref,details:true});assert.equal(codeDetail.thirdParty.name,'fixture.film');
 const sign=overview.objects.find(o=>o.kind==='sign'&&o.source==='runtime');assert(sign.relations.some(r=>r.kind==='describes'));
 const before=(await call('Snapshot')).result;assert(before.ok);
 await world({operation:'save',expectedWorldPath:identity.worldPath});
 const originalPath=identity.worldPath,originalName=originalPath.replace(/\/$/,'').split('/').at(-1),scratch='CreationAcceptance_WorldMemory_Resume';
 const scratchWorld=await world({operation:'create',name:scratch});
 await world({operation:'open',name:scratch,expectedWorldPath:originalPath,confirmSwitch:true});await entered(scratchWorld.worldPath);
 await world({operation:'open',name:originalName,expectedWorldPath:scratchWorld.worldPath,confirmSwitch:true});await entered(originalPath);
 identity=(await cli('get_creation_capabilities')).identity;
 assert.notEqual(identity.sessionId,before.identity.sessionId);
 const stale=await native(`return MyCompany.Aries.Game.ParacraftCLI.WorldAnalysis.ReadObject({ref=commonlib.Json.Decode([=[${JSON.stringify(code.ref)}]=])}).ok`);assert.equal(stale.result,false);
 let after;for(let i=0;i<30;i++){try{after=(await call('Snapshot')).result;break}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,500))}}
 assert.deepEqual(after.movies,before.movies);assert.equal(after.code,before.code);assert.equal(after.sign,before.sign);assert.equal(after.module,before.module);
 const instructions=await cli('world_files',{operation:'read',path:'AGENTS.md',expectedIdentity:identity});assert(instructions.content.includes('docs/README.md'));
 const notes=await cli('world_files',{operation:'read',path:'docs/movies.md',expectedIdentity:identity});assert(notes.content.includes('memory_film'));
 const revised=(await call('ReviseCamera')).result;assert(revised.ok&&!revised.worldSaved);
 const changed=(await call('Snapshot')).result;
 assert.notDeepEqual(changed.movies[2],after.movies[2]);for(const i of [0,1,3])assert.deepEqual(changed.movies[i],after.movies[i]);
 const docsBefore=await cli('world_files',{operation:'read',path:'docs/changes.md',expectedIdentity:identity});
 const pendingText='# Changes\nrequest: camera-revision-1\nshot2 camera changed and verified. Native world UNSAVED. Recheck after reopen.';
 const update={operation:'update',expectedIdentity:identity,files:[{path:'docs/changes.md',expectedContent:docsBefore.content,content:pendingText}]};
 await cli('world_docs',update);assert((await cli('world_docs',update)).files.every(f=>f.status==='unchanged'));
 const captureParams={expectedIdentity:identity,moviePosition:revised.position,timeSeconds:1.5,...JSON.parse(fs.readFileSync(path.join(out,'film.json'))).result.view};
 let image;try{image=await cli('camera_capture',captureParams)}catch(error){await cli('bring_to_front');await new Promise(r=>setTimeout(r,500));image=await cli('camera_capture',captureParams)}
 fs.writeFileSync(path.join(out,'reopened.png'),Buffer.from(image.base64,'base64'));
 const current=await cli('analyze_world',{expectedIdentity:identity});assert(current.objects.some(o=>o.position.join()===revised.position.join()&&o.differsFromSaved));
 // Leave the revision unsaved intentionally; documents must say so.
 fs.writeFileSync(path.join(out,'reopen-report.json'),JSON.stringify({before,after,changed,overview,current,revised,identity},null,2));
 console.log('PASS saved/unloaded core objects, module/code/sign relationships, save/reopen, expired refs, document navigation, isolated camera revision and unsaved difference');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
