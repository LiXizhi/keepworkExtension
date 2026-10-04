const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {startDevelopmentServer}=require('../src/dev-server.cjs');
test('local source server serves modules, skips occupied ports and rejects hidden files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-dev-'));let a,b;
 try {
  fs.writeFileSync(path.join(root,'AIChat.html'),'<title>local source</title>');
  fs.writeFileSync(path.join(root,'app.js'),'export const local=true');
  fs.writeFileSync(path.join(root,'.env'),'secret');
  a=await startDevelopmentServer(root,0);b=await startDevelopmentServer(root,Number(new URL(a.url).port));
  assert.notEqual(a.url,b.url);
  assert.match(await (await fetch(b.url)).text(),/local source/);
  const module=await fetch(new URL('app.js',b.url));assert.equal(module.headers.get('content-type'),'text/javascript');
  assert.equal((await fetch(new URL('.env',b.url))).status,404);
  assert.equal((await fetch(b.url,{method:'POST'})).status,405);
 } finally {a?.close();b?.close();fs.rmSync(root,{recursive:true,force:true});}
});
