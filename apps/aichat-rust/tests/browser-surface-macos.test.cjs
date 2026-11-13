const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { renderer } = require('./helpers/desktop-renderer.cjs');

function bridgeFixture(implementation, platform, subframe = false) {
  if (implementation === 'injected') {
    const main = renderer('rust-init-script', platform, subframe);
    return { ...main, emit: detail => main.fire(main.window, '__aichat_desktop_event__', { detail }) };
  }
  const calls = [], listeners = new Map();
  const window = {
    location: new URL('https://keepwork.com/chat'),
    __AICHAT_DESKTOP_BOOTSTRAP__: { platform },
    addEventListener: (name, callback) => listeners.set(name, callback),
    postMessage() {},
  };
  window.top = subframe ? {} : window;
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/bridge.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, window, URL,
    require: name => name.endsWith('/core')
      ? { invoke: (command, args = {}) => { calls.push(JSON.parse(JSON.stringify({ command, args }))); return Promise.resolve(true); } }
      : { listen: () => Promise.resolve(() => {}) },
  });
  exports.installAIChatDesktopBridge();
  return { window, calls, emit: detail => listeners.get('__aichat_desktop_event__')?.({ detail }) };
}

for (const implementation of ['injected', 'typescript']) {
  for (const platform of ['darwin', 'win32', 'linux']) {
    test(`${implementation} browser surface capabilities and lifecycle (${platform})`, async () => {
      const main = bridgeFixture(implementation, platform);
      const bridge = main.window.aichatDesktop;
      assert.equal(bridge.version, 1);
      assert.ok(Object.isFrozen(bridge));
      assert.ok(Object.isFrozen(bridge.capabilities));
      assert.equal(bridge.capabilities.browserSurfaceVersion, platform === 'linux' ? undefined : 1);
      assert.equal(bridge.capabilities.browserSurfaceViewportVersion, platform === 'darwin' ? 1 : undefined);
      assert.equal(bridge.capabilities.browserSurfaceScaleVersion, platform === 'darwin' ? 1 : undefined);

      const events = [];
      const unsubscribe = bridge.onBrowserSurface(value => events.push(value));
      const payload = { id: 'owned-surface', event: 'loaded', url: 'https://example.com/', title: 'Browser fixture', canGoBack: true };
      main.emit({ event: 'browser-surface', payload });
      main.emit({ event: 'unrelated-event', payload });
      assert.deepEqual(events, [payload]);
      unsubscribe();
      main.emit({ event: 'browser-surface', payload });
      assert.equal(events.length, 1);

      for (const op of ['open', 'navigate', 'bounds', 'back', 'forward', 'reload', 'hide', 'close']) {
        const args = { id: 'owned-surface', ...(op === 'open' || op === 'navigate' ? { url: 'https://example.com/' } : {}),
          ...(op === 'open' || op === 'bounds' ? { bounds: { x: 10, y: 80, width: 800, height: 500 } } : {}) };
        await bridge.browserSurface(op, args);
        assert.deepEqual(main.calls.at(-1), { command: 'desktop_browser_surface', args: { op, args } });
      }
      // Browser support remains optional for old pages and unrelated Bridge v1 calls.
      await bridge.roots();
      assert.equal(main.calls.at(-1).command, 'desktop_roots');
    });

    test(`${implementation} subframes receive no desktop browser bridge (${platform})`, () => {
      assert.equal(bridgeFixture(implementation, platform, true).window.aichatDesktop, undefined);
    });
  }
}

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
