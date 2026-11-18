const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../assets/ainiang');
const ids = ['claude','gpt','gemini','grok','qwen','kimi','glm','minimax','deepseek'];
const states = ['idle','happy','listening','thinking','speaking','sleeping','error'];
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function inspectPng(base, file, width, height) {
  assert.match(file.path, /^[a-z]+\.png$/);
  const p = path.join(base, file.path);
  assert.equal(fs.lstatSync(p).isSymbolicLink(), false);
  const bytes = fs.readFileSync(p);
  assert.equal(bytes.length, file.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
  assert.deepEqual([...bytes.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6);
  const compressed = [];
  for (let offset=8; offset<bytes.length;) {
    const length=bytes.readUInt32BE(offset), type=bytes.toString('ascii',offset+4,offset+8);
    assert.ok(offset+length+12<=bytes.length);
    if(type==='IDAT') compressed.push(bytes.subarray(offset+8,offset+8+length));
    offset+=length+12;
  }
  const raw=zlib.inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (width*4+1)*height);
  let transparent=false, visible=false;
  let previous=Buffer.alloc(width*4);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++) {
    const offset=y*(width*4+1),filter=raw[offset],row=Buffer.alloc(width*4);
    assert.ok(filter<=4,'valid RGBA PNG filter');
    for(let x=0;x<row.length;x++) {
      const a=x>=4?row[x-4]:0,b=previous[x],c=x>=4?previous[x-4]:0;
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
      row[x]=(raw[offset+1+x]+predictor)&255;
    }
    for(let x=3;x<row.length;x+=4){transparent ||= row[x]===0;visible ||= row[x]>0;}
    previous=row;
  }
  assert.ok(transparent && visible, 'sprite must contain transparent and visible pixels');
  return bytes.length;
}
test('bundled experiment contains exactly nine authorized video-derived characters and seven states', () => {
  const catalog=json(path.join(root,'catalog.json'));
  assert.equal(catalog.experimentOnly,true);
  assert.deepEqual(catalog.characters.map(c=>c.id),ids);
  for(const character of catalog.characters) {
    assert.equal(character.manifest, `${character.id}/manifest.json`);
    const base=path.join(root,character.id), manifest=json(path.join(root,character.manifest));
    assert.equal(manifest.characterId,character.id);
    assert.equal(manifest.mouthMode,'prerecorded');
    if(character.id==='claude'){
      assert.equal(manifest.width,640,'retain native source width for 4x display');
      assert.equal(manifest.height,360,'retain native source height without stretching');
      assert.equal(manifest.appearanceVersion,'2');
      for(const pose of Object.values(manifest.poses)) assert.equal(pose.columns,4);
    }
    assert.deepEqual(Object.keys(manifest.poses).sort(),[...states].sort());
    let total=inspectPng(base,manifest.poster,manifest.width,manifest.height);
    for(const state of states) {
      const pose=manifest.poses[state]; assert.equal(pose.frameCount,16); assert.equal(pose.frameDurationMs,250);
      total+=inspectPng(base,pose.file,manifest.width*(pose.columns??pose.frameCount),manifest.height*Math.ceil(pose.frameCount/(pose.columns??pose.frameCount)));
    }
    assert.ok(total<=(character.id==='claude'?16:8)*1024*1024);
    const sources=json(path.join(base,'sources.json'));
    assert.equal(sources.commit,catalog.commit);
    for(const source of Object.values(sources.clips)) {
      assert.match(source.path,new RegExp(`^videos/${character.id}/[^/]+\\.webm$`));
      assert.match(source.sha256,/^[a-f0-9]{64}$/);
      assert.equal(source.decodedAlphaMin,0); assert.ok(source.decodedAlphaMax>0);
    }
    assert.ok(!fs.readdirSync(base).some(f=>/portrait/i.test(f)));
  }
  assert.ok(!fs.readdirSync(root).some(f=>/portrait/i.test(f)));
});

test('renderer rejects unapproved selections and cancels animation on hide, reduced motion and disposal', () => {
  const ts=require('typescript'), vm=require('node:vm');
  let source=fs.readFileSync(path.join(__dirname,'../src/ainiangPet.ts'),'utf8');
  source=source.replace(/import\.meta\.glob\([^\n]+?\) as Record<string, Manifest>/,'registry').replace(/import\.meta\.glob\([^\n]+?\) as Record<string, string>/,'imageRegistry');
  const registry={}, images={};
  for(const id of ids) {
    registry[`../assets/ainiang/${id}/manifest.json`]={poster:{path:'poster.png'},poses:Object.fromEntries(states.map(s=>[s,{file:{path:`${s}.png`},frameCount:16,frameDurationMs:250}]))};
    for(const state of ['poster',...states]) images[`../assets/ainiang/${id}/${state}.png`]=`/bundled/${id}/${state}.png`;
  }
  const timers=new Map(), documentEvents={}, motionEvents={}, windowEvents={}, pending=[]; let seq=0, now=1000;
  const motion={matches:false,addEventListener:(k,v)=>motionEvents[k]=v,removeEventListener:k=>delete motionEvents[k]};
  const document={hidden:false,addEventListener:(k,v)=>documentEvents[k]=v,removeEventListener:k=>delete documentEvents[k]};
  const window={matchMedia:()=>motion,setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id),addEventListener:(k,v)=>windowEvents[k]=v,removeEventListener:k=>delete windowEvents[k]};
  const context={exports:{},registry,imageRegistry:images,document,window,performance:{now:()=>now},Image:class {set src(v){this.url=v;pending.push(this);}}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  const api=context.exports, styles={}, classes=new Set();
  // Native-resolution rectangular atlas must keep the old square-padded geometry.
  registry['../assets/ainiang/claude/manifest.json'].width=640;
  registry['../assets/ainiang/claude/manifest.json'].height=360;
  for(const pose of Object.values(registry['../assets/ainiang/claude/manifest.json'].poses)) pose.columns=4;
  const gridStyles={};
  const grid=api.createAiniangRenderer({classList:{add(){},remove(){}}},(k,v)=>gridStyles[k]=v);
  grid.update({preferences:{appearance:'ainiang:claude'}}); pending.at(-1).onload();
  assert.equal(gridStyles.backgroundSize,'400% 225%');
  assert.equal(gridStyles.clipPath,'inset(21.875% 0%)');
  assert.equal(gridStyles.backgroundPosition,'0% -17.5%');
  for(const [elapsed,position] of [[750,'100% -17.5%'],[1000,'0% 27.5%'],[3750,'100% 117.5%'],[4000,'0% -17.5%']]) {
    now=1000+elapsed; const [id,fn]=timers.entries().next().value;timers.delete(id);fn();
    assert.equal(gridStyles.backgroundPosition,position);
  }
  motion.matches=true;motionEvents.change();assert.equal(gridStyles.clipPath,'');
  motion.matches=false;motionEvents.change();pending.at(-1).onload();
  grid.update({preferences:{appearance:'dragon'}});assert.equal(gridStyles.clipPath,'');
  const compact=registry['../assets/ainiang/claude/manifest.json'];
  compact.height=320;
  for(const pose of Object.values(compact.poses)){pose.frameCount=4;pose.columns=2;}
  grid.update({preferences:{appearance:'ainiang:claude'}});pending.at(-1).onload();
  assert.equal(gridStyles.backgroundSize,'200% 100%');
  assert.equal(gridStyles.backgroundPosition,'0% calc(var(--pet-pixels, 112px) * 0.25)');
  now+=500;{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}
  assert.equal(gridStyles.backgroundPosition,'0% calc(var(--pet-pixels, 112px) * -0.25)');
  grid.dispose();now=1000;pending.length=0;

  const cases=[
    [{error:'failed',phoneState:'speaking',busy:true,dictating:true},'error'],
    [{phoneError:'offline',petSpeech:{state:'speaking'}},'error'],
    [{petSpeech:{state:'speaking'},busy:true,dictating:true},'speaking'],
    [{remoteDialogue:{state:'speaking'}},'speaking'],
    [{busy:true,dictating:true},'thinking'],
    [{reply:{thinking:true}},'thinking'],
    [{phoneState:'tool'},'thinking'],
    [{dictating:true},'listening'],
    [{voice:{active:true,state:'listening'}},'listening'],
    [{voice:{active:true,state:'listening',muted:true}},'idle'],
    [{voice:{active:false,state:'speaking'}},'idle'],
    [{phoneState:'happy'},'idle'],[{phoneState:'sleeping'},'idle'],[{},'idle'],
  ];
  for(const [snapshot,expected] of cases) assert.equal(api.ainiangPose(snapshot),expected,JSON.stringify(snapshot));
  assert.match(api.ainiangAppearanceName('ainiang:claude'),/圣女果.*Claude.*实验外观/);
  for(const id of ['follow','dragon','persona:claude','ainiang:unknown']) assert.equal(api.ainiangAppearanceName(id),undefined);
  for(const [elapsed,expected] of [[-1,0],[0,0],[249,0],[250,1],[3999,15],[4000,0]]) assert.equal(api.ainiangFrame(elapsed,16,250),expected);
  window.__aichatPetHidden=true;
  const initiallyHidden=api.createAiniangRenderer({classList:{add(){},remove(){}}},()=>{});
  initiallyHidden.update({preferences:{appearance:'ainiang:gpt'}});
  assert.equal(pending.length,0); assert.equal(timers.size,0);
  initiallyHidden.dispose(); window.__aichatPetHidden=false;
  const renderer=api.createAiniangRenderer({classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}},(k,v)=>styles[k]=v);
  for(const invalid of ['follow','dragon','ainiang:unapproved','ainiang:../claude','ainiang:Claude','https://evil.test/']) assert.equal(renderer.update({preferences:{appearance:invalid}}),false);
  for(const id of ids) {
    assert.equal(renderer.update({preferences:{appearance:`ainiang:${id}`}}),true);
    pending.at(-1).onload(); assert.equal(timers.size,1); assert.match(styles.backgroundImage,new RegExp(`/bundled/${id}/idle.png`));
  }
  // Native resolution overrides the stored Keepwork fallback without mutating it.
  const fallback = { appearance: 'ainiang:kimi', appearanceMode: 'model' };
  assert.equal(renderer.update({ preferences: fallback, effectiveAppearance: 'ainiang:gpt' }), true);
  pending.at(-1).onload(); assert.match(styles.backgroundImage, /\/bundled\/gpt\/idle.png/);
  assert.equal(fallback.appearance, 'ainiang:kimi');
  assert.equal(renderer.update({ preferences: fallback, effectiveAppearance: 'dragon' }), false);
  assert.equal(renderer.hitShape(), null);
  assert.equal(renderer.update({ preferences: fallback, effectiveAppearance: fallback.appearance }), true);
  pending.at(-1).onload(); assert.match(styles.backgroundImage, /\/bundled\/kimi\/idle.png/);
  assert.equal(styles.backgroundPosition,'0% 0%');
  assert.equal(styles.backgroundSize,'1600% 100%');
  now+=3750; const [timerId,tick]=timers.entries().next().value; timers.delete(timerId); tick();
  assert.equal(styles.backgroundPosition,'100% 0%');
  windowEvents['aichat:pet-hidden'](); assert.equal(timers.size,0);
  renderer.update({preferences:{appearance:'ainiang:gpt'},busy:true}); assert.equal(timers.size,0);
  windowEvents['aichat:pet-shown'](); pending.at(-1).onload(); assert.equal(timers.size,1);
  document.hidden=true; documentEvents.visibilitychange(); assert.equal(timers.size,0);
  document.hidden=false; documentEvents.visibilitychange(); const stale=pending.at(-1);
  motion.matches=true; motionEvents.change(); stale.onload(); assert.equal(timers.size,0); assert.equal(styles.backgroundSize,'contain');
  motion.matches=false; motionEvents.change(); pending.at(-1).onload(); assert.equal(timers.size,1);
  renderer.dispose(); assert.equal(timers.size,0); assert.equal(Object.keys(documentEvents).length,0); assert.equal(Object.keys(motionEvents).length,0); assert.equal(Object.keys(windowEvents).length,0);
  assert.equal(renderer.update({preferences:{appearance:'ainiang:gpt'}}),false);
});

test('independent approval gate rejects corruption, changed identity, paths, links and expired evidence', () => {
  const {verifyAiniangAssets}=require('../scripts/check-ainiang-assets.cjs');
  assert.deepEqual(verifyAiniangAssets(root).characters,ids);
  assert.throws(()=>verifyAiniangAssets(root,{nowMs:Date.parse('2027-11-18T00:00:00Z')}));
  const os=require('node:os'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'ainiang-qa-'));
  function reject(mutate) {
    const copy=path.join(temp,'assets'); fs.cpSync(root,copy,{recursive:true});
    try {mutate(copy);assert.throws(()=>verifyAiniangAssets(copy));} finally {fs.rmSync(copy,{recursive:true,force:true});}
  }
  function modifyManifest(copy, change) { const p=path.join(copy,'claude/manifest.json'), m=json(p);change(m);fs.writeFileSync(p,JSON.stringify(m)); }
  try {
    reject(copy=>{const p=path.join(copy,'claude/idle.png'), b=fs.readFileSync(p);b[b.length-20]^=1;fs.writeFileSync(p,b);});
    reject(copy=>modifyManifest(copy,m=>m.characterId='unapproved'));
    reject(copy=>modifyManifest(copy,m=>m.poster.path='../gpt/poster.png'));
    reject(copy=>modifyManifest(copy,m=>m.poster.path='https://evil.test/a.png'));
    reject(copy=>modifyManifest(copy,m=>m.poses.idle.frameDurationMs=500));
    reject(copy=>{const p=path.join(copy,'claude/idle.png');fs.unlinkSync(p);fs.symlinkSync(path.join(root,'claude/idle.png'),p);});
    reject(copy=>{const p=path.join(copy,'claude');fs.rmSync(p,{recursive:true});fs.symlinkSync(path.join(root,'claude'),p);});
    reject(copy=>fs.mkdirSync(path.join(copy,'unapproved')));
    reject(copy=>fs.writeFileSync(path.join(copy,'claude/portrait.png'),Buffer.from('extra')));
    reject(copy=>{const p=path.join(copy,'catalog.json'), c=json(p);c.characters[0].id='unapproved';fs.writeFileSync(p,JSON.stringify(c));});
    reject(copy=>fs.appendFileSync(path.join(copy,'claude/sources.json'),' '));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test('AI Niang body mask follows decoded alpha and animation frames, with fail-closed loading', () => {
  const ts=require('typescript'), vm=require('node:vm');
  let source=fs.readFileSync(path.join(__dirname,'../src/ainiangPet.ts'),'utf8');
  source=source.replace(/import\.meta\.glob\([^\n]+?\) as Record<string, Manifest>/,'registry').replace(/import\.meta\.glob\([^\n]+?\) as Record<string, string>/,'imageRegistry');
  const manifest={width:8,height:4,poster:{path:'poster.png'},poses:Object.fromEntries(states.map(s=>[s,{file:{path:`${s}.png`},frameCount:4,frameDurationMs:250,columns:2}]))};
  const registry={'../assets/ainiang/claude/manifest.json':manifest};
  const images=Object.fromEntries(['poster',...states].map(s=>[`../assets/ainiang/claude/${s}.png`,`/fixture/${s}.png`]));
  const pending=[], timers=new Map(), motionEvents={}, windowEvents={}, documentEvents={};
  let timerId=0, now=0, changed=0;
  const motion={matches:false,addEventListener:(k,v)=>motionEvents[k]=v,removeEventListener:k=>delete motionEvents[k]};
  // Four rectangular frames. Frame 0 has an alpha hole and threshold-edge pixels;
  // frame 1 moves the body to the right so stale hit masks are observable.
  function alphaAt(frame,x,y){
    if(frame===2) return 0;
    if(frame===1) return x>=5 && x<=6 && y>=1 && y<=2 ? 255 : 0;
    if(x===2 && y===1) return 15;
    if(x===3 && y===1) return 0;
    if(x===4 && y===1) return 16;
    return x>=2 && x<=5 && y>=1 && y<=2 ? 255 : 0;
  }
  class Image {
    set src(value){this.url=value;this.width=this.naturalWidth=value.endsWith('/poster.png')?8:16;this.height=this.naturalHeight=value.endsWith('/poster.png')?4:8;pending.push(this);}
    alpha(x,y){const poster=this.url.endsWith('/poster.png');return alphaAt(poster?0:Math.floor(y/4)*2+Math.floor(x/8),x%8,y%4);}
  }
  const document={hidden:false,addEventListener:(k,v)=>documentEvents[k]=v,removeEventListener:k=>delete documentEvents[k],createElement(tag){
    assert.equal(tag,'canvas');
    const canvas={width:0,height:0}; let draw;
    canvas.getContext=()=>({
      clearRect(){draw=undefined;},
      drawImage(image,...args){
        if(args.length===2) draw={image,sx:0,sy:0,sw:image.naturalWidth,sh:image.naturalHeight,dx:args[0],dy:args[1],dw:image.naturalWidth,dh:image.naturalHeight};
        else if(args.length===4) draw={image,sx:0,sy:0,sw:image.naturalWidth,sh:image.naturalHeight,dx:args[0],dy:args[1],dw:args[2],dh:args[3]};
        else {assert.equal(args.length,8);const [sx,sy,sw,sh,dx,dy,dw,dh]=args;draw={image,sx,sy,sw,sh,dx,dy,dw,dh};}
      },
      getImageData(left,top,width,height){
        const data=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          if(!draw)continue;
          const px=left+x+.5,py=top+y+.5;
          if(px<draw.dx||py<draw.dy||px>=draw.dx+draw.dw||py>=draw.dy+draw.dh)continue;
          const sx=Math.floor(draw.sx+(px-draw.dx)/draw.dw*draw.sw),sy=Math.floor(draw.sy+(py-draw.dy)/draw.dh*draw.sh);
          data[(y*width+x)*4+3]=draw.image.alpha(sx,sy);
        }
        return {data,width,height};
      },
    });return canvas;
  }};
  const window={matchMedia:()=>motion,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),addEventListener:(k,v)=>windowEvents[k]=v,removeEventListener:k=>delete windowEvents[k]};
  const context={exports:{},registry,imageRegistry:images,document,window,performance:{now:()=>now},Image};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  const api=context.exports, styles={};
  const renderer=api.createAiniangRenderer({classList:{add(){},remove(){}}},(k,v)=>styles[k]=v,()=>changed++);
  renderer.update({preferences:{appearance:'ainiang:claude'}});
  assert.equal(typeof renderer.hitShape,'function','real appearance renderer must expose decoded hit geometry');
  assert.equal(renderer.hitShape(),null,'unloaded images must not make their transparent square interactive');
  while(pending.length) pending.shift().onload?.();
  const initial=renderer.hitShape();
  assert.ok(initial,'decoded body has a native hit shape');
  assert.ok(initial.mask.width<=256&&initial.mask.height<=256,'mask transport stays bounded');
  assert.match(initial.mask.bits,/^[a-f0-9]+$/i);
  const hit=(shape,x,y)=>api.maskContains(shape.mask,x,y);
  assert.equal(hit(initial,.1,.1),false,'outer transparent margin passes clicks through');
  assert.equal(hit(initial,2.5/8,3.5/8),false,'alpha below 16 does not capture clicks');
  assert.equal(hit(initial,3.5/8,3.5/8),false,'transparent interior hole passes clicks through');
  assert.equal(hit(initial,4.5/8,3.5/8),true,'alpha 16 is included');
  assert.equal(hit(initial,3.5/8,4.5/8),true,'opaque body remains interactive');
  assert.ok(initial.bounds.left>=.25 && initial.bounds.top>=.375,'badge anchor bounds exclude transparent frame margins');
  assert.ok(changed>0,'decoding schedules a new native geometry report');
  const stableCrop=JSON.parse(JSON.stringify(renderer.cropBounds()));
  assert.deepEqual(stableCrop,{left:.25,top:.375,width:.625,height:.25},'crop covers all decoded frames, including the later rightward movement');
  const before=changed;
  now=250; {const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}
  const moved=renderer.hitShape();
  assert.equal(hit(moved,3.5/8,4.5/8),false,'previous-frame-only pixels no longer capture clicks');
  assert.equal(hit(moved,6.5/8,4.5/8),true,'new frame body captures clicks');
  assert.ok(changed>before,'frame changes notify native geometry');
  assert.deepEqual(JSON.parse(JSON.stringify(renderer.cropBounds())),stableCrop,'animation frame change keeps native crop stable');
  now=500; {const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}
  assert.equal(renderer.hitShape(),null,'fully transparent animation frames capture no clicks');
  assert.deepEqual(JSON.parse(JSON.stringify(renderer.cropBounds())),stableCrop,'an empty frame does not collapse the native window');
  motion.matches=true;motionEvents.change();while(pending.length)pending.shift().onload?.();
  assert.equal(hit(renderer.hitShape(),3.5/8,4.5/8),true,'reduced motion uses poster hit geometry');
  const anchor=renderer.bodyBounds();
  renderer.update({preferences:{appearance:'ainiang:claude'},busy:true});
  assert.equal(renderer.hitShape(),null,'new pose waits for its decoded geometry');
  assert.deepEqual(renderer.bodyBounds(),anchor,'badge and composer anchor must not jump while the next pose loads');
  while(pending.length)pending.shift().onload?.();
  renderer.update({preferences:{appearance:'dragon'}});
  assert.equal(renderer.bodyBounds(),undefined,'switching away clears the experiment layout anchor');
  assert.equal(renderer.cropBounds(),undefined,'switching appearances retires the prior pose crop');
  assert.equal(renderer.hitShape(),null,'leaving experiment clears the old character mask');
  renderer.dispose();
  motion.matches=false;
  const staleRenderer=api.createAiniangRenderer({classList:{add(){},remove(){}}},()=>{},()=>{});
  staleRenderer.update({preferences:{appearance:'ainiang:claude'}});
  staleRenderer.update({preferences:{appearance:'dragon'}});
  while(pending.length)pending.shift().onload?.();
  assert.equal(staleRenderer.hitShape(),null,'late image completion cannot restore a previous character mask');
  staleRenderer.dispose();
  document.createElement=()=>{throw new Error('canvas decode unavailable');};
  const failed=api.createAiniangRenderer({classList:{add(){},remove(){}}},()=>{},()=>{});
  failed.update({preferences:{appearance:'ainiang:claude'}});
  while(pending.length)pending.shift().onload?.();
  assert.equal(failed.hitShape(),null,'decode failure must not fall back to the transparent square');
  failed.dispose();
});
