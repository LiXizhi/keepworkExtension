const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {validateEntry,openDeployment}=require('../src/deployment.cjs');
const {trustedPage}=require('../src/security.cjs');
const {pathToFileURL}=require('node:url');
test('operator deployment preserves exact native origin/path trust',()=>{
    const entry=validateEntry('https://company.example/ai/');
    assert.equal(trustedPage(entry,entry),true);
    assert.equal(trustedPage('https://company.example/other/',entry),false);
    assert.equal(trustedPage('https://keepwork.com/chat',entry),false);
    for(const bad of ['https://user:password@company.example/','http://company.example/','file:///tmp/app.html'])assert.throws(()=>validateEntry(bad));
});
test('missing deployment preserves default; invalid config does not fall back',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-deployment-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'deployment.json');
    assert.equal(await openDeployment(file),null);
    await fs.writeFile(file,'{');await assert.rejects(openDeployment(file));
    await fs.writeFile(file,JSON.stringify({schemaVersion:1,entryURL:'https://company.example/ai/'}));
    assert.equal((await openDeployment(file)).url,'https://company.example/ai/');
});
test('desktop opens the pinned local base without a public application URL',async t=>{
    const root=process.env.AICHAT_SOURCE_DIR||path.resolve(__dirname,'../../../../apps/official/apps/tools/AIChat');
    const {PackageStore,makeArchive,readJSON,atomicJSON}=await import(pathToFileURL(path.join(root,'scripts/package_store.mjs')));
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-local-profile-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
    const store=new PackageStore(home);await store.install(await makeArchive(await readJSON(path.join(root,'platform/base-manifest.json')),root));
    await atomicJSON(path.join(store.profileDir('minimal'),'profile.json'),await readJSON(path.join(root,'profiles/minimal.json')));
    await store.stage('minimal');await store.activate('minimal');
    const file=path.join(home,'deployment.json');await atomicJSON(file,{schemaVersion:1,platformRoot:root,profileHome:home,profile:'minimal'});
    const deployment=await openDeployment(file);
    try{
        assert.match(deployment.url,/^http:\/\/127\.0\.0\.1:/);
        assert.equal((await fetch(deployment.url+'/boot.json').then(r=>r.json())).profile.id,'minimal');
        assert.equal((await fetch(deployment.url+'/scripts/package_store.mjs')).status,404);
    }finally{await deployment.close();}
});
