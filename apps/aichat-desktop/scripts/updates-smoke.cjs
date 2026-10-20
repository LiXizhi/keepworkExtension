// Isolated Electron window/IPC smoke. No CDN downloads or installed services touched.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-updates-'));
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Update test</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    const env = { ...process.env, AICHAT_DESKTOP_DEV_URL: `http://127.0.0.1:${server.address().port}/AIChat.html`, AICHAT_DESKTOP_DISABLE_MCP: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`], env });
    const mainPage = await app.firstWindow();
    await mainPage.waitForLoadState();
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Help').submenu.items.find(item => item.label === '检查更新…').click());
    const page = await opened; await page.waitForLoadState();
    await page.locator('h2').first().waitFor();
    assert.equal(await page.locator('h2').count(), 2);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.aichatDesktop), 'undefined');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Help').submenu.items.find(item => item.label === '检查更新…').click());
    assert.equal(app.windows().length, 2);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/updates.html'));
      win.webContents.send('aichat-update-window:v1', { checking: false,
        mcp: { state: 'ready', currentVersion: '1.0.0', latest: { version: '1.1.0', builtAt: '2026-10-20T00:00:00Z' }, owner: 'vscode-extension', runningVersion: '0.9.0', canApply: true },
        desktop: { state: 'current', currentVersion: '0.1.4', latest: { version: '0.1.4' }, canApply: false } });
    });
    await page.getByText('1.1.0', { exact: true }).waitFor();
    assert.match(await page.locator('body').innerText(), /vscode-extension/);
    assert.match(await page.locator('body').innerText(), /未提供/);
    assert.equal(await page.getByRole('button', { name: '更新 MCP', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '更新桌面应用' }).isEnabled(), false);
    const output = path.resolve(__dirname, '../../..', '.test-runtime'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'aichat-updates.png') });
    await page.close();
    assert.equal(app.windows().length, 1);
    console.log('PASS: Electron Help menu, isolated update window, singleton, version/date/ownership rendering and closing');
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
