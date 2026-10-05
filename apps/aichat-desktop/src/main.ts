import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { TerminalSessionManager } from '../../../src/core/terminalSessions';
const { NativeFiles, atomicJson } = require('./files.cjs');
const { defaultBrainFolder } = require('./brainFolder.cjs');
const { checkGit, installGit } = require('./gitSetup.cjs');
const { RuntimeSupervisor } = require('./runtime.cjs');
const { ENTRY, trustedPage, assertSender, externalUrl } = require('./security.cjs');
let devUrl = !app.isPackaged ? process.env.AICHAT_DESKTOP_DEV_URL || '' : '';
let developmentServer: { close: () => void } | undefined;
let applicationMenu: Menu;
const disableDevMcp = !app.isPackaged && process.env.AICHAT_DESKTOP_DISABLE_MCP === '1';
if (devUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(devUrl)) throw new Error('Development URL must be loopback HTTP');
app.setAppUserModelId('com.keepwork.aichat-desktop');
const PRODUCT_NAME = 'KeepWork 第二大脑';
// Keep the original profile across product renames; explicit test/user profiles win.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'AIChat Desktop' : 'aichat-desktop'));
}
let win: BrowserWindow, tray: Tray, quitting = false, runtime: any, files: any;
let updateState = 'idle', updateError = '', checking: Promise<void> | null = null;
const terminals = new TerminalSessionManager();
const terminalIds = new Set<string>();
let settingsFile: string;
let settings = { openAtLogin: false, theme: 'light' };
let serviceBusy = false, switchingPage = false;
function reloadPage() {
  if (devUrl && trustedPage(win.webContents.getURL(), devUrl)) win.webContents.reloadIgnoringCache();
  else void win.loadURL(devUrl || ENTRY).catch((e: Error) => dialog.showErrorBox('AIChat', e.message));
}
async function useLocalSource() {
  if (switchingPage) return;
  switchingPage = true;
  try {
    const result = await dialog.showOpenDialog(win, { title: '选择包含 AIChat.html 的本地源码文件夹', properties: ['openDirectory'] });
    if (result.canceled) return;
    const { startDevelopmentServer } = require('./dev-server.cjs');
    const server = await startDevelopmentServer(result.filePaths[0]);
    developmentServer?.close(); developmentServer = server; devUrl = server.url;
    menu(); await win.loadURL(devUrl);
  } catch (error) { dialog.showErrorBox('本地服务器', String(error)); }
  finally { switchingPage = false; }
}
async function mcpAction(action: 'status' | 'restart') {
  if (serviceBusy || disableDevMcp) return;
  serviceBusy = true; menu();
  try {
    if (action === 'restart') {
      await runtime.restart();
      if (devUrl) reloadPage();
    } else {
      const health = await runtime.refresh();
      await dialog.showMessageBox(win, { title: 'Keepwork MCP 状态', message: `Keepwork MCP: ${runtime.state.state}`,
        detail: `地址：http://127.0.0.1:8089\n管理应用：${runtime.state.owner}\n版本：${health?.runtimeVersion || health?.version || '未知'}\nPID：${health?.pid || '—'}\n工作目录：${health?.workspaceRoot || '—'}${runtime.state.error ? '\n' + runtime.state.error : ''}`,
        buttons: ['关闭', '打开 Dashboard'], defaultId: 0 }).then(answer => {
          if (answer.response === 1) return shell.openExternal('http://127.0.0.1:8089/dashboard');
        });
    }
  } catch (error) { dialog.showErrorBox('Keepwork MCP', String(error)); }
  finally { serviceBusy = false; menu(); }
}
function titlebarColors(theme: string) {
  return theme === 'dark' ? { color: '#18181f', symbolColor: '#d4d4dc' } : { color: '#f2f3f7', symbolColor: '#1a1a2e' };
}
function owner() { return `desktop:${win.webContents.id}`; }
function show() { if (win) { win.show(); win.focus(); } }
async function checkUpdates() {
  if (disableDevMcp) return;
  if (checking) return checking;
  checking = (async () => {
    updateError = '';
    const results = await Promise.allSettled([runtime.check(), ...(app.isPackaged ? [autoUpdater.checkForUpdates()] : [])]);
    updateError = results.filter(r => r.status === 'rejected').map((r: any) => r.reason.message).join('; ');
    menu();
  })().finally(() => { checking = null; });
  return checking;
}
function menu() {
  const items: any[] = [
    { label: `打开 ${PRODUCT_NAME}`, click: show },
    { label: '打开文件夹…', click: async () => {
      show();
      if (!trustedPage(win.webContents.getURL(), devUrl)) return;
      const grant = await chooseFolder();
      if (grant && trustedPage(win.webContents.getURL(), devUrl)) win.webContents.send('aichat-desktop:folder-selected', grant.path);
    } },
    { type: 'separator' },
    { label: `MCP: ${runtime?.state.state || 'starting'} ${runtime?.state.version || ''} (${runtime?.state.owner || 'desktop'})`, enabled: false },
    ...(runtime?.state.error ? [{ label: String(runtime.state.error).slice(0, 100), enabled: false }] : []),
    { label: 'Keepwork MCP Server', submenu: [
      { label: '查看状态…', enabled: !serviceBusy && !disableDevMcp, click: () => { void mcpAction('status'); } },
      { label: '打开 Dashboard', click: () => { void shell.openExternal('http://127.0.0.1:8089/dashboard').catch((e: Error) => dialog.showErrorBox('Keepwork MCP', e.message)); } },
      { label: serviceBusy ? '正在操作…' : '重启 Keepwork MCP Server', enabled: !serviceBusy && !disableDevMcp, click: () => { void mcpAction('restart'); } },
    ] },
    { label: 'AIChat 服务器', submenu: [
      { label: devUrl || ENTRY, enabled: false },
      { label: '使用本地源码服务器…', click: () => { void useLocalSource(); } },
      { label: '使用线上服务器', click: () => {
        if (switchingPage) return;
        developmentServer?.close(); developmentServer = undefined; devUrl = ''; menu(); reloadPage();
      } },
      { label: '重新加载（本地跳过缓存）', accelerator: 'CmdOrCtrl+R', click: reloadPage },
    ] },
    { label: runtime?.state.pending ? 'MCP 更新将在退出并重新打开后生效' : `桌面更新: ${updateState}`, enabled: false },
    ...(updateError ? [{ label: `更新失败: ${updateError.slice(0, 100)}`, enabled: false }] : []),
    { label: '检查更新', click: () => { void checkUpdates(); } },
    { label: `${PRODUCT_NAME} ${app.getVersion()}`, enabled: false },
    { label: '登录电脑后自动启动', type: 'checkbox', checked: settings.openAtLogin, click: (item: any) => {
      settings.openAtLogin = item.checked; atomicJson(settingsFile, settings);
      app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--background'] });
    } },
    { label: '退出', click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(items));
  applicationMenu = Menu.buildFromTemplate([
    { label: PRODUCT_NAME, submenu: items },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '重新加载 AIChat', click: reloadPage }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]);
  Menu.setApplicationMenu(applicationMenu);
  if (process.platform !== 'darwin') win.setMenu(null);
}
async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : files.grant(result.filePaths[0]);
}
function clearTerminals() { terminals.closeAll(); terminalIds.clear(); }
function setupBridge() {
  ipcMain.handle('aichat-desktop:v1', async (event, method, args = {}) => {
    assertSender(event, win.webContents, devUrl);
    if (!args || typeof args !== 'object') throw new Error('Invalid request');
    if (method === 'theme') {
      if (!['light', 'dark'].includes(args.theme)) throw new Error('Invalid theme');
      nativeTheme.themeSource = args.theme;
      win.setTitleBarOverlay({ ...titlebarColors(args.theme), height: 34 });
      if (settings.theme !== args.theme) { settings.theme = args.theme; atomicJson(settingsFile, settings); }
      return;
    }
    if (method === 'titlebar') {
      const entry = new URL(devUrl || ENTRY);
      const address = devUrl ? `${entry.hostname === '127.0.0.1' ? 'localhost' : entry.hostname}:${entry.port}` : `${entry.host}${entry.pathname}`;
      return { platform: process.platform, address, icon: nativeImage.createFromPath(path.join(__dirname, 'keepwork.png')).toDataURL() };
    }
    // Targets come from the main process, never from renderer-supplied URLs.
    if (method === 'openEntry') return shell.openExternal(devUrl || ENTRY);
    if (method === 'reloadPage') { reloadPage(); return; }
    if (method === 'menu') {
      if (!Number.isInteger(args.index) || args.index < 0 || args.index > 2) throw new Error('Invalid menu');
      applicationMenu.items[args.index]?.submenu?.popup({ window: win, x: 8 + args.index * 60, y: 34 });
      return;
    }
    if (method === 'roots') return files.roots();
    if (method === 'checkGit') return checkGit();
    if (method === 'installGit') return installGit();
    if (method === 'pickFolder') return chooseFolder();
    if (method === 'defaultBrainFolder') {
      if (typeof args.prepare !== 'boolean') throw new Error('Invalid folder request');
      return defaultBrainFolder(files, app.getPath('documents'), args.prepare);
    }
    if (method === 'revokeFolder') { clearTerminals(); return files.revoke(args.rootId); }
    if (method === 'status') return { version: app.getVersion(), mcp: runtime.state, shell: updateState, error: updateError };
    if (method === 'checkUpdates') { await checkUpdates(); return { mcp: runtime.state, shell: updateState, error: updateError }; }
    if (method === 'file') {
      if (args.op === 'reveal') {
        const target = files.resolve(args.rootId, args.rel);
        if (args.mode === 'open') {
          const answer = await dialog.showMessageBox(win, { message: `使用默认应用打开 ${path.basename(target)}？`, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
          if (answer.response === 1) { const error = await shell.openPath(target); if (error) throw new Error(error); }
        } else if (args.mode === 'dir') { const error = await shell.openPath(fs.statSync(target).isDirectory() ? target : path.dirname(target)); if (error) throw new Error(error); }
        else shell.showItemInFolder(target);
        return { ok: true };
      }
      return files.execute(args.op, args);
    }
    if (method === 'terminal') {
      if (args.op === 'create') {
        // Nonlocal chats get an application-owned scratch cwd; arbitrary paths are never accepted.
        const cwd = args.rootId ? files.resolve(args.rootId, args.rel || '') : path.join(app.getPath('userData'), 'terminal-workspaces', String(args.slot || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100));
        fs.mkdirSync(cwd, { recursive: true });
        const result = terminals.create(cwd, '.', owner(), args);
        terminalIds.add(result.id); return { ...result, id: `desktop:${result.id}` };
      }
      const id = String(args.id || '').replace(/^desktop:/, '');
      if (!terminalIds.has(id)) throw new Error('terminal session not found');
      if (args.op === 'write') return terminals.write(id, owner(), args.data);
      if (args.op === 'resize') return terminals.resize(id, owner(), args.cols, args.rows);
      if (args.op === 'output') return terminals.output(id, owner(), args.cursor);
      if (args.op === 'interrupt') return terminals.interrupt(id, owner());
      if (args.op === 'close') { terminals.close(id, owner()); terminalIds.delete(id); return; }
    }
    throw new Error('Unknown desktop operation');
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    if (!app.isPackaged && !devUrl && process.env.AICHAT_DESKTOP_LOCAL_SOURCE === '1') {
      try {
        const { startDevelopmentServer } = require('./dev-server.cjs');
        const server = await startDevelopmentServer(process.env.AICHAT_SOURCE_DIR || path.resolve(__dirname, '../../../../apps/official/apps/tools/AIChat'));
        developmentServer = server; devUrl = server.url;
        console.log(`AIChat source: ${devUrl}`);
      } catch (error) {
        dialog.showErrorBox(PRODUCT_NAME, `无法启动本地 AIChat 源码。请设置 AICHAT_SOURCE_DIR。\n${String(error)}`);
        app.exit(1); return;
      }
    }
    const home = app.getPath('userData'); settingsFile = path.join(home, 'settings.json');
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first launch */ }
    nativeTheme.themeSource = settings.theme === 'dark' ? 'dark' : 'light';
    files = new NativeFiles(path.join(home, 'folder-grants.json'));
    const stagedRuntime = path.resolve(__dirname, '../../mcp-runtime/staging', `${process.platform === 'win32' ? 'windows' : 'macos'}-${process.arch}`);
    runtime = new RuntimeSupervisor(path.join(home, 'mcp-runtimes'), app.isPackaged ? path.join(process.resourcesPath, 'mcp-runtime') : process.env.AICHAT_MCP_RUNTIME_DIR || (fs.existsSync(path.join(stagedRuntime, 'runtime.json')) ? stagedRuntime : ''), app.getVersion());
    const appIcon = nativeImage.createFromPath(path.join(__dirname, 'keepwork.png'));
    win = new BrowserWindow({ title: PRODUCT_NAME, icon: appIcon, width: 1360, height: 900, show: false,
      backgroundColor: settings.theme === 'dark' ? '#0a0a0f' : '#ffffff',
      titleBarStyle: 'hidden', titleBarOverlay: { ...titlebarColors(settings.theme), height: 34 },
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: 'persist:aichat', nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, webviewTag: false } });
    setupBridge();
    win.on('page-title-updated', event => event.preventDefault());
    if (process.platform === 'darwin') app.dock?.setIcon(appIcon);
    win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
    win.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clearTerminals(); });
    win.webContents.on('will-navigate', (e, url) => { if (!trustedPage(url, devUrl)) { e.preventDefault(); if (externalUrl(url)) void shell.openExternal(url); } });
    win.webContents.on('will-redirect', (e, url, _inPlace, mainFrame) => { if (mainFrame && !trustedPage(url, devUrl)) e.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (externalUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
    const session = win.webContents.session;
    session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win.webContents && details.isMainFrame === true && trustedPage(details.embeddingOrigin || '', devUrl) && ['clipboard-sanitized-write'].includes(permission));
    session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (contents !== win.webContents || !details.isMainFrame || !trustedPage(details.requestingUrl, devUrl)
          || !['media', 'notifications', 'clipboard-sanitized-write'].includes(permission)) return callback(false);
      const answer = await dialog.showMessageBox(win, { message: `允许 AIChat 使用 ${permission}？`, buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0 });
      callback(answer.response === 1);
    });
    const icon = appIcon.resize({ width: process.platform === 'darwin' ? 22 : 16 });
    tray = new Tray(icon); tray.setToolTip(PRODUCT_NAME); tray.on('click', show); menu();
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => { updateState = 'checking'; menu(); });
    autoUpdater.on('update-not-available', () => { updateState = 'current'; menu(); });
    autoUpdater.on('update-downloaded', () => { updateState = 'pending restart'; menu(); });
    autoUpdater.on('error', e => { updateError = e.message; menu(); });
    await win.loadURL(devUrl || ENTRY).catch(() => {
      // No native privileges on this offline error page. Reload retries the official entry.
      void dialog.showMessageBox(win, { message: '无法连接 AIChat，请检查网络后从菜单重新加载。' });
    });
    if (!process.argv.includes('--background')) show();
    if (!disableDevMcp) void runtime.start().then(menu).catch((e: Error) => { updateError = e.message; menu(); });
    setTimeout(() => { void checkUpdates(); }, 15000).unref();
    setInterval(() => { void checkUpdates(); }, 6 * 60 * 60 * 1000).unref();
  });
  app.on('activate', show);
  app.on('window-all-closed', () => { /* Keep the application and its services alive. */ });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; clearTerminals(); developmentServer?.close();
    void (async () => {
      try { await runtime?.restarting; await runtime?.starting; } catch { /* Finish shutdown after failed startup. */ }
      await runtime?.stop();
    })().finally(() => app.quit());
  });
}
