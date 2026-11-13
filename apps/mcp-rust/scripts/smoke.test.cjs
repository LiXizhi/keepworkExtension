const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { runSmoke } = require('./smoke.cjs');

const identity = { product: 'keepwork-mcp-runtime', engine: 'rust', version: '9.9.9-fixture', commit: 'f'.repeat(40) };

function fixture(t, mode = 'normal') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-smoke-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'daemon.cjs');
  const journal = path.join(directory, 'journal.jsonl');
  fs.writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
    const args = process.argv.slice(2);
    const port = Number(args[args.indexOf('--port') + 1]);
    const root = args[args.indexOf('--root') + 1];
    const mode = process.env.KP_SMOKE_FIXTURE_MODE;
    const auth = process.env.KEEPWORK_MCP_REQUIRE_AUTH === '1';
    const token = 'isolated-smoke-token-' + process.pid;
    const record = row => fs.appendFileSync(process.env.KP_SMOKE_FIXTURE_JOURNAL, JSON.stringify(row) + '\\n');
    record({kind:'start',pid:process.pid,profile:process.env.HOME,override:!!process.env.KEEPWORK_MCP_RUNTIME_VERSION});
    process.on('exit', () => record({kind:'exit',pid:process.pid,profilePresent:fs.existsSync(process.env.HOME)}));
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
    if (mode === 'early-exit') process.exit(3);
    if (auth) { fs.mkdirSync(path.join(process.env.HOME,'.keepwork-mcp'),{recursive:true}); fs.writeFileSync(path.join(process.env.HOME,'.keepwork-mcp/token'),token); }
    let posts = 0;
    const server = http.createServer(async (req,res) => {
      record({kind:'request',method:req.method,url:req.url,authorized:req.headers.authorization === 'Bearer ' + token});
      if (req.url === '/health') {
        if (mode === 'hang-headers') return;
        if (mode === 'hang-body') { res.writeHead(200,{'content-type':'application/json'}); res.write('{"ok":'); return; }
        if (mode === 'large-body') { res.end('x'.repeat(2*1024*1024)); return; }
        res.setHeader('content-type','application/json');
        return res.end(JSON.stringify({ok:true,name:'keepwork-mcp',runtimeProduct:mode==='wrong-product'?'unrelated':'keepwork-mcp-runtime',runtimeEngine:mode==='wrong-engine'?'node':'rust',hostKind:'standalone',workspaceRoot:mode==='wrong-profile'?path.dirname(root):root,pid:mode==='replace-before-stop' && posts>=3 ? process.pid+1000 : process.pid,runtimeVersion:mode==='wrong-version'?'wrong':'9.9.9-fixture',runtimeCommit:mode==='wrong-commit'?'e'.repeat(40):'${identity.commit}',requireAuth:auth}));
      }
      if (auth && req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{}'); }
      if (req.url === '/admin/stop') {
        if(mode !== 'ignore-stop') res.once('finish', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
        res.end('{"ok":true}'); return;
      }
      if (req.url === '/mcp') {
        posts++;
        let body=''; for await(const chunk of req) body+=chunk;
        const message=JSON.parse(body); res.setHeader('content-type','application/json');
        if(message.method==='initialize'){res.setHeader('mcp-session-id','isolated-session');return res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{}}));}
        const result=message.method==='tools/list'?{tools:[{name:'mcp_status'}]}:{content:[{type:'text',text:'keepwork-mcp 0.1.2 fixture'}]};
        return res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
      }
      res.writeHead(404); res.end('{}');
    });
    server.once('error', error => { console.error(error.code); process.exit(2); });
    server.listen(port,'127.0.0.1');
  `);
  return {
    directory, journal,
    options: { binary: process.execPath, args: [script], expectedBuildInfo: identity, startupTimeoutMs: 2000, requestTimeoutMs: 200, shutdownTimeoutMs: 300, env: { KP_SMOKE_FIXTURE_MODE: mode, KP_SMOKE_FIXTURE_JOURNAL: journal, KEEPWORK_MCP_REQUIRE_AUTH: '0' } },
    rows: () => fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
  };
}

function assertReaped(f) {
  const rows = f.rows();
  const start = rows.find(row => row.kind === 'start');
  assert.ok(start, 'our fixture process started');
  const exit = rows.find(row => row.kind === 'exit');
  // Windows TerminateProcess does not execute JS exit hooks. Its Child exit and
  // close events still have to complete before the profile can be removed.
  if (exit) assert.equal(exit.profilePresent, true, 'profile existed until child exit');
  else assert.equal(process.platform, 'win32', 'POSIX fixture exit hook ran');
  assert.equal(fs.existsSync(start.profile), false, 'profile removed only after child reaped');
  assert.throws(() => process.kill(start.pid, 0), /ESRCH/);
}

for (const requireAuth of ['0', '1']) test('owned smoke validates every POST and cleans up (requireAuth=' + requireAuth + ')', async t => {
  const f = fixture(t);
  f.options.env.KEEPWORK_MCP_REQUIRE_AUTH = requireAuth;
  f.options.env.KEEPWORK_MCP_RUNTIME_VERSION = 'must-not-spoof-identity';
  const result = await runSmoke(f.options);
  assert.equal(result.health.runtimeVersion, identity.version);
  assert.equal(result.health.requireAuth, requireAuth === '1');
  assert.notEqual(result.port, 8089);
  const rows = f.rows();
  assert.equal(rows.find(row => row.kind === 'start').override, false);
  const requests = rows.filter(row => row.kind === 'request');
  for (let index = 0; index < requests.length; index++) if (requests[index].method === 'POST') {
    assert.equal(requests[index - 1].url, '/health', 'ownership was rechecked immediately before POST');
    assert.equal(requests[index].authorized, requireAuth === '1');
  }
  assert.equal(requests.filter(row => row.url === '/admin/stop').length, 1);
  assertReaped(f);
});

test('smoke uses the native canonical workspace, including Windows short-name temp roots', async t => {
  const f = fixture(t);
  const canonicalTemp = fs.realpathSync.native(os.tmpdir());
  const result = await runSmoke(f.options);
  const root = result.health.workspaceRoot;
  assert.equal(path.dirname(path.dirname(root)).toLowerCase(), canonicalTemp.toLowerCase());
  assertReaped(f);
});

test('an occupied port is never stopped, even when it advertises the expected Rust identity', async t => {
  const f = fixture(t);
  let stopped = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/admin/stop') stopped++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'keepwork-mcp', runtimeProduct: identity.product, runtimeEngine: 'rust', hostKind: 'standalone', pid: process.pid, runtimeVersion: identity.version, runtimeCommit: identity.commit }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let failure;
  await assert.rejects(runSmoke({ ...f.options, port: server.address().port }), error => {
    failure = error;
    assert.match(error.message, /ownership|exited/);
    return true;
  });
  assert.equal(stopped, 0);
  assert.equal(server.listening, true, 'foreign fixture remains alive');
  assert.equal(fs.existsSync(failure.profile), false);
  assert.throws(() => process.kill(failure.childPid, 0), /ESRCH/);
});

for (const mode of ['replace-before-stop', 'wrong-version', 'wrong-commit', 'wrong-engine', 'wrong-product', 'wrong-profile']) test('ownership and build identity are revalidated: ' + mode, async t => {
  const f = fixture(t, mode);
  await assert.rejects(runSmoke(f.options), /ownership or identity mismatch/);
  assert.equal(f.rows().filter(row => row.kind === 'request' && row.url === '/admin/stop').length, 0);
  assertReaped(f);
});

for (const mode of ['hang-headers', 'hang-body', 'large-body', 'early-exit', 'ignore-stop']) test('a failed daemon is bounded and reaped: ' + mode, async t => {
  const f = fixture(t, mode);
  const started = Date.now();
  await assert.rejects(runSmoke({ ...f.options, startupTimeoutMs: 450, requestTimeoutMs: 100 }), /timed out|exceeded|exited|exit cleanly/);
  assert.ok(Date.now() - started < 2500, 'failure and cleanup stay bounded');
  assertReaped(f);
});

test('spawn failures are handled without unhandled errors or retained profiles', async t => {
  const f = fixture(t);
  let failure;
  try { await runSmoke({ ...f.options, binary: f.directory, args: [] }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(failure.message, /EACCES|EPERM|ENOENT|spawn/);
  assert.equal(fs.existsSync(failure.profile), false);
});
