'use strict';

// Audit persisted native evidence and explicit pixel reviews; never manufacture a pass.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {catalog}=require('./fixtures/paracraft-integrated-catalog.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};

function audit(root){
 root=path.resolve(root);
 const reviews=fs.existsSync(path.join(root,'visual-review.json'))?json(path.join(root,'visual-review.json')):{};
 const rows=[],worlds=new Set(),pairs=new Map();
 for(const c of catalog){
  const dir=path.join(root,'round-'+String(c.id).padStart(2,'0')),failures=[];
  const check=(condition,message)=>{if(!condition)failures.push(message);};
  let r;
  try{r=json(path.join(dir,'report.json'));}catch{rows.push({round:c.id,status:'missing',failures:['No completed native report']});continue;}
  check(r.number===c.id&&r.case.pairId===c.pairId&&r.case.strategy===c.strategy,'Report does not match catalog case');
  check(r.machinePassed===true,'Native acceptance incomplete');
  check(!worlds.has(r.worldPath),'World reused as another round');worlds.add(r.worldPath);
  check(/\/CreationAcceptance_Integrated50_[^/]+_R\d{2}\/$/.test(r.worldPath),'Not an isolated campaign world');
  check(r.createdCells>0&&r.build.total===r.reopen.total,'Authored membership not preserved');
  check(r.reopen.staticStale===0,'Static members stale after reopening');
  check(r.sourceEquality?.passed===true,'Full generator reopen equality missing');
  check(r.checks?.nonTargetUnchanged===true&&r.checks?.playerCameraPreserved===true,'Scoped change or player/camera preservation missing');
  for(const [name,value]of Object.entries(r.checks||{}))if(typeof value==='boolean')check(value,'Failed check '+name);
  const nativeTests=r.logic?.tests||[];
  const expected={mixed:18,or:10,and:10,button:4,delay:5,fanout:6,long:6,lamp:6}[c.kind];
  check(nativeTests.length===expected&&nativeTests.every(t=>t.pass===true),'Native truth/reset/retrigger coverage incomplete');
  if(c.kind==='delay')check(nativeTests.filter(t=>Array.isArray(t.firstMs)).length===4,'Four delay transitions not recorded');
  if(c.kind==='button')check(r.logic.releaseMs?.length===2,'Both natural button releases not recorded');
  const reopenedJobs=fs.readdirSync(dir).filter(n=>/^reopen-inspect-\d+-job\.json$/.test(n));
  check(reopenedJobs.length>0,'Missing independent reopened inspection job');
  for(const name of ['build','revision',...reopenedJobs.map(n=>n.replace(/-job\.json$/,''))]){
   try{const j=json(path.join(dir,name+'-job.json'));check(j.state==='completed'&&!j.runtimeActive,'Job not terminal '+name);check(j.identity.worldPath===r.worldPath,'Job belongs to another world');}catch{check(false,'Missing terminal '+name+' job evidence');}
  }
  try{
   const source=fs.readFileSync(path.join(r.worldPath,'creation',r.build.sceneName,'source.lua'));
   check(sha(source)===r.sourceEquality.sha256,'Current world source differs from independently reopened source');
  }catch{check(false,'World-local generator not accessible');}
  const review=reviews[String(c.id)];
  check(review?.pass===true&&typeof review.findings==='string'&&review.findings.length>0,'Pixels not explicitly reviewed');
  for(const name of ['overview','entry']){
   const capture=r.images?.[name];
   try{
    const bytes=fs.readFileSync(capture.file);
    check(bytes.length===capture.bytes&&sha(bytes)===capture.sha256,'Image artifact hash mismatch '+name);
    check(capture.metadata?.cached!==true,'Cached capture '+name);
    check(review?.images?.[name]===capture.sha256,'Pixel review is for another image '+name);
   }catch{check(false,'Fresh image missing '+name);}
  }
  const buildJob=json(path.join(dir,'build-job.json'));
  const nativeJobMs=typeof buildJob.startedAt==='number'?buildJob.finishedAt-buildJob.startedAt:Date.parse(buildJob.finishedAt)-Date.parse(buildJob.startedAt);
  const result={round:c.id,family:c.family,pairId:c.pairId,strategy:c.strategy,kind:c.kind,cells:r.createdCells,
   helperCalls:r.build.helperCalls,buildMs:r.build.nativeBuildMs??(Number.isFinite(nativeJobMs)?nativeJobMs:r.timings.build),writeMs:r.build.writeMs??null,httpCount:r.httpCount,payloadBytes:r.payloadBytes,
   status:failures.length?'incomplete':'passed',failures};rows.push(result);
  if(!pairs.has(c.pairId))pairs.set(c.pairId,[]);pairs.get(c.pairId).push({report:r,result});
 }
 const comparisons=[];
 for(const [pairId,entries]of pairs){
  if(entries.length!==2){comparisons.push({pairId,equivalent:false,reason:'Missing pair member'});continue;}
  const cell=entries.find(x=>x.result.strategy==='cell'),span=entries.find(x=>x.result.strategy==='span');
  const a=cell.report,b=span.report;
  // Includes target roof when supplied separately, and actual geometry and behavior checks.
  const canonical=v=>JSON.stringify(Object.fromEntries(Object.entries(v||{}).sort(([x],[y])=>x.localeCompare(y))));
  const equivalent=canonical(a.nativeSignatures?.reopened)===canonical(b.nativeSignatures?.reopened)&&
   a.nativeSignatures?.reopened!=null&&b.nativeSignatures?.reopened!=null&&a.createdCells===b.createdCells&&
   a.geometry?.passed===true&&b.geometry?.passed===true&&a.logic.tests.every(t=>t.pass)&&b.logic.tests.every(t=>t.pass);
  comparisons.push({pairId,equivalent,cells:a.createdCells,cellBuildMs:cell.result.buildMs,spanBuildMs:span.result.buildMs,
   cellHelperCalls:cell.result.helperCalls,spanHelperCalls:span.result.helperCalls,
   speedRatio:cell.result.buildMs/span.result.buildMs,helperRatio:cell.result.helperCalls/span.result.helperCalls});
 }
 const passed=rows.filter(r=>r.status==='passed').length;
 const result={objectiveRounds:50,designBriefs:25,executedReports:rows.filter(r=>r.status!=='missing').length,
  passedRounds:passed,completed:passed===50&&comparisons.length===25&&comparisons.every(p=>p.equivalent),
  medianPairedBuildRatio:median(comparisons.filter(p=>p.equivalent).map(p=>p.speedRatio)),
  medianPairedHelperRatio:median(comparisons.filter(p=>p.equivalent).map(p=>p.helperRatio)),rows,comparisons};
 fs.writeFileSync(path.join(root,'audit.json'),JSON.stringify(result,null,2));
 return result;
}
if(require.main===module){const r=audit(process.argv[2]);process.stdout.write(JSON.stringify({passedRounds:r.passedRounds,completed:r.completed,medianPairedBuildRatio:r.medianPairedBuildRatio})+'\n');if(!r.completed)process.exitCode=2;}
module.exports={audit};
