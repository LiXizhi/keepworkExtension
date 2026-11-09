// Real Electron windows/preload/IPC, isolated profiles, local fixture pages only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.argv.includes('--startup-fixture')) {
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  app.whenReady().then(() => {
    globalThis.startupRetries = 0;
    const { createStartupWindow } = require('../src/startupWindow.cjs');
    const startup = createStartupWindow({ BrowserWindow, ipcMain, shell }, path.resolve(__dirname, '../dist'), async () => {
      globalThis.startupRetries++;
      startup.update('连接 AIChat');
      await new Promise(resolve => setTimeout(resolve, 150));
      startup.update('AIChat 网页连接失败', '测试网络不可用，请重试。');
    });
    startup.open(); startup.update('MCP 启动失败', '测试端口冲突，请查看诊断。');
    app.on('before-quit', () => startup.dispose());
  });
} else {
  const { _electron } = require('playwright-core');
  const http = require('node:http');
  async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-launch-smoke-'));
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/frame.html' ? '<!doctype html><p>Unprivileged frame</p>' : '<!doctype html><title>Launch fixture</title><p>Isolated AIChat launch fixture</p><iframe src="/frame.html"></iframe>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, AICHAT_DESKTOP_DISABLE_MCP: '1', AICHAT_DESKTOP_DEV_URL: `http://127.0.0.1:${server.address().port}/AIChat.html` };
    delete env.ELECTRON_RUN_AS_NODE;
    let application;
    try {
      application = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`, 'keepwork-secondbrain://onboarding'], env });
      const page = await application.firstWindow(); await page.waitForLoadState();
      const cold = await page.evaluate(() => window.aichatDesktop.getLaunchIntent());
      assert.equal(cold.kind, 'onboarding');
      await application.evaluate(({ app, BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].hide();
        app.emit('open-url', { preventDefault() {} }, 'keepwork-secondbrain://onboarding');
        app.emit('second-instance', {}, ['executable', 'keepwork-secondbrain://onboarding']);
      });
      assert.deepEqual(await page.evaluate(() => window.aichatDesktop.getLaunchIntent()), cold);
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length), 1);
      assert.equal(await page.frames()[1].evaluate(() => typeof window.aichatDesktop), 'undefined');
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.equal(await page.evaluate(id => window.aichatDesktop.acknowledgeLaunchIntent(id), 'wrong'), false);
      assert.equal(await page.evaluate(id => window.aichatDesktop.acknowledgeLaunchIntent(id), cold.id), true);
      await page.reload();
      assert.equal(await page.evaluate(() => window.aichatDesktop.getLaunchIntent()), null);
      await application.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'keepwork-secondbrain://open?command=whoami'));
      assert.equal(await page.evaluate(() => window.aichatDesktop.getLaunchIntent()), null);
      await application.close(); application = undefined;
      application = await _electron.launch({ executablePath: require('electron'), args: [__filename, '--startup-fixture', `--user-data-dir=${path.join(profile, 'startup')}`], env });
      const startup = await application.firstWindow();
      await startup.getByText('MCP 启动失败', { exact: true }).waitFor();
      assert.equal(await startup.evaluate(() => typeof window.aichatDesktop), 'undefined');
      await startup.getByRole('button', { name: '重试', exact: true }).click();
      await startup.getByText('AIChat 网页连接失败', { exact: true }).waitFor();
      assert.equal(await application.evaluate(() => globalThis.startupRetries), 1);
      const output = path.resolve(__dirname, '../../../.test-runtime'); fs.mkdirSync(output, { recursive: true });
      await startup.screenshot({ path: path.join(output, 'desktop-startup.png') });
      console.log('PASS: real Electron cold URL, Mac open-url, Windows second-instance, singleton restore, acknowledgement/reload, iframe isolation, startup error/retry');
    } finally {
      if (application) await application.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
