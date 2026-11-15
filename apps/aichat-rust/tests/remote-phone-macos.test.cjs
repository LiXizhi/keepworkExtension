const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

test('macOS main phone acquires mock audio in pet mode without navigating or showing its desktop window', {
  skip: process.platform !== 'darwin',
  timeout: 90000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-remote-phone-'));
  const requests = new Map();
  const server = http.createServer((request, response) => {
    const page = request.url;
    if (page !== '/main' && page !== '/pet') {
      response.writeHead(404).end();
      return;
    }
    requests.set(page, (requests.get(page) || 0) + 1);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    response.end(page === '/pet'
      ? `<!doctype html><title>pet</title><button style="position:fixed;inset:0" onclick="window.petClicks++">Pet</button>
         <script>window.petClicks = 0</script>`
      : `<!doctype html><title>main</title><script>
        window.sessionMarker = crypto.randomUUID();
        window.phoneStarts = 0;
        window.startPhone = async () => {
          window.phoneStarts++;
          window.captureState = 'waiting';
          try {
            window.stream = await navigator.mediaDevices.getUserMedia({audio:true});
            window.track = stream.getAudioTracks()[0];
            window.captureState = 'listening';
          } catch (e) { window.captureState = e.name; }
        };
      </script>`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const exe = path.join(dir, 'test-phone');
    await run('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'CoreGraphics',
      path.resolve(__dirname, '../src-tauri/src/app/remote_phone_macos.m'),
      path.join(__dirname, 'fixtures/remote_phone_macos.m'), '-o', exe], { timeout: 20000 });
    try {
      const result = await run(exe, [`http://127.0.0.1:${server.address().port}`], { timeout: 50000 });
      if (result.stdout.includes('locked/asleep')) t.diagnostic('The fixture simulated unobscured windows on a locked/asleep display.');
      assert.match(result.stdout, /passed: grant/);
      assert.match(result.stdout, /passed: deny/);
    } catch (error) {
      if (error.code === 77 && /no WebKit mock capture/i.test(error.stdout)) {
        t.skip('This WebKit version has no mock capture device support');
        return;
      }
      throw error;
    }
    assert.equal(requests.get('/main'), 2, 'each scenario retains the original main document');
    assert.equal(requests.get('/pet'), 2, 'each scenario retains the original pet');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
