const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);

test('macOS iframe navigation stays embedded while main-frame policy and lifecycle delegate remain active', {
  skip: process.platform !== 'darwin',
  timeout: 90000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-navigation-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    requests.push(pathname);
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/redirect') {
      response.writeHead(302, { Location: '/embedded' });
      return response.end();
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (pathname === '/main') return response.end(`<!doctype html><title>Main fixture</title>
      <script>
        window.embeddedReady = false;
        addEventListener('message', event => {
          if (event.source === document.querySelector('iframe').contentWindow && event.data === 'embedded-ready') {
            window.embeddedReady = true;
          }
        });
      </script>
      <iframe src="http://localhost:${server.address().port}/redirect"></iframe>`);
    if (pathname === '/embedded') return response.end(`<!doctype html><title>Embedded fixture</title>
      <h1>Embedded page rendered</h1><script>parent.postMessage('embedded-ready', '*');</script>`);
    response.statusCode = 404;
    response.end('Unexpected navigation');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const executable = path.join(temporary, 'navigation-macos');
    const compiled = await execute('clang', [
      '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'WebKit',
      path.resolve(__dirname, '../src-tauri/src/navigation_macos.m'),
      path.join(__dirname, 'fixtures/navigation_macos.m'),
      '-o', executable,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(compiled.stderr, '', 'native fixture should compile without warnings');
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function runFixture(args) {
      try {
        return await execute(executable, args, { timeout: 45000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        assert.fail(`Native navigation fixture failed (exit=${error.code}, signal=${error.signal}):\n${error.stdout}\n${error.stderr}\nRequests: ${JSON.stringify(requests)}`);
      }
    }
    const baseline = await runFixture([origin, '--without-adapter']);
    assert.match(baseline.stdout, /legacy iframe rejection reproduced/);
    assert.equal(requests.includes('/redirect'), false, 'the old delegate cancels the iframe before it can load');
    requests.length = 0;
    const result = await runFixture([origin]);
    assert.match(result.stdout, /macOS frame navigation tests passed/);
    assert.ok(requests.includes('/main'), 'WKWebView loaded the actual main document');
    assert.ok(requests.includes('/redirect'), 'cross-origin iframe reached the local server');
    assert.ok(requests.includes('/embedded'), 'iframe followed the redirect inside WKWebView');
    assert.equal(requests.includes('/top-blocked'), false, 'the previous delegate still blocks external top-level loads');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
