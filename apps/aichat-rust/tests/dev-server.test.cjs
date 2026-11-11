const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { IDENTITY_PATH, IDENTITY_PROTOCOL, probeDevServer, ensureDevServer } = require('../scripts/dev-server.cjs');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-vite-project-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>isolated Vite reuse fixture</title>');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server); await close(server); return port;
}

test('a fresh real Vite server is loopback-only and repeated startup reuses it without taking ownership', async t => {
  const projectRoot = project(t), port = await unusedPort();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'absent');
  const first = await ensureDevServer({ projectRoot, port }); t.after(() => first.close());
  assert.equal(first.reused, false);
  assert.equal(first.url, `http://127.0.0.1:${port}`);
  const identity = await (await fetch(first.url + IDENTITY_PATH)).json();
  assert.equal(identity.protocol, IDENTITY_PROTOCOL);
  assert.equal(identity.projectRoot, fs.realpathSync(projectRoot));
  assert.match(await (await fetch(first.url + '/')).text(), /isolated Vite reuse fixture/);
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'same');
  const second = await ensureDevServer({ projectRoot, port });
  assert.equal(second.reused, true);
  await second.close();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'same', 'a reused handle must not close the pre-existing server');
  await first.close();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'absent');
});

test('directory aliases identify the same project and a different checkout is rejected without stopping Vite', async t => {
  const projectRoot = project(t), otherRoot = project(t), port = await unusedPort();
  const alias = path.join(otherRoot, 'project-link');
  fs.symlinkSync(projectRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = await ensureDevServer({ projectRoot, port }); t.after(() => owner.close());
  const reused = await ensureDevServer({ projectRoot: alias, port });
  assert.equal(reused.reused, true); await reused.close();
  await assert.rejects(ensureDevServer({ projectRoot: otherRoot, port }), /port|1430|占用|project|checkout/i);
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'same');
});

for (const [name, respond] of [
  ['ordinary HTML server', (_req, res) => { res.end('<!doctype html><title>another service</title>'); }],
  ['old identity protocol', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol: 'obsolete-v0', projectRoot: '/' })); }],
  ['oversized identity', (_req, res) => { res.end('x'.repeat(5000)); }],
]) test(`${name} is classified as occupied and is never stopped`, async t => {
  const projectRoot = project(t), server = http.createServer(respond);
  const port = await listen(server); t.after(() => close(server));
  assert.equal((await probeDevServer({ projectRoot, port, timeoutMs: 500 })).state, 'occupied');
  await assert.rejects(ensureDevServer({ projectRoot, port, timeoutMs: 500 }), /port|占用|service|服务/i);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('identity probes do not follow redirects to a different service', async t => {
  const projectRoot = project(t); let redirectedRequests = 0;
  const target = http.createServer((_req, res) => { redirectedRequests++; res.end(JSON.stringify({ protocol: IDENTITY_PROTOCOL, projectRoot })); });
  const targetPort = await listen(target); t.after(() => close(target));
  const server = http.createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}${IDENTITY_PATH}` }); res.end(); });
  const port = await listen(server); t.after(() => close(server));
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'occupied');
  assert.equal(redirectedRequests, 0);
});

test('an occupied unresponsive server fails within the probe timeout and remains alive', async t => {
  const projectRoot = project(t), server = http.createServer(() => {});
  const port = await listen(server); t.after(() => close(server));
  const started = Date.now();
  assert.equal((await probeDevServer({ projectRoot, port, timeoutMs: 100 })).state, 'occupied');
  assert.ok(Date.now() - started < 2000);
  assert.equal(server.listening, true);
});

test('two concurrent real Vite starts converge on one owner after both observe a free port', async t => {
  const projectRoot = project(t), port = await unusedPort();
  const { createServer } = await import('vite');
  let waiting = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const startTogether = async options => { if (++waiting === 2) release(); await barrier; return createServer(options); };
  const outcomes = await Promise.all([
    ensureDevServer({ projectRoot, port, createServer: startTogether }),
    ensureDevServer({ projectRoot, port, createServer: startTogether }),
  ]);
  for (const outcome of outcomes) t.after(() => outcome.close());
  assert.equal(outcomes.filter(result => !result.reused).length, 1);
  assert.equal(outcomes.filter(result => result.reused).length, 1);
  await outcomes.find(result => result.reused).close();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'same');
  await outcomes.find(result => !result.reused).close();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'absent');
});


function requestIdentity(port, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: IDENTITY_PATH, method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('real Vite binds loopback and its identity rejects remote Host, Origin and write methods', async t => {
  const projectRoot = project(t), port = await unusedPort();
  const { createServer } = await import('vite');
  let vite;
  const owner = await ensureDevServer({ projectRoot, port, createServer: async options => { vite = await createServer(options); return vite; } });
  t.after(() => owner.close());
  assert.equal(vite.httpServer.address().address, '127.0.0.1');
  assert.equal(vite.httpServer.address().port, port);
  for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }, { Origin: `http://127.0.0.1:${port + 1}` }]) {
    const response = await requestIdentity(port, headers);
    assert.equal(response.status, 403);
    assert.ok(!response.body.includes(projectRoot));
  }
  assert.equal((await requestIdentity(port, {}, 'POST')).status, 405);
  const valid = await requestIdentity(port, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(valid.body).projectRoot, projectRoot);
});

test('a foreign process winning a bind race is not reused or stopped', async t => {
  const projectRoot = project(t), port = await unusedPort();
  const foreign = http.createServer((_req, res) => res.end('foreign service'));
  let closes = 0;
  await assert.rejects(ensureDevServer({ projectRoot, port, createServer: async () => ({
    async listen() {
      await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(port, '127.0.0.1', resolve); });
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
    async close() { closes++; },
  }) }), /occupied by another service/);
  t.after(() => close(foreign));
  assert.equal(closes, 1, 'only the failed instance must be closed');
  assert.equal(foreign.listening, true);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign service');
});

test('a non-port startup failure cleans up its own server and preserves the original cause', async t => {
  const projectRoot = project(t), port = await unusedPort();
  const failure = new Error('invalid TLS development configuration'); let closes = 0;
  await assert.rejects(ensureDevServer({ projectRoot, port, createServer: async () => ({
    async listen() { throw failure; }, async close() { closes++; },
  }) }), error => error === failure);
  assert.equal(closes, 1);
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'absent');
});


test('the real desktop Vite config loads and supports reuse on an isolated loopback port', async t => {
  const projectRoot = path.resolve(__dirname, '..'), port = await unusedPort();
  const cacheDir = path.join(project(t), 'vite-cache');
  const { createServer } = await import('vite');
  const owner = await ensureDevServer({ projectRoot, port, createServer: options => createServer({
    ...options, cacheDir, optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  }) }); t.after(() => owner.close());
  assert.equal(owner.reused, false);
  const identity = await (await fetch(owner.url + IDENTITY_PATH)).json();
  assert.equal(identity.projectRoot, fs.realpathSync(projectRoot));
  assert.equal((await fetch(owner.url + '/')).status, 200);
  const reused = await ensureDevServer({ projectRoot, port });
  assert.equal(reused.reused, true);
  await reused.close();
  assert.equal((await probeDevServer({ projectRoot, port })).state, 'same');
});
