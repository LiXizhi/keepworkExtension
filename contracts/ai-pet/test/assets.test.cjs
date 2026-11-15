'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{deflateSync}=require('node:zlib');
const {verifyAssetBundle,manifestDigest}=require('../asset-verifier.cjs');
const fixture=require('../fixtures/asset-bundle.json');
function setup(){const f=structuredClone(fixture);return {m:f.manifest,options:{approval:f.approval,nowMs:f.nowMs,resources:new Map(Object.entries(f.resourcesBase64).map(([k,v])=>[k,Buffer.from(v,'base64')]))}};}
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4,4,'latin1');data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;}
function png({width=2,height=2,color=6,depth=8,interlace=0,filter=0,extra=Buffer.alloc(0),raw,compressed}={}){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;header[12]=interlace;const pixels=raw||Buffer.alloc((width*4+1)*height);if(!raw)for(let y=0;y<height;y++)pixels[y*(width*4+1)]=filter;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),extra,chunk('IDAT',compressed||deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
function replace(s,bytes){s.options.resources.set('synthetic.png',bytes);for(const file of [s.m.poster,...Object.values(s.m.poses).map(p=>p.file)])if(file.path==='synthetic.png'){file.bytes=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');}s.options.approval.manifestSha256=manifestDigest(s.m);}
function approve(s){s.options.approval.manifestSha256=manifestDigest(s.m);}
test('synthetic approved bundle validates poster, seven poses, six locales and a two-frame strip',()=>{const s=setup(),r=verifyAssetBundle(s.m,s.options);assert.equal(r.resources.size,2);assert.equal(r.format,'ai-pet.dev.asset-admission.v1');assert.equal(r.manifest.poses.speaking.frameCount,2);s.options.resources.get('synthetic.png').fill(0);s.m.labels['ja-JP']='changed';assert.notEqual(r.resources.get('synthetic.png')[0],0);assert.notEqual(r.manifest.labels['ja-JP'],'changed');});
test('self asserted manifest provenance is not independent approval',()=>{const s=setup();assert.throws(()=>verifyAssetBundle(s.m),/approval/);for(const change of [{status:'revoked'},{usage:'production'},{validUntilMs:1000},{manifestSha256:'0'.repeat(64)}])assert.throws(()=>verifyAssetBundle(s.m,{...s.options,approval:{...s.options.approval,...change}}),/asset:/);for(const k of Object.keys(s.options.approval.identity))assert.throws(()=>verifyAssetBundle(s.m,{...s.options,approval:{...s.options.approval,identity:{...s.options.approval.identity,[k]:'other'}}}),/identity-binding/);for(const k of Object.keys(s.m.provenance))assert.throws(()=>verifyAssetBundle(s.m,{...s.options,approval:{...s.options.approval,provenance:{...s.m.provenance,[k]:'other'}}}),/rights-binding/);});
test('bytes, size and exact resource set must match with no partial admission or input mutation',()=>{for(const mutation of [s=>s.options.resources.delete('speaking.png'),s=>s.options.resources.set('extra.png',Buffer.from('x')),s=>s.options.resources.set('synthetic.png',Buffer.from('wrong')),s=>{const b=s.options.resources.get('speaking.png');b[b.length-1]^=1;}]){const s=setup();mutation(s);const before=structuredClone(s.m);assert.throws(()=>verifyAssetBundle(s.m,s.options),/asset:/);assert.deepEqual(s.m,before);}});
test('manifest geometry, animation, anchor and required pose/locale limits',()=>{for(const mutate of [m=>m.width=2049,m=>m.poses.idle.frameCount=33,m=>m.poses.idle.frameDurationMs=19,m=>m.poses.idle.frameDurationMs=10001,m=>{m.poses.idle.frameCount=32;m.poses.idle.frameDurationMs=2000;},m=>m.anchor.x=1.1,m=>delete m.poses.error,m=>delete m.labels['ko-KR']]){const s=setup();mutate(s.m);try{approve(s);}catch{}assert.throws(()=>verifyAssetBundle(s.m,s.options));}});
test('shared paths must identify consistent digest/size/frame layout; case aliases rejected',()=>{for(const mutate of [m=>m.poses.idle.file={...m.poster,sha256:'0'.repeat(64)},m=>m.poses.idle.frameCount=2,m=>m.poses.idle.file={...m.poster,path:'Synthetic.png'}]){const s=setup();mutate(s.m);approve(s);assert.throws(()=>verifyAssetBundle(s.m,s.options),/ambiguous|case-alias/);}});
for(const [name,bytes] of Object.entries({
 'CRC error':(()=>{const b=png();b[29]^=1;return b;})(),
 'dimension mismatch':png({width:3}),
 'palette unsupported':png({color:3}),
 '16 bit unsupported':png({depth:16}),
 'interlace unsupported':png({interlace:1}),
 'filter invalid':png({filter:5}),
 'APNG unsupported':png({extra:chunk('acTL',Buffer.alloc(8))}),
 'trailing bytes':Buffer.concat([png(),Buffer.from('x')]),
 'truncated PNG':png().subarray(0,40),
 'inflated excess':png({raw:Buffer.alloc(100000)}),
 'inflated short':png({raw:Buffer.alloc(1)}),
 'trailing deflate':png({compressed:Buffer.concat([deflateSync(Buffer.alloc(18)),Buffer.from('x')])}),
 'duplicate header':png({extra:chunk('IHDR',Buffer.alloc(13))})
}))test(`reject approved malformed/unsupported bytes: ${name}`,()=>{const s=setup();replace(s,bytes);assert.throws(()=>verifyAssetBundle(s.m,s.options),/asset:/);});
test('unsupported webp and traversing paths fail even with matching approved manifest',()=>{for(const path of ['../secret.png','sprite.webp']){const s=setup();s.m.poster.path=path;try{approve(s);}catch{}assert.throws(()=>verifyAssetBundle(s.m,s.options));}});
test('shared mutable byte storage is rejected',()=>{const s=setup();const b=s.options.resources.get('synthetic.png'),view=new Uint8Array(new SharedArrayBuffer(b.length));view.set(b);s.options.resources.set('synthetic.png',view);assert.throws(()=>verifyAssetBundle(s.m,s.options),/resource-bytes/);});
for(const f of require('../fixtures/asset-negative.json'))test(`portable asset negative: ${f.reason}`,()=>{
  const s=setup(),parts=f.path.slice(1).split('/'),key=parts.pop(),parent=parts.reduce((o,k)=>o[k],s.m);
  if(f.remove)delete parent[key];else parent[key]=f.value;
  try{approve(s);}catch{} // Synthetic trusted approval only; parser still rejects unsafe semantics.
  assert.throws(()=>verifyAssetBundle(s.m,s.options));
});
