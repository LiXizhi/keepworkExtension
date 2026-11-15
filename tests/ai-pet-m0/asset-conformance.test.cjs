'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{deflateSync}=require('node:zlib');
const {verifyAssetBundle,manifestDigest}=require('../../contracts/ai-pet/asset-verifier.cjs');
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;}
function fixture(){
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,20,40,60,255]))),chunk('IEND',Buffer.alloc(0))]);
 const m=structuredClone(require('../../contracts/ai-pet/fixtures/positive.json').assetManifest);m.width=1;m.height=1;
 const file={path:'qa.png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};m.poster=file;for(const p of Object.values(m.poses))p.file={...file};
 const approval={usage:'development-preview',status:'approved',validUntilMs:200,identity:Object.fromEntries(['appearanceId','appearanceVersion','characterId','characterVersion'].map(k=>[k,m[k]])),provenance:{...m.provenance},manifestSha256:manifestDigest(m)};
 return {m,options:{approval,nowMs:100,resources:new Map([['qa.png',bytes]])}};
}
test('QA asset: admitted bytes and manifest are isolated from caller mutation',()=>{const {m,options}=fixture();const r=verifyAssetBundle(m,options);options.resources.get('qa.png').fill(0);m.anchor.x=0;assert.equal(r.resources.get('qa.png')[0],137);assert.equal(r.manifest.anchor.x,0.5);});
test('QA asset: self-consistent manifest changes cannot replace independent approval',()=>{for(const mutate of [m=>m.characterVersion='2',m=>m.provenance.licenseRef='qa-other',m=>m.anchor.x=0]){const {m,options}=fixture();mutate(m);assert.throws(()=>verifyAssetBundle(m,options));}});
test('QA asset: approval expiry and withdrawal fail closed at exact boundary',()=>{for(const patch of [{status:'withdrawn'},{validUntilMs:100}]){const {m,options}=fixture();Object.assign(options.approval,patch);assert.throws(()=>verifyAssetBundle(m,options));}});
test('QA asset: corruption, extra resources and inconsistent shared-sheet geometry rejected',()=>{for(const mutate of [(m,o)=>o.resources.get('qa.png')[20]^=1,(m,o)=>o.resources.set('extra.png',Buffer.alloc(1)),(m,o)=>{m.poses.speaking.frameCount=2;o.approval.manifestSha256=manifestDigest(m);}]){const {m,options}=fixture();mutate(m,options);assert.throws(()=>verifyAssetBundle(m,options));}});
test('QA asset: approved hash and valid PNG header do not admit malformed decoded pixels',()=>{
 for(const raw of [Buffer.from([5,0,0,0,255]),Buffer.from([0,0,0]),Buffer.alloc(100000)]){
  const {m,options}=fixture(),old=options.resources.get('qa.png');
  const bytes=Buffer.concat([old.subarray(0,33),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  const file={path:'qa.png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  m.poster=file;for(const pose of Object.values(m.poses))pose.file={...file};
  options.resources.set('qa.png',bytes);options.approval.manifestSha256=manifestDigest(m);
  assert.throws(()=>verifyAssetBundle(m,options),/asset:/);
 }
});
