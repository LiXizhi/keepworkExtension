// Exercises the real sandbox/preload/IPC/PTY stack against AIChat's actual adapters.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function main() {
  const sources = process.env.AICHAT_SOURCE_DIR;
  if (!sources) throw new Error('Set AICHAT_SOURCE_DIR to the AIChat source directory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-electron-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const pageHtml = '<!doctype html><title>AIChat Desktop test</title><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/shell.css"><body class="light"><iframe src="/preview.html"></iframe><script type="module">import * as desktop from "/desktop.js"; import * as files from "/keepwork_fs.js"; import { installDesktopMenu } from "/desktop_menu.js"; installDesktopMenu({ command(id) { if (id === "new-chat") { window.menuCommand = id; return true; } return false; }, checked(id) { return id === "toggle-sidebar"; } }); window.adapters={desktop,files};</script>';
  const filesToServe = { '/desktop.js': ['js/desktop.js', 'text/javascript'], '/keepwork_fs.js': ['js/keepwork_fs.js', 'text/javascript'], '/desktop_menu.js': ['js/desktop_menu.js', 'text/javascript'], '/base.css': ['css/base.css', 'text/css'], '/shell.css': ['css/shell.css', 'text/css'] };
  const server = http.createServer((req, res) => {
    const file = filesToServe[req.url.split('?')[0]];
    if (file) { res.setHeader('Content-Type', file[1]); res.end(fs.readFileSync(path.join(sources, file[0]))); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(pageHtml);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const entry = `http://127.0.0.1:${server.address().port}/AIChat.html`;
  let application;
  try {
    const env = { ...process.env, AICHAT_DESKTOP_DEV_URL: entry, AICHAT_DESKTOP_DISABLE_MCP: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const packaged = process.env.AICHAT_PACKAGED_EXE;
    application = await _electron.launch({ executablePath: packaged || require('electron'),
      args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), `--user-data-dir=${path.join(dir, 'profile')}`], env, timeout: 30000 });
    assert.equal(
      fs.realpathSync(await application.evaluate(({ app }) => app.getPath('userData'))),
      fs.realpathSync(path.join(dir, 'profile')),
    );
    const page = await application.firstWindow();
    if (packaged) {
      await page.route('https://keepwork.com/**', async route => {
        const url = new URL(route.request().url());
        const served = filesToServe[url.pathname];
        if (served) await route.fulfill({ contentType: served[1], body: fs.readFileSync(path.join(sources, served[0]), 'utf8') });
        else await route.fulfill({ contentType: 'text/html', body: pageHtml });
      });
      await page.goto('https://keepwork.com/chat');
    }
    await page.waitForFunction(() => window.adapters && window.aichatDesktop);
    await page.waitForSelector('#keepwork-desktop-titlebar');
    await page.evaluate(() => {
      window.postMessage({ channel: 'aichat.desktop-menu.v1', type: 'show', x: 12, y: 40, menu: {
        id: 'view', label: 'View', items: [
          { id: 'toggle-sidebar', label: '历史侧栏', check: true },
          { type: 'separator' },
          { id: 'zoom-in', label: '放大', shortcut: 'Ctrl+=' },
          { id: 'new-chat', label: '新对话', shortcut: 'Ctrl+N' },
        ],
      } }, location.origin);
    });
    await page.waitForSelector('#aichat-desktop-menu [data-command="zoom-in"]');
    assert.match(await page.locator('#aichat-desktop-menu').innerText(), /历史侧栏/);
    assert.match(await page.locator('#aichat-desktop-menu').innerText(), /Ctrl\+=/);
    assert.equal(await page.getAttribute('#aichat-desktop-menu [data-command="toggle-sidebar"]', 'aria-checked'), 'true');
    await page.screenshot({ path: path.join(os.tmpdir(), 'aichat-desktop-menu.png') });
    await page.click('#aichat-desktop-menu [data-command="zoom-in"]');
    assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()) > 0);
    await page.evaluate(() => window.postMessage({ channel: 'aichat.desktop-menu.v1', type: 'show', x: 80, y: 40, menu: { id: 'file', label: 'File', items: [{ id: 'new-chat', label: '新对话' }] } }, location.origin));
    await page.click('#aichat-desktop-menu [data-command="new-chat"]');
    assert.equal(await page.evaluate(() => window.menuCommand), 'new-chat');
    assert.equal(await page.locator('#aichat-desktop-menu').count(), 0);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0));
    // AIChat's #app wrapper has auto height. A percentage shell height collapses
    // to content height instead of filling the area below native chrome.
    await page.evaluate(() => {
      document.body.style.margin = '0';
      const root = document.createElement('div'); root.id = 'app';
      root.innerHTML = '<div class="app-shell" style="display:flex;height:100vh"><aside style="width:200px;background:#222">Sidebar</aside><main style="flex:1;min-height:80px">Chat</main></div>';
      document.body.prepend(root);
    });
    for (const [width, height] of [[1360, 900], [1000, 700], [1360, 900]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
      await page.waitForFunction(expected => innerHeight === expected, height);
      const bounds = await page.evaluate(() => {
        const rect = document.querySelector('.app-shell').getBoundingClientRect();
        const sidebar = document.querySelector('.app-shell aside').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, sidebarBottom: sidebar.bottom, viewport: innerHeight };
      });
      assert.equal(bounds.top, 34, 'shell begins below titlebar');
      assert.equal(bounds.bottom, bounds.viewport, 'shell fills remaining window height');
      assert.equal(bounds.sidebarBottom, bounds.viewport, 'sidebar reaches window bottom');
    }
    if (packaged) {
      await page.waitForFunction(async () => ['running', 'attached'].includes((await aichatDesktop.status()).mcp.state));
      console.log('Packaged MCP:', JSON.stringify((await page.evaluate(() => aichatDesktop.status())).mcp));
    }
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, workspace);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const grant = await page.evaluate(() => window.aichatDesktop.pickFolder());
    assert.equal(grant.path, fs.realpathSync(workspace));
    await page.evaluate(async abs => { await adapters.files.keepworkWriteText(abs, 'hello.txt', 'native without MCP'); }, grant.path);
    assert.equal(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8'), 'native without MCP');
    assert.equal(await page.evaluate(abs => adapters.files.keepworkReadText(abs, 'hello.txt'), grant.path), 'native without MCP');
    await assert.rejects(page.evaluate(() => aichatDesktop.file('read', { rootId: 'forged', rel: 'secret' })), /not granted/);
    await assert.rejects(page.evaluate(id => aichatDesktop.file('read', { rootId: id, rel: '../secret' }), grant.id), /relative path/);
    const frame = page.frames().find(frame => frame !== page.mainFrame());
    assert.equal(await frame.evaluate(() => typeof window.aichatDesktop), 'undefined');
    // An iframe cannot launder an IPC call through an Electron frame identity.
    const session = await page.evaluate(async abs => adapters.desktop.desktopCreateTerminal({ type: 'local' }, abs), grant.path);
    await page.evaluate(async id => { await adapters.desktop.desktopTerminal('resize', { id, cols: 100, rows: 30 }); await adapters.desktop.desktopTerminal('write', { id, data: 'echo DESKTOP_TERMINAL_OK\r' }); }, session.id);
    await page.waitForFunction(async id => (await aichatDesktop.terminal('output', { id, cursor: 0 })).output.includes('DESKTOP_TERMINAL_OK'), session.id);
    await page.evaluate(id => aichatDesktop.terminal('close', { id }), session.id);
    await page.reload(); await page.waitForFunction(() => window.adapters);
    assert.equal((await page.evaluate(() => aichatDesktop.roots()))[0].id, grant.id);
    const closed = await application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.close();
      return { destroyed: w.isDestroyed(), windows: BrowserWindow.getAllWindows().length };
    });
    assert.deepEqual(closed, { destroyed: true, windows: 0 });
    const reopened = await application.evaluate(async ({ app, BrowserWindow }) => {
      app.emit('activate');
      for (let i = 0; i < 50; i++) {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.webContents.isLoading() && w.webContents.getURL().startsWith('http://127.0.0.1:')) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    });
    assert.equal(reopened, true);
    console.log('Electron sandbox, native grants, AIChat files, PTY, iframe isolation, reload and close passed');
  } finally {
    if (application) await application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
