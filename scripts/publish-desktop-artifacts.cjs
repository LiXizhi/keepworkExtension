#!/usr/bin/env node
// Publish exact CI installers from an Actions artifact download. Never build/repack.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const desktopRequire = createRequire(path.resolve(__dirname, '../apps/aichat-desktop/package.json'));
const qiniu = require('./lib/qiniu-release.cjs');
const { collect, publishRelease } = require('./publish-desktop.cjs');
const TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
const hash = (file, algorithm='sha256', encoding='hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
function validateArtifact(dir, { target, version, commit }) {
  if (!TARGETS.includes(target) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw Error('Require a supported target, exact version and full commit SHA');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'publisher-build.json'), 'utf8'));
  if (meta.target !== target || meta.version !== version || meta.commit !== commit) throw Error(`Artifact identity mismatch: ${target}`);
  const names = fs.readdirSync(dir).filter(n => /\.(exe|dmg|zip|blockmap|yml)$/.test(n));
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile() || !/^[a-f0-9]{64}$/.test(meta.files?.[name] || '') || hash(file) !== meta.files[name]) throw Error(`Artifact checksum mismatch: ${target}/${name}`);
  }
  const stem = `KeepWork-SecondBrain-${version}-${target.split('-')[1]}`;
  if (names.filter(n=>n.endsWith('.zip')).join() !== stem+'.zip') throw Error(`Unexpected installer ZIP: ${target}`);
  if (target==='win32-x64' && !names.includes(stem+'.exe')) throw Error('Windows installer EXE is missing');
  const yaml = desktopRequire('js-yaml');
  const update = yaml.load(fs.readFileSync(path.join(dir,target==='win32-x64'?'latest.yml':'latest-mac.yml'),'utf8'));
  if (String(update.version)!==version || !Array.isArray(update.files) || !update.files.length) throw Error(`Invalid updater metadata: ${target}`);
  for (const file of update.files) {
    if (typeof file.url!=='string' || path.basename(file.url)!==file.url || !names.includes(file.url)) throw Error(`Invalid updater file: ${target}`);
    const local=path.join(dir,file.url);
    if (fs.statSync(local).size!==file.size || hash(local,'sha512','base64')!==file.sha512) throw Error(`Updater checksum mismatch: ${target}/${file.url}`);
  }
  const installer=target==='win32-x64'?stem+'.exe':stem+'.zip';
  if (!update.files.some(f=>f.url===installer) || update.path!==installer || update.sha512!==hash(path.join(dir,installer),'sha512','base64')) throw Error(`Updater entry mismatch: ${target}`);
  return { meta, names };
}
function loadConfig(file) {
  let data={};
  if(file) { data=desktopRequire('js-yaml').load(fs.readFileSync(file,'utf8'));data=data.qiniu || data; }
  if(data.bucketName && data.bucketName!=='haqi') throw Error('Desktop releases require bucket haqi');
  return {accessKey:qiniu.required(process.env.KP_QINIU_ACCESS_KEY||data.accessKey,'KP_QINIU_ACCESS_KEY'),secretKey:qiniu.required(process.env.KP_QINIU_SECRET_KEY||data.secretKey,'KP_QINIU_SECRET_KEY'),bucket:'haqi',uploadHost:'https://up-z2.qiniup.com'};
}
async function prepareArtifacts(root, stage, identity, targets) {
  const result=[];
  for(const target of targets) {
    const name='desktop-'+target;
    let source=path.join(root,name);
    if(!fs.existsSync(source)) {
      const archive=source+'.zip';
      if(!fs.existsSync(archive)) throw Error(`Missing Actions artifact: ${archive}`);
      source=path.join(stage,'unpacked',name);
      await desktopRequire('extract-zip')(archive,{dir:source});
    }
    const {meta,names}=validateArtifact(source,{...identity,target});
    const dir=path.join(stage,name);fs.mkdirSync(dir,{recursive:true});
    for(const file of [...names,'publisher-build.json']) fs.copyFileSync(path.join(source,file),path.join(dir,file));
    const entries=collect(dir,target);
    console.log(`Validated ${target} ${meta.version} @ ${meta.commit}: ${entries.length} CDN objects`);
    result.push({target,entries,meta});
  }
  return result;
}
async function main() {
  const args=qiniu.readArgs(process.argv.slice(2));
  for(const key of Object.keys(args)) if(!['dryRun','artifacts','version','commit','run-id','target','config','report'].includes(key)) throw Error('Unknown argument: '+key);
  if(!args.artifacts || !/^\d+$/.test(args['run-id']||'')) throw Error('Require --artifacts DIR --run-id ID --version VERSION --commit FULL_SHA [--config qiniu.yaml] [--target TARGET] [--dry-run]');
  const targets=args.target?[args.target]:TARGETS;
  const root=path.resolve(args.artifacts),stage=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-ci-publish-'));
  try {
    // Validate ALL selected platforms before the first CDN mutation.
    const plan=await prepareArtifacts(root,stage,args,targets);
    if(args.dryRun) {console.log('Validation only; no CDN writes.');return;}
    const config=loadConfig(args.config);
    for(const item of plan) {
      const url=`https://cdn.keepwork.com/keepwork/aichat-desktop/${item.target}/latest-client.json`;
      const response=await fetch(url+'?preflight='+Date.now(),{signal:AbortSignal.timeout(20000)});
      if(response.ok) {
        const old=await response.json();
        const a=String(old.version).split('.').map(Number),b=args.version.split('.').map(Number);
        if(a.length!==3 || a.some(n=>!Number.isInteger(n))) throw Error('Invalid live version');
        const delta=a.map((n,i)=>n-b[i]).find(n=>n!==0)||0;
        if(delta>0) throw Error(`Refusing downgrade from ${old.version} to ${args.version}`);
        if(delta===0 && old.sha256!==item.entries.find(e=>e.name==='KeepWork-SecondBrain.zip').sha256) throw Error(`Live ${args.version} differs; choose a new version`);
      } else if(response.status!==404) throw Error(`CDN preflight HTTP ${response.status}`);
    }
    const report={schemaVersion:1,runId:args['run-id'],commit:args.commit,version:args.version,startedAt:new Date().toISOString(),targets:{}};
    const reportFile=path.resolve(args.report||path.join(root,'publish-receipt.json'));
    for(const item of plan) {
      console.log(`Publishing ${item.target} from Actions ${args['run-id']}`);
      await publishRelease(item.entries,config);
      report.targets[item.target]={verifiedAt:new Date().toISOString(),files:Object.fromEntries(item.entries.map(e=>[e.name,{sha256:e.sha256,size:e.size,url:e.url}]))};
      fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
      console.log(`Published and verified ${item.target}`);
    }
    console.log(`Release receipt: ${reportFile}`);
  } finally { fs.rmSync(stage,{recursive:true,force:true}); }
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={validateArtifact,prepareArtifacts};
