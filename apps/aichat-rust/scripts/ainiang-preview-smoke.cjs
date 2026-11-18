// Local visual inspection harness. Serves only approved bundle files, no accounts.
const fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const root=path.resolve(__dirname,'../assets/ainiang');
require('./check-ainiang-assets.cjs').verifyAiniangAssets(root);
const catalog=JSON.parse(fs.readFileSync(path.join(root,'catalog.json')));
const allowed=new Map();
let cards='';
for(const c of catalog.characters){
 const m=JSON.parse(fs.readFileSync(path.join(root,c.manifest)));
 cards+=`<h2>${c.name}</h2><section>`;
 for(const [state,p] of Object.entries(m.poses)){
  const url=`/${c.id}/${p.file.path}`;allowed.set(url,path.join(root,c.id,p.file.path));
  const columns=p.columns??p.frameCount,rows=Math.ceil(p.frameCount/columns),fw=Math.min(1,m.width/m.height),fh=Math.min(1,m.height/m.width);
  cards+=`<figure><div class="sprite" style="background-image:url('${url}');background-size:${columns*fw*100}% ${rows*fh*100}%;clip-path:inset(${(1-fh)*50}% ${(1-fw)*50}%)" data-columns="${columns}" data-fw="${fw}" data-fh="${fh}" data-count="${p.frameCount}" data-duration="${p.frameDurationMs}"></div><figcaption>${state}</figcaption></figure>`;
 }cards+='</section>';
}
const html=`<!doctype html><meta charset="utf-8"><title>AI Niang local experiment preview</title><style>body{font:14px system-ui;background:#e8e8eb;color:#222;margin:20px}section{display:flex;gap:8px}figure{margin:0;text-align:center}.sprite{--pet-pixels:110px;width:110px;height:110px;background-repeat:no-repeat;background-color:#fff}h2{margin:12px 0 4px}#status{position:sticky;top:0;background:white;padding:8px}</style><h1>AI Niang — appearance-only experiment</h1><p>User-attested video scope; all upstream portraits excluded. Prerecorded animation, no lip sync or official persona.</p><div id="status">Loading</div>${cards}<script>const sprites=[...document.querySelectorAll('.sprite')];let loaded=0,failed=0;for(const el of sprites){const i=new Image;i.onload=()=>{loaded++;statusText()};i.onerror=()=>{failed++;statusText()};i.src=el.style.backgroundImage.slice(5,-2)}function statusText(){document.getElementById('status').textContent=loaded+'/'+sprites.length+' pose images decoded; failures='+failed}const motion=matchMedia('(prefers-reduced-motion: reduce)');let timer;function tick(){clearTimeout(timer);const paused=document.hidden||motion.matches;for(const el of sprites){const n=+el.dataset.count,f=paused?0:Math.floor(performance.now()/+el.dataset.duration)%n;const cols=+el.dataset.columns,rows=Math.ceil(n/cols),fw=+el.dataset.fw,fh=+el.dataset.fh;const pos=(i,c,s)=>{const span=1-c*s,offset=(1-s)/2-i*s;return span===0&&offset!==0?'calc(var(--pet-pixels) * '+offset+')':(span===0?0:offset/span*100)+'%'};el.style.backgroundPosition=pos(f%cols,cols,fw)+' '+pos(Math.floor(f/cols),rows,fh)}if(!paused)timer=setTimeout(tick,250)}document.addEventListener('visibilitychange',tick);motion.addEventListener('change',tick);tick()</script>`;
const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else if(allowed.has(req.url)){res.setHeader('Content-Type','image/png');fs.createReadStream(allowed.get(req.url)).pipe(res);}else{res.statusCode=404;res.end();}});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
