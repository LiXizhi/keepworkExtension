// Samples all three native shots and verifies presentation camera restoration.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {cli}=require('./paracraft-world-memory-native.cjs');
const out=path.resolve(process.argv[2]||'tmp/world-memory-acceptance');
const run=process.env.PARACRAFT_TEST_RUN||'v2';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const modes=()=>cli('run_npl_code',{code:'local C=MyCompany.Aries.Game.Code.Creation;local s=C.Scene:new():Init({name="memory_film",resume=true},{wait=function()end});local r={};for i=0,3 do local e=MyCompany.Aries.Game.EntityManager.GetBlockEntity(unpack(s:position({i,1,9})));r[#r+1]=e:IsPlayingMode()==true end;return r;'});
(async()=>{
 const identity=(await cli('get_creation_capabilities')).identity;assert(identity.worldPath.includes('/CreationAcceptance_WorldMemory_'));
 await cli('bring_to_front');
 const before=await cli('get_scene_info');
 const modesBefore=(await modes()).result;
 const started=await cli('run_code',{expectedIdentity:identity,authoringSession:'world-memory-acceptance',requestId:'memory-film-continuity-'+run,timeoutSeconds:60,
  code:'local s=createScene({name="memory_film",resume=true});s:openMovie("film",{0,1,9});return s:playMovie("film")'});
 const samples=[];
 await delay(700);
 for(let i=0;i<3;i++){
  const state=await cli('run_npl_code',{code:'local M=MyCompany.Aries.Game.Movie.MovieManager;local m=M:GetActiveMovieClip();assert(m);local root=m:GetActorFromItemStack(m:GetEntity():GetCommandItemStack(),true);local child=root:GetChildActor("actor_movie_sequence").last_movieclip;assert(child);return {master={m:GetEntity():GetBlockPos()},child={child:GetEntity():GetBlockPos()},time=m:GetTime()};'});
  const shot=await cli('screenshot',{fresh:true});fs.writeFileSync(path.join(out,`shot-${i+1}.jpg`),Buffer.from(shot.base64,'base64'));
  samples.push(state.result);if(i<2)await delay(3000);
 }
 for(let i=0;i<40;i++){const state=await cli('code_job',{expectedIdentity:identity,authoringSession:'world-memory-acceptance',jobId:started.jobId});
  assert.notEqual(state.state,'failed',JSON.stringify(state));if(state.sourceCompleted&&!state.runtimeActive)break;await delay(300);}
 const after=await cli('get_scene_info');
 const native=await cli('run_npl_code',{code:'return MyCompany.Aries.Game.Movie.MovieManager:GetActiveMovieClip()==nil;'});assert(native.result);
 assert.deepEqual((await modes()).result,modesBefore,'child playback modes were not restored');
 assert.equal(new Set(samples.map(s=>s.child.join())).size,3);
 assert.deepEqual(after.player.blockPosition,before.player.blockPosition);
 for(const key of ['eye','lookat'])for(let i=0;i<3;i++)assert(Math.abs(after.camera[key][i]-before.camera[key][i])<0.01,`camera ${key} not restored`);
 const cancelled=await cli('run_code',{expectedIdentity:identity,authoringSession:'world-memory-acceptance',requestId:'memory-film-cancel-'+run,timeoutSeconds:60,
  code:'local s=createScene({name="memory_film",resume=true});s:openMovie("film",{0,1,9});return s:playMovie("film")'});
 await delay(700);await cli('code_job',{expectedIdentity:identity,authoringSession:'world-memory-acceptance',jobId:cancelled.jobId,operation:'cancel'});
 assert((await cli('run_npl_code',{code:'return MyCompany.Aries.Game.Movie.MovieManager:GetActiveMovieClip()==nil;'})).result);
 assert.deepEqual((await modes()).result,modesBefore);
 fs.writeFileSync(path.join(out,'playback-report.json'),JSON.stringify({identity,samples,before:before.camera,after:after.camera},null,2));
 console.log('PASS three sequential native movies/cameras, player/camera restoration and cancellation cleanup');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
