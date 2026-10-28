const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {validateEntry,openDeployment}=require('../src/deployment.cjs');
const {trustedPage}=require('../src/security.cjs');
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
test('desktop opens the pinned local base using the package runtime contract',async t=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-local-profile-'));
    t.after(()=>fs.rm(home,{recursive:true,force:true}));
    const root=path.join(home,'platform');
    const pinned=path.join(home,'packages','aichat-base','1.0.0','files');
    await fs.mkdir(path.join(root,'scripts'),{recursive:true});
    await fs.mkdir(path.join(pinned,'scripts'),{recursive:true});
    // Package management belongs to AIChat. Exercise its module boundary with
    // local fixtures so this suite works in a standalone extension checkout.
    await fs.writeFile(path.join(root,'scripts/package_store.mjs'),`
        export class PackageStore {
            constructor(home) { this.home=home; }
            async inspect(profile) {
                if (profile!=='minimal') throw Error('unexpected profile');
                return {profile:{baseDigest:'pinned',baseVersion:'1.0.0',config:{identity:{baseURL:'https://identity.example'}}}};
            }
        }
    `);
    await fs.writeFile(path.join(pinned,'scripts/package_server.mjs'),`
        import http from 'node:http';
        export async function servePackages({store,profile,root}) {
            if (!root.endsWith('files') || !store.home || profile!=='minimal') throw Error('incorrect runtime selection');
            const server=http.createServer((req,res)=>{
                if(req.url==='/boot.json') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({profile:{id:profile}}));}
                else {res.statusCode=404;res.end();}
            });
            await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
            return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
        }
    `);
    const file=path.join(home,'deployment.json');
    await fs.writeFile(file,JSON.stringify({schemaVersion:1,platformRoot:root,profileHome:home,profile:'minimal'}));
    const deployment=await openDeployment(file);
    try{
        assert.match(deployment.url,/^http:\/\/127\.0\.0\.1:/);
        assert.equal(deployment.config.identityRealm,'https://identity.example');
        assert.equal((await fetch(deployment.url+'/boot.json').then(r=>r.json())).profile.id,'minimal');
        assert.equal((await fetch(deployment.url+'/scripts/package_store.mjs')).status,404);
    }finally{await deployment.close();}
});
