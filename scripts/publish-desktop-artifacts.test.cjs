const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {validateArtifact,prepareArtifacts}=require('./publish-desktop-artifacts.cjs');
const identity={commit:'a'.repeat(40),version:'0.1.6',target:'darwin-arm64'};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-artifact-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const name='KeepWork-SecondBrain-0.1.6-arm64.zip',body=Buffer.from('signed installer bytes');fs.writeFileSync(path.join(dir,name),body);
 const sha512=crypto.createHash('sha512').update(body).digest('base64');
 fs.writeFileSync(path.join(dir,'latest-mac.yml'),`version: 0.1.6\npath: ${name}\nsha512: ${sha512}\nfiles:\n  - url: ${name}\n    size: ${body.length}\n    sha512: ${sha512}\n`);
 const files=Object.fromEntries([name,'latest-mac.yml'].map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')]));
 fs.writeFileSync(path.join(dir,'publisher-build.json'),JSON.stringify({...identity,files}));return dir;
}
test('CI installer validates exact commit, platform, version and both checksums',t=>{
 const dir=fixture(t);assert.equal(validateArtifact(dir,identity).meta.version,'0.1.6');
 for(const changed of [{commit:'b'.repeat(40)},{version:'0.1.5'},{target:'darwin-x64'}])assert.throws(()=>validateArtifact(dir,{...identity,...changed}),/identity mismatch/);
 fs.appendFileSync(path.join(dir,'KeepWork-SecondBrain-0.1.6-arm64.zip'),'changed');assert.throws(()=>validateArtifact(dir,identity),/checksum mismatch/);
});
test('updater cannot point to a different installer even with a matching manifest SHA256',t=>{
 const dir=fixture(t),file=path.join(dir,'latest-mac.yml');fs.appendFileSync(file,'# updated\n');
 let text=fs.readFileSync(file,'utf8').replace('size: 22','size: 999');fs.writeFileSync(file,text);
 const m=JSON.parse(fs.readFileSync(path.join(dir,'publisher-build.json')));m.files['latest-mac.yml']=crypto.createHash('sha256').update(text).digest('hex');fs.writeFileSync(path.join(dir,'publisher-build.json'),JSON.stringify(m));
 assert.throws(()=>validateArtifact(dir,identity),/Updater checksum/);
});
test('preparation preserves signed ZIP bytes and only changes download metadata',async t=>{
 const dir=fixture(t),root=path.join(dir,'artifacts'),stage=path.join(dir,'stage');fs.mkdirSync(root);fs.mkdirSync(stage);const targetDir=path.join(root,'desktop-darwin-arm64');fs.mkdirSync(targetDir);for(const n of fs.readdirSync(dir)){if(fs.statSync(path.join(dir,n)).isFile())fs.copyFileSync(path.join(dir,n),path.join(targetDir,n));}
 const plan=await prepareArtifacts(root,stage,identity,['darwin-arm64']);
 const original=fs.readFileSync(path.join(dir,'KeepWork-SecondBrain-0.1.6-arm64.zip'));
 for(const n of ['KeepWork-SecondBrain.zip','KeepWork-SecondBrain-0.1.6-arm64.zip']){
 const entry=plan[0].entries.find(e=>e.name===n);assert.deepEqual(fs.readFileSync(entry.filePath),original);
 }
});
test('internal ad-hoc Mac artifacts cannot enter the public publisher', t => {
 const dir=fixture(t), file=path.join(dir,'publisher-build.json');
 const meta=JSON.parse(fs.readFileSync(file));meta.installationSecurity={macSigning:'ad-hoc'};fs.writeFileSync(file,JSON.stringify(meta));
 assert.throws(()=>validateArtifact(dir,identity),/Internal ad-hoc/);
});
