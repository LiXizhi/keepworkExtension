// Real Electron permission callbacks with synthetic devices, no physical recording.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-media-smoke-'));
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Permission smoke</title><body>Simulated media permission test</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const entry = `http://127.0.0.1:${server.address().port}/AIChat.html`;
  let application;
  async function launch() {
    const env = { ...process.env, AICHAT_DESKTOP_DEV_URL: entry, AICHAT_DESKTOP_DISABLE_MCP: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: require('electron'),
      args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`, '--use-fake-device-for-media-stream'], env, timeout: 30000 });
    application.process().stderr.on('data', data => process.stderr.write(data));
    await application.evaluate(({ dialog }) => {
      globalThis.mediaPrompts = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.mediaPrompts.push(options.message);
        return { response: 1 };
      };
    });
    const page = await application.firstWindow();
    await page.waitForURL(entry);
    return page;
  }
  async function capture(page, constraints) {
    return page.evaluate(async constraints => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const kinds = stream.getTracks().map(track => track.kind);
      stream.getTracks().forEach(track => track.stop());
      return kinds;
    }, constraints);
  }
  const prompts = () => application.evaluate(() => globalThis.mediaPrompts);
  try {
    let page = await launch();
    assert.deepEqual(await capture(page, { audio: true }), ['audio']);
    assert.equal((await prompts()).length, 1);
    assert.match((await prompts())[0], /麦克风/);
    assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' })).state), 'granted');
    assert.deepEqual(await capture(page, { audio: true }), ['audio']);
    await page.reload();
    assert.deepEqual(await capture(page, { audio: true }), ['audio']);
    assert.equal((await prompts()).length, 1);
    assert.deepEqual(await capture(page, { video: true }), ['video']);
    assert.equal((await prompts()).length, 2);
    assert.match((await prompts())[1], /摄像头/);
    await application.close(); application = null;
    page = await launch();
    assert.deepEqual(await capture(page, { audio: true }), ['audio']);
    assert.deepEqual(await capture(page, { video: true }), ['video']);
    assert.equal((await prompts()).length, 0);
    console.log('PASS: real Electron synthetic microphone/camera, repeat, reload and restart; prompts: 2 before restart, 0 after');
  } finally {
    if (application) await application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
