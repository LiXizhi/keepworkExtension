/** A fixed loopback Vite server shared only by launches of the same checkout. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = 1430;
const IDENTITY_PATH = '/.keepwork/aichat-rust-dev.json';
const IDENTITY_PROTOCOL = 'keepwork-aichat-rust-dev-v1';
// Cold Winsock connections and a busy Vite process can exceed one second on
// Windows. A timeout still means unknown ownership, never an absent server.
const DEFAULT_PROBE_TIMEOUT_MS = process.platform === 'win32' ? 5000 : 1000;
const appRoot = path.resolve(__dirname, '..');
const identityInstalled = Symbol.for('keepwork.aichat-rust.dev-identity');

function devIdentityPlugin(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  return {
    name: 'keepwork-dev-identity',
    configureServer(server) {
      if (server[identityInstalled]) return;
      server[identityInstalled] = true;
      server.middlewares.use((req, res, next) => {
        if (String(req.url || '').split('?')[0] !== IDENTITY_PATH) return next();
        const port = server.config.server.port;
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!allowedHosts.includes(req.headers.host) || (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin))) {
          res.statusCode = 403; res.end('Forbidden'); return;
        }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ protocol: IDENTITY_PROTOCOL, projectRoot: root }));
      });
    },
  };
}

function probeDevServer({ projectRoot = appRoot, port = PORT, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const root = fs.realpathSync(projectRoot);
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    // Never follow redirects or probe a caller-provided host.
    const request = http.get({ hostname: HOST, port, path: IDENTITY_PATH, agent: false }, response => {
      if (response.statusCode !== 200) { finish({ state: 'occupied', reason: `HTTP ${response.statusCode}` }); response.destroy(); return; }
      let body = '', bytes = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) { finish({ state: 'occupied', reason: 'Identity response too large' }); response.destroy(); return; }
        body += chunk;
      });
      response.on('end', () => {
        try {
          const identity = JSON.parse(body);
          finish(identity.protocol === IDENTITY_PROTOCOL && identity.projectRoot === root
            ? { state: 'same' } : { state: 'occupied', reason: 'Unrecognized server or different checkout' });
        } catch { finish({ state: 'occupied', reason: 'Invalid identity response' }); }
      });
      response.on('error', () => finish({ state: 'occupied', reason: 'Identity response interrupted' }));
    });
    const timer = setTimeout(() => { finish({ state: 'occupied', reason: 'Identity probe timed out' }); request.destroy(); }, timeoutMs);
    request.on('error', error => finish(error.code === 'ECONNREFUSED' ? { state: 'absent' } : { state: 'occupied', reason: error.code || 'Connection failed' }));
  });
}

function occupiedError(port, reason) {
  return new Error(`Port ${port} is occupied by another service or its identity could not be verified (${reason || 'unknown'}). Check the terminal running that service, or stop that service and retry. No process was stopped and no alternate port was selected.`);
}

async function ensureDevServer({ projectRoot = appRoot, port = PORT, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, createServer } = {}) {
  const root = fs.realpathSync(projectRoot);
  const url = `http://${HOST}:${port}`;
  const attached = () => ({ reused: true, url, close: async () => {} });
  const probe = await probeDevServer({ projectRoot: root, port, timeoutMs });
  if (probe.state === 'same') return attached();
  if (probe.state !== 'absent') throw occupiedError(port, probe.reason);
  const create = createServer || (await import('vite')).createServer;
  const server = await create({ root, server: { host: HOST, port, strictPort: true }, plugins: [devIdentityPlugin(root)] });
  try {
    await server.listen();
  } catch (error) {
    // Another launch may win the bind after the first probe. Close only our
    // unbound Vite instance, then verify the winner before reusing it.
    await server.close();
    const winner = await probeDevServer({ projectRoot: root, port, timeoutMs });
    if (winner.state === 'same') return attached();
    if (winner.state === 'occupied') throw occupiedError(port, winner.reason);
    throw error;
  }
  let closed = false;
  return { reused: false, url, close: async () => { if (!closed) { closed = true; await server.close(); } } };
}

async function main() {
  const server = await ensureDevServer();
  process.stdout.write(`[aichat-rust] ${server.reused ? 'Reusing the running development server / 复用已运行的开发服务器' : 'Development server ready'}: ${server.url}\n`);
  // Keep the Tauri before-dev command alive; its shutdown must never terminate
  // a server owned by an earlier terminal.
  const keepAlive = setInterval(() => {}, 60000);
  const stop = () => { clearInterval(keepAlive); void server.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { process.stderr.write(`[aichat-rust] ${error.message}\n`); process.exitCode = 1; });
module.exports = { IDENTITY_PATH, IDENTITY_PROTOCOL, devIdentityPlugin, probeDevServer, ensureDevServer };
