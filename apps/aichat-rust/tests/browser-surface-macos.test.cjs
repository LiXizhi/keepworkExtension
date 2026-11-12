const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { renderer } = require('./helpers/desktop-renderer.cjs');

test('browser surface bridge advertises only implemented platforms and forwards native lifecycle events', async () => {
  const main = renderer('rust-init-script', 'darwin');
  const bridge = main.window.aichatDesktop;
  assert.equal(bridge.capabilities.browserSurfaceVersion, 1);
  assert.equal(bridge.capabilities.browserSurfaceViewportVersion, 1);
  assert.equal(bridge.capabilities.browserSurfaceScaleVersion, 1);
  const events = [];
  const unsubscribe = bridge.onBrowserSurface(value => events.push(value));
  const payload = { id: 'owned-surface', event: 'loaded', url: 'https://example.com/' };
  main.fire(main.window, '__aichat_desktop_event__', { detail: { event: 'browser-surface', payload } });
  assert.deepEqual(events, [payload]);
  unsubscribe();
  main.fire(main.window, '__aichat_desktop_event__', { detail: { event: 'browser-surface', payload } });
  assert.equal(events.length, 1);
  await bridge.browserSurface('reload', { id: 'owned-surface' });
  assert.deepEqual(main.calls.at(-1), { command: 'desktop_browser_surface', args: { op: 'reload', args: { id: 'owned-surface' } } });
  for (const platform of ['win32', 'linux']) {
    assert.equal(renderer('rust-init-script', platform).window.aichatDesktop.capabilities.browserSurfaceVersion, undefined);
    assert.equal(renderer('rust-init-script', platform).window.aichatDesktop.capabilities.browserSurfaceViewportVersion, undefined);
    assert.equal(renderer('rust-init-script', platform).window.aichatDesktop.capabilities.browserSurfaceScaleVersion, undefined);
  }
});

test('macOS native browser renders frame-protected sites without granting the desktop bridge', { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-browser-surface-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    requests.push(pathname);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/main') {
      response.setHeader('Set-Cookie', 'owner-secret=yes; Path=/; SameSite=Lax');
      return response.end(`<!doctype html><title>Owner fixture</title><script>
        localStorage.setItem('owner-secret','private');window.events=[];
        addEventListener('__aichat_desktop_event__',e=>events.push(e.detail.payload));
      </script><h1>Main application</h1>`);
    }
    if (pathname === '/deny') response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.end(`<!doctype html><title>Native fixture</title><body style="background:#93d4ab"><h1>Native restricted site</h1><a target="_blank" href="/second">Next page</a>
      <input id="fit-input" hidden style="position:absolute;left:1040px;top:650px;width:180px;height:35px;box-sizing:border-box">
      <button id="fit-button" hidden style="position:absolute;left:1080px;top:720px;width:160px;height:50px" onclick="window.fitClicked=(window.fitClicked||0)+1">Scaled corner button</button>
      </body>`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const executable = path.join(temporary, 'browser-surface-macos');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'Cocoa', '-framework', 'WebKit',
      path.resolve(__dirname, '../src-tauri/src/browser_surface_macos.m'), path.join(__dirname, 'fixtures/browser_surface_macos.m'), '-o', executable], { timeout: 30000 });
    assert.equal(compiled.stderr, '', 'native fixture compiles without warnings');
    try {
      const result = await execute(executable, [`http://127.0.0.1:${server.address().port}`, ...(process.env.AICHAT_BROWSER_SURFACE_LIVE === '1' ? ['--live-baidu'] : [])], { timeout: 60000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /native browser surface tests passed/);
      if (process.env.AICHAT_BROWSER_SURFACE_LIVE === '1') {
        assert.match(result.stdout, /live native Baidu passed/);
        process.stdout.write(result.stdout);
      }
    } catch (error) { assert.fail(`${error.message}\n${error.stdout}\n${error.stderr}\nRequests: ${JSON.stringify(requests)}`); }
    assert.ok(requests.includes('/deny'));
    assert.ok(requests.includes('/csp'));
    assert.ok(requests.includes('/second'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
