// Real Electron F12 and native/custom-menu commands, using an isolated profile.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
async function assertEventually(read, expected) {
  for (let i = 0; i < 50; i++) {
    if (await read() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await read(), expected);
}
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-devtools-smoke-'));
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Developer tools fixture</title><input autofocus><script>console.error("devtools-smoke-error");</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, AICHAT_DESKTOP_TEST_PROFILE: '1', AICHAT_DESKTOP_DISABLE_MCP: '1', AICHAT_DESKTOP_DEV_URL: `http://127.0.0.1:${server.address().port}/AIChat.html` };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`], env });
    const page = await application.firstWindow();
    await page.waitForLoadState();
    await page.locator('input').focus();
    const pressF12 = () => application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/AIChat.html')).webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'F12' });
    });
    await pressF12();
    const opened = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/AIChat.html')).webContents.isDevToolsOpened());
    await assertEventually(opened, true);
    // The titlebar calls the same host command as the native macOS View menu.
    await page.evaluate(() => window.aichatDesktop.runMenuCommand('devtools'));
    await assertEventually(opened, false);
    await pressF12();
    await assertEventually(opened, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    console.log('PASS: real Electron F12, View menu command, reopen, sandbox isolation');
  } finally {
    if (application) await application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
