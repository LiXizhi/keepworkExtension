'use strict';
// Pure development admission. No fetching, cache, rendering or rights authority.
const {createHash}=require('node:crypto');
const {inflateSync}=require('node:zlib');
const {shape}=require('./index.cjs');
const LIMITS=Object.freeze({fileBytes:2*1024*1024,totalBytes:8*1024*1024,dimension:2048,sheetWidth:4096,pixels:4194304,frames:32,chunks:64,minFrameMs:20,maxFrameMs:10000,maxCycleMs:60000});
// Higher compressed-byte allowance is desktop-only and requires an independent
// host approval. Decoded dimensions/pixels and all other checks stay identical.
const ASSET_PROFILES=Object.freeze({standard:Object.freeze({fileBytes:LIMITS.fileBytes,totalBytes:LIMITS.totalBytes}),'desktop-native-grid-v1':Object.freeze({fileBytes:5*1024*1024/2,totalBytes:16*1024*1024})});
const fail=(ok,reason)=>{if(!ok)throw new Error(`asset:${reason}`);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha256=b=>createHash('sha256').update(b).digest('hex');
function manifestDigest(manifest){shape('assetManifest',manifest);return sha256(JSON.stringify(canonical(manifest)));}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function inspectPng(b){
  fail(b.length>=45 && b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),'png-signature');
  let offset=8,width,height,ended=false,count=0;const compressed=[];
  while(offset<b.length){
    fail(++count<=LIMITS.chunks && offset+12<=b.length,'png-chunk-bounds');
    const length=b.readUInt32BE(offset),end=offset+12+length;
    fail(end<=b.length,'png-chunk-bounds');
    const type=b.toString('latin1',offset+4,offset+8),data=b.subarray(offset+8,end-4);
    fail(crc32(b.subarray(offset+4,end-4))===b.readUInt32BE(end-4),'png-crc');
    if(count===1){
      fail(type==='IHDR' && length===13,'png-header');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      fail(width>0 && height>0 && width<=LIMITS.sheetWidth && height<=LIMITS.dimension && width*height<=LIMITS.pixels,'png-dimensions');
      fail(data[8]===8 && data[9]===6 && data[10]===0 && data[11]===0 && data[12]===0,'unsupported-png-profile');
    }else if(type==='IDAT'){compressed.push(data);}
    else if(type==='IEND'){fail(length===0 && compressed.length>0 && end===b.length,'png-end');ended=true;}
    else throw new Error('asset:unsupported-png-chunk');
    offset=end;
  }
  fail(ended,'png-end');
  const input=Buffer.concat(compressed),expected=height*(1+4*width);
  let decoded;try{decoded=inflateSync(input,{maxOutputLength:expected,info:true});}catch{throw new Error('asset:png-deflate');}
  fail(decoded.buffer.length===expected && decoded.engine.bytesWritten===input.length,'png-data-length');
  for(let y=0;y<height;y++)fail(decoded.buffer[y*(1+4*width)]<=4,'png-filter');
  return {width,height};
}
function verifyAssetBundle(manifest,{approval,resources,nowMs,profile='standard'}={}){
  shape('assetManifest',manifest);
  fail(approval && approval.usage==='development-preview' && approval.status==='approved','independent-approval-required');
  fail(Object.hasOwn(ASSET_PROFILES,profile) && (approval.assetProfile ?? 'standard')===profile,'asset-profile-approval');
  const byteLimits=ASSET_PROFILES[profile];
  fail(Number.isSafeInteger(nowMs) && nowMs>=0 && Number.isSafeInteger(approval.validUntilMs) && approval.validUntilMs>nowMs,'approval-expired-or-time-invalid');
  const identity=['appearanceId','appearanceVersion','characterId','characterVersion'];
  fail(identity.every(k=>approval.identity?.[k]===manifest[k]),'identity-binding');
  fail(['sourceRef','licenseRef','rightsEvidenceRef'].every(k=>approval.provenance?.[k]===manifest.provenance[k]),'rights-binding');
  const digest=manifestDigest(manifest);
  fail(approval.manifestSha256===digest,'manifest-binding');
  fail(manifest.width<=LIMITS.dimension && manifest.height<=LIMITS.dimension,'frame-dimensions');
  fail(resources instanceof Map && resources.size>=1 && resources.size<=8,'resource-map');
  const refs=[{file:manifest.poster,frames:1,columns:1,rows:1},...Object.values(manifest.poses).map(p=>{
    fail(p.frameCount<=LIMITS.frames && p.frameDurationMs>=LIMITS.minFrameMs && p.frameDurationMs<=LIMITS.maxFrameMs && p.frameCount*p.frameDurationMs<=LIMITS.maxCycleMs,'frame-timing');
    const columns=p.columns ?? p.frameCount;
    fail(Number.isInteger(columns) && columns>=1 && columns<=p.frameCount,'grid-columns');
    return {file:p.file,frames:p.frameCount,columns,rows:Math.ceil(p.frameCount/columns)};
  })];
  const descriptors=new Map(),folded=new Set();
  for(const {file,frames,columns,rows} of refs){
    fail(file.path.length<=256 && file.path.endsWith('.png'),'unsupported-path-or-format');
    const descriptor={...file,frames,columns,rows,width:manifest.width*columns,height:manifest.height*rows};
    fail(descriptor.width<=LIMITS.sheetWidth && descriptor.height<=LIMITS.dimension && descriptor.width*descriptor.height<=LIMITS.pixels,'sheet-dimensions');
    if(descriptors.has(file.path))fail(JSON.stringify(canonical(descriptors.get(file.path)))===JSON.stringify(canonical(descriptor)),'ambiguous-resource-reference');
    else{fail(!folded.has(file.path.toLowerCase()),'case-alias');folded.add(file.path.toLowerCase());descriptors.set(file.path,descriptor);}
  }
  fail(resources.size===descriptors.size && [...resources.keys()].every(k=>descriptors.has(k)),'resource-set');
  // Copy all admitted bytes: caller mutation after return cannot swap verified content.
  const admitted=new Map();let total=0;
  for(const [path,d] of descriptors){
    const supplied=resources.get(path);
    fail(supplied instanceof Uint8Array && !(supplied.buffer instanceof SharedArrayBuffer),'resource-bytes');
    fail(d.bytes<=byteLimits.fileBytes && supplied.byteLength===d.bytes,'resource-size');
    total+=d.bytes;fail(total<=byteLimits.totalBytes,'bundle-size');
    const bytes=Buffer.from(supplied);
    fail(sha256(bytes)===d.sha256,'resource-digest');
    const info=inspectPng(bytes);fail(info.width===d.width && info.height===d.height,'resource-dimensions');
    admitted.set(path,bytes);
  }
  return {format:'ai-pet.dev.asset-admission.v1',assetProfile:profile,manifestSha256:digest,identity:Object.fromEntries(identity.map(k=>[k,manifest[k]])),manifest:structuredClone(manifest),resources:admitted};
}
module.exports={verifyAssetBundle,manifestDigest,LIMITS,ASSET_PROFILES};
