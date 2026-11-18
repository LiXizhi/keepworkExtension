'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {deflateSync}=require('node:zlib'),{createHash}=require('node:crypto');
const {verifyAssetBundle,manifestDigest}=require('../asset-verifier.cjs');
const fixture=require('../fixtures/asset-bundle.json');
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;}
function png(w,h){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc((w*4+1)*h))),chunk('IEND',Buffer.alloc(0))]);}
function setup(){const f=structuredClone(fixture);return{m:f.manifest,o:{approval:f.approval,nowMs:f.nowMs,resources:new Map(Object.entries(f.resourcesBase64).map(([k,v])=>[k,Buffer.from(v,'base64')]))}};}
function grid(s,columns=2,frames=4){const p=s.m.poses.speaking,b=png(s.m.width*columns,s.m.height*Math.ceil(frames/columns));p.columns=columns;p.frameCount=frames;p.file={path:'grid.png',bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};s.o.resources.delete('speaking.png');s.o.resources=new Map([...s.o.resources].filter(([k])=>[s.m.poster,...Object.values(s.m.poses).map(p=>p.file)].some(f=>f.path===k)));s.o.resources.set('grid.png',b);}
function approve(s){s.o.approval.manifestSha256=manifestDigest(s.m);}
test('grid geometry is explicitly pinned while legacy horizontal bundles still verify',()=>{
 const legacy=setup();verifyAssetBundle(legacy.m,legacy.o);
 const s=setup();grid(s);assert.throws(()=>verifyAssetBundle(s.m,s.o));approve(s);
 assert.equal(verifyAssetBundle(s.m,s.o).manifest.poses.speaking.columns,2);
 s.m.poses.speaking.columns=4;approve(s);assert.throws(()=>verifyAssetBundle(s.m,s.o),/resource-dimensions/);
});
test('grid rejects invalid columns and retains existing sheet height and pixel limits',()=>{
 for(const columns of [0,-1,1.5,5]){const s=setup();grid(s);s.m.poses.speaking.columns=columns;assert.throws(()=>{approve(s);verifyAssetBundle(s.m,s.o);});}
 const s=setup();grid(s);s.m.height=2048;approve(s);assert.throws(()=>verifyAssetBundle(s.m,s.o),/sheet-dimensions/);
 const partial=setup();grid(partial,2,3);approve(partial);verifyAssetBundle(partial.m,partial.o);
 const alias=setup();grid(alias);alias.m.poses.happy={...alias.m.poses.speaking,frameCount:3};approve(alias);assert.throws(()=>verifyAssetBundle(alias.m,alias.o),/ambiguous-resource-reference/);
});
test('larger desktop byte profile requires explicit trusted approval and never changes geometry bounds',()=>{
 const s=setup();grid(s);approve(s);
 assert.throws(()=>verifyAssetBundle(s.m,{...s.o,profile:'desktop-native-grid-v1'}),/asset-profile-approval/);
 s.o.approval.assetProfile='desktop-native-grid-v1';
 assert.throws(()=>verifyAssetBundle(s.m,s.o),/asset-profile-approval/);
 const options={...s.o,profile:'desktop-native-grid-v1'};
 assert.equal(verifyAssetBundle(s.m,options).assetProfile,'desktop-native-grid-v1');
 assert.throws(()=>verifyAssetBundle(s.m,{...options,profile:'unbounded'}),/asset-profile-approval/);
 s.m.height=2048;approve(s);assert.throws(()=>verifyAssetBundle(s.m,options),/sheet-dimensions/);
});
test('native desktop profile admits a bounded real PNG that the standard byte budget rejects',()=>{
 const s=setup(),w=512,h=1024,ihdr=Buffer.alloc(13),raw=require('node:crypto').randomBytes((w*4+1)*h);
 ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
 for(let y=0;y<h;y++)raw[y*(w*4+1)]=0;
 const b=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
 assert.ok(b.length>2*1024*1024 && b.length<2.5*1024*1024);
 const file={path:'native.png',bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};
 s.m.width=w;s.m.height=h;s.m.poster=file;
 for(const pose of Object.values(s.m.poses)){pose.file=file;pose.frameCount=1;}
 s.o.resources=new Map([[file.path,b]]);approve(s);
 assert.throws(()=>verifyAssetBundle(s.m,s.o),/resource-size/);
 s.o.approval.assetProfile='desktop-native-grid-v1';
 verifyAssetBundle(s.m,{...s.o,profile:'desktop-native-grid-v1'});
});
