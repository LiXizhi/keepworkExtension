const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const assetPrefix = '/__keepwork_desktop__/';

async function checkLauncher(executable, signal) {
  const { stdout } = await execute(executable, ['--check'], { signal, windowsHide: true, timeout: 35 * 60_000 });
  const result = JSON.parse(stdout);
  if (result.busy === true) return result;
  if (typeof result.version !== 'string' || typeof result.pending !== 'boolean') throw Error('Invalid launcher response');
  return result;
}

// Serve only the packaged page and its private asset prefix on the original
// Keepwork origin. Cookies, IndexedDB and the trusted main-frame URL survive migration.
function installAppPage(session, net, root) {
  const page = fs.readFileSync(path.join(root, 'AIChat.html'), 'utf8')
    .replace('<head>', '<head><base href="' + assetPrefix + '">');
  const libs = path.resolve(root, '../web-libs');
  const scripts = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(libs, 'assets.json'), 'utf8'))));
  let online = false;
  session.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (!online && request.method === 'GET' && scripts.has(url.href)) {
      return new Response(fs.readFileSync(path.join(libs, scripts.get(url.href))), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (!online && request.method === 'GET' && url.origin === 'https://keepwork.com') {
      if (url.pathname === '/chat') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname.startsWith(assetPrefix)) {
        try {
          const rel = decodeURIComponent(url.pathname.slice(assetPrefix.length));
          if (rel.split(/[\\/]/).some(p => !p || p.startsWith('.') || p.includes(':'))) throw Error('Invalid path');
          const file = fs.realpathSync(path.join(root, rel));
          if (!file.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(file).isFile()) throw Error('Invalid file');
          return net.fetch(pathToFileURL(file).href);
        } catch { return new Response(null, { status: 404 }); }
      }
    }
    return session.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  return () => { online = true; };
}
module.exports = { checkLauncher, installAppPage };
