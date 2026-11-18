const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

test('Windows native browser isolates external sites and preserves surface lifecycle', {
  skip: process.platform !== 'win32', timeout: 240000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-windows-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    requests.push(pathname);
    if (pathname === '/failure') return request.socket.destroy();
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/download') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename="${path.basename(temporary)}.bin"`);
      return response.end('isolated download fixture');
    }
    if (pathname === '/main') {
      response.setHeader('Set-Cookie', 'owner-secret=yes; Path=/; SameSite=Lax');
      return response.end(`<!doctype html><title>Owner fixture</title><script>
        localStorage.setItem('owner-secret','private');window.aichatDesktop={secret:'owner-only'};
        window.__TAURI_INTERNALS__={secret:'owner-only'};window.events=[];
        addEventListener('__aichat_desktop_event__',e=>{if(e.detail.event==='browser-surface')events.push(e.detail.payload);});
      </script><h1>Main application</h1>`);
    }
    if (pathname === '/deny') response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.end(`<!doctype html><title>Native fixture ${pathname}</title><body style="background:#93d4ab">
      <h1>Native restricted site</h1><a id="next" target="_blank" href="/second">Next page</a></body>`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const args = ['run', '--locked', '--manifest-path', path.resolve(__dirname, '../src-tauri/Cargo.toml'),
      '--features', 'dev-bins', '--bin', 'browser-surface-smoke', '--',
      `http://127.0.0.1:${server.address().port}`, temporary];
    try {
      const result = await execute('cargo', args, { timeout: 220000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /native Windows browser surface tests passed/);
      process.stdout.write(result.stdout);
    } catch (error) {
      assert.fail(`${error.message}\n${error.stdout || ''}\n${error.stderr || ''}\nRequests: ${JSON.stringify(requests)}`);
    }
    assert.ok(requests.includes('/main'));
    assert.ok(requests.includes('/deny'));
    assert.ok(requests.includes('/csp'));
    assert.ok(requests.includes('/second'));
    assert.ok(requests.includes('/failure'));
    assert.ok(requests.includes('/download'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // WebView2 child processes may release the isolated profile shortly after Close.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
