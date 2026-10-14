const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-smoke-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const node = process.platform === 'win32' ? path.join(root, 'node.exe') : path.join(root, 'bin/node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, node);
  else fs.symlinkSync(process.execPath, node);
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/cli.cjs'), `
    const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    let closed = false, deletedAfterExit = false;
    const server = http.createServer((req, res) => {
      const send = (body, status = 200) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
      if (req.url === '/health') return send({name:'keepwork-mcp',hostKind:'standalone'});
      if (req.url === '/terminal/sessions') return send({id:'shell'});
      if (req.url.endsWith('/input')) {
        if (process.env.SMOKE_REJECT_EXIT) return send({error:'exit rejected'}, 500);
        let data = ''; req.on('data', chunk => data += chunk);
        req.on('end', () => {
          if (JSON.parse(data).data !== 'exit\\r') return send({error:'wrong input'}, 400);
          setTimeout(() => { closed = true; }, 150); send({ok:true});
        }); return;
      }
      if (req.url.endsWith('/output')) return send({closed});
      if (req.method === 'DELETE') { deletedAfterExit = closed; return send({ok:true}); }
      if (req.url === '/admin/stop') {
        send({ok:true});
        setTimeout(() => {
          fs.writeFileSync(path.join(__dirname, '../shutdown.json'), JSON.stringify({closed,deletedAfterExit}));
          server.close(() => process.exit(0)); server.closeAllConnections();
        }, 150); return;
      }
      send({}, 404);
    }); server.listen(port, '127.0.0.1');
  `);
  return root;
}

test('smoke waits for PTY exit and graceful daemon shutdown before reporting success', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'smoke-runtime.cjs'), root], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'shutdown.json'))), { closed: true, deletedAfterExit: true });
  assert.match(result.stdout, /runtime smoke test passed/);
});

test('smoke fails when PTY exit is rejected instead of publishing a false pass', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'smoke-runtime.cjs'), root], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, SMOKE_REJECT_EXIT: '1' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PTY exit request failed: 500/);
  assert.doesNotMatch(result.stdout, /runtime smoke test passed/);
});
