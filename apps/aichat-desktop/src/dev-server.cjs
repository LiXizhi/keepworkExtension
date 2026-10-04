const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
async function startDevelopmentServer(sourceDirectory, firstPort = 3001) {
  const source = fs.realpathSync(sourceDirectory);
  if (!fs.existsSync(path.join(source, 'AIChat.html'))) throw new Error('AICHAT_SOURCE_DIR must contain AIChat.html');
  const repository = path.resolve(source, '../../../..');
  const root = fs.existsSync(path.join(repository, 'official/apps/tools/AIChat/AIChat.html')) ? repository : source;
  const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.wasm':'application/wasm' };
  const server = http.createServer((req, res) => {
    try {
      if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
      if (relative.split(/[\\/]/).some(p => p.startsWith('.'))) throw Error('Hidden path');
      const target = fs.realpathSync(path.resolve(root, relative));
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(target).isFile()) throw Error('Outside source');
      res.writeHead(200, { 'Content-Type':mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store' });
      if(req.method === 'HEAD') res.end(); else fs.createReadStream(target).on('error',()=>res.destroy()).pipe(res);
    } catch { res.writeHead(404).end('Not found'); }
  });
  for(let port = firstPort; port < firstPort + 100; port++) {
    try {
      await new Promise((resolve,reject)=>{ const ready=()=>{server.removeListener('error',fail);resolve();};const fail=e=>{server.removeListener('listening',ready);reject(e);};server.once('error',fail);server.once('listening',ready);server.listen(port,'127.0.0.1'); });
      const entry = path.relative(root,path.join(source,'AIChat.html')).split(path.sep).map(encodeURIComponent).join('/');
      return { url:`http://127.0.0.1:${server.address().port}/${entry}`, close:()=>server.close() };
    } catch(e) { if(e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('No free localhost development port');
}
module.exports = { startDevelopmentServer };
