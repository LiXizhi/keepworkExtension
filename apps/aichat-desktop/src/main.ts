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
let win: BrowserWindow | undefined, tray: Tray, quitting = false, runtime: any, files: any;
let opening: Promise<void> | null = null;
let appIcon: ReturnType<typeof nativeImage.createFromPath> | undefined;
const closedTip = `${PRODUCT_NAME}（窗口已关闭，点击重新打开）`;
let updateState = 'idle', updateError = '', checking: Promise<void> | null = null;
const terminals = new TerminalSessionManager();
const terminalIds = new Set<string>();
let settingsFile: string;
let settings = { openAtLogin: false, theme: 'light' };
let serviceBusy = false, switchingPage = false;
function liveWindow() {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return undefined;
  return win;
}
function reloadPage() {
  const current = liveWindow();
  if (!current) { show(); return; }
  if (devUrl && trustedPage(current.webContents.getURL(), devUrl)) current.webContents.reloadIgnoringCache();
  else void current.loadURL(devUrl || ENTRY).catch((e: Error) => dialog.showErrorBox('AIChat', e.message));
}
async function useLocalSource() {
  if (switchingPage) return;
  switchingPage = true;
  try {
    const parent = liveWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: '选择包含 AIChat.html 的本地源码文件夹', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择包含 AIChat.html 的本地源码文件夹', properties: ['openDirectory'] });
    if (result.canceled) return;
    const { startDevelopmentServer } = require('./dev-server.cjs');
    const server = await startDevelopmentServer(result.filePaths[0]);
    developmentServer?.close(); developmentServer = server; devUrl = server.url;
    menu();
    const current = liveWindow();
    if (current) await current.loadURL(devUrl);
    else await ensureShown();
  } catch (error) { dialog.showErrorBox('本地服务器', String(error)); }
  finally { switchingPage = false; }
}
async function mcpAction(action: 'status' | 'restart') {
  if (serviceBusy || disableDevMcp) return;
  serviceBusy = true; menu();
  try {
    if (action === 'restart') {
      await runtime.restart();
      if (devUrl && liveWindow()) reloadPage();
    } else {
      const health = await runtime.refresh();
      const status = { title: 'Keepwork MCP 状态', message: `Keepwork MCP: ${runtime.state.state}`,
        detail: `地址：http://127.0.0.1:8089\n管理应用：${runtime.state.owner}\n版本：${health?.runtimeVersion || health?.version || '未知'}\nPID：${health?.pid || '—'}\n工作目录：${health?.workspaceRoot || '—'}${runtime.state.error ? '\n' + runtime.state.error : ''}`,
        buttons: ['关闭', '打开 Dashboard'], defaultId: 0 };
      const parent = liveWindow();
      const answer = parent ? await dialog.showMessageBox(parent, status) : await dialog.showMessageBox(status);
      if (answer.response === 1) await shell.openExternal('http://127.0.0.1:8089/dashboard');
    }
  } catch (error) { dialog.showErrorBox('Keepwork MCP', String(error)); }
  finally { serviceBusy = false; menu(); }
}
function titlebarColors(theme: string) {
  return theme === 'dark' ? { color: '#18181f', symbolColor: '#d4d4dc' } : { color: '#f2f3f7', symbolColor: '#1a1a2e' };
}
function owner() {
  const current = liveWindow();
  if (!current) throw new Error('window closed');
  return `desktop:${current.webContents.id}`;
}
function show() { void ensureShown(); }
function ensureShown() {
  const current = liveWindow();
  if (current) { current.show(); current.focus(); return Promise.resolve(); }
  if (!opening) opening = openWindow().finally(() => { opening = null; });
  return opening;
}
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
const PAGE_COMMANDS = new Set(['new-chat', 'toggle-sidebar', 'toggle-files', 'open-settings']);
const HOST_COMMANDS = new Set(['open-folder', 'reload', 'check-updates', 'toggle-login', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'select-all', 'zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'mcp-status', 'mcp-dashboard', 'mcp-restart', 'open-browser', 'local-source', 'published-site']);
const MENU_ROLES: Record<string, string> = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'select-all': 'selectAll', 'zoom-in': 'zoomIn', 'zoom-out': 'zoomOut', 'zoom-reset': 'resetZoom', fullscreen: 'togglefullscreen' };
function shortcut(accelerator = '') {
  const mac = process.platform === 'darwin';
  return accelerator.replace('CmdOrCtrl', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace('Alt', mac ? '⌥' : 'Alt');
}
function deliverPageCommand(id: string) {
  const current = liveWindow();
  if (current && trustedPage(current.webContents.getURL(), devUrl)) current.webContents.send('aichat-desktop:page-command', id);
}
function runCommand(id: string) {
  if (PAGE_COMMANDS.has(id)) { deliverPageCommand(id); return; }
  if (!HOST_COMMANDS.has(id)) return;
  const current = liveWindow();
  if (id === 'open-folder') { void openFolderFromMenu(); return; }
  if (id === 'reload') { reloadPage(); return; }
  if (id === 'check-updates') { void checkUpdates(); return; }
  if (id === 'toggle-login') {
    settings.openAtLogin = !settings.openAtLogin; atomicJson(settingsFile, settings);
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--background'] }); menu(); return;
  }
  if (id === 'quit') { app.quit(); return; }
  if (id === 'mcp-status') { void mcpAction('status'); return; }
  if (id === 'mcp-dashboard') { void shell.openExternal('http://127.0.0.1:8089/dashboard').catch((e: Error) => dialog.showErrorBox('Keepwork MCP', e.message)); return; }
  if (id === 'mcp-restart') { void mcpAction('restart'); return; }
  if (id === 'open-browser') { void shell.openExternal(devUrl || ENTRY); return; }
  if (id === 'local-source') { void useLocalSource(); return; }
  if (id === 'published-site') {
    if (switchingPage) return;
    developmentServer?.close(); developmentServer = undefined; devUrl = ''; menu(); reloadPage(); return;
  }
  if (!current) return;
  if (id === 'undo') current.webContents.undo();
  else if (id === 'redo') current.webContents.redo();
  else if (id === 'cut') current.webContents.cut();
  else if (id === 'copy') current.webContents.copy();
  else if (id === 'paste') current.webContents.paste();
  else if (id === 'select-all') current.webContents.selectAll();
  else if (id === 'zoom-in') current.webContents.setZoomLevel(current.webContents.getZoomLevel() + 0.5);
  else if (id === 'zoom-out') current.webContents.setZoomLevel(current.webContents.getZoomLevel() - 0.5);
  else if (id === 'zoom-reset') current.webContents.setZoomLevel(0);
  else if (id === 'fullscreen') current.setFullScreen(!current.isFullScreen());
}
async function openFolderFromMenu() {
  await ensureShown();
  const current = liveWindow();
  if (!current || !trustedPage(current.webContents.getURL(), devUrl)) return;
  const grant = await chooseFolder();
  const opened = liveWindow();
  if (grant && opened && trustedPage(opened.webContents.getURL(), devUrl)) opened.webContents.send('aichat-desktop:folder-selected', grant.path);
}
function desktopMenus() {
  const key = (accelerator: string, label: string, id: string) => ({ id, label, accelerator, shortcut: shortcut(accelerator) });
  return {
    file: [
      key('CmdOrCtrl+N', '新对话', 'new-chat'),
      key('CmdOrCtrl+O', '打开文件夹…', 'open-folder'),
      { type: 'separator' },
      key('CmdOrCtrl+R', '重新加载', 'reload'),
      { type: 'separator' },
      { id: 'check-updates', label: '检查更新' },
      { id: 'toggle-login', label: '登录后自动启动', checked: settings.openAtLogin === true },
      { type: 'separator' },
      key('CmdOrCtrl+Q', '退出', 'quit'),
    ],
    edit: [
      key('CmdOrCtrl+Z', '撤销', 'undo'),
      key('CmdOrCtrl+Shift+Z', '重做', 'redo'),
      { type: 'separator' },
      key('CmdOrCtrl+X', '剪切', 'cut'),
      key('CmdOrCtrl+C', '复制', 'copy'),
      key('CmdOrCtrl+V', '粘贴', 'paste'),
      key('CmdOrCtrl+A', '全选', 'select-all'),
    ],
    view: [
      { id: 'toggle-sidebar', label: '历史侧栏', check: true },
      { id: 'toggle-files', label: '文件面板', check: true },
      { type: 'separator' },
      key('CmdOrCtrl+=', '放大', 'zoom-in'),
      key('CmdOrCtrl+-', '缩小', 'zoom-out'),
      key('CmdOrCtrl+0', '实际大小', 'zoom-reset'),
      { type: 'separator' },
      key('F11', '全屏', 'fullscreen'),
      { type: 'separator' },
      { id: 'open-settings', label: '设置' },
    ],
    help: [
      { label: `MCP：${runtime?.state.state || 'starting'} ${runtime?.state.version || ''}（${runtime?.state.owner || 'desktop'}）`, enabled: false },
      ...(runtime?.state.error ? [{ label: String(runtime.state.error).slice(0, 80), enabled: false }] : []),
      { id: 'mcp-status', label: '查看状态…', enabled: !serviceBusy && !disableDevMcp },
      { id: 'mcp-dashboard', label: '打开 Dashboard' },
      { id: 'mcp-restart', label: serviceBusy ? '正在操作…' : '重启 Keepwork MCP', enabled: !serviceBusy && !disableDevMcp },
      { type: 'separator' },
      { id: 'open-browser', label: '在浏览器中打开' },
      { id: 'local-source', label: '使用本地源码服务器…' },
      { id: 'published-site', label: '使用线上服务器' },
      { label: devUrl || ENTRY, enabled: false },
      { type: 'separator' },
      { label: runtime?.state.pending ? 'MCP 更新将在退出并重新打开后生效' : `桌面更新：${updateState}`, enabled: false },
      ...(updateError ? [{ label: `更新失败：${updateError.slice(0, 80)}`, enabled: false }] : []),
      { label: `${PRODUCT_NAME} ${app.getVersion()}`, enabled: false },
    ],
  };
}
function menuPayload(id: string) {
  const menus = desktopMenus() as Record<string, any[]>;
  if (!menus[id]) throw new Error('Invalid menu');
  return { id, label: id[0].toUpperCase() + id.slice(1), items: menus[id] };
}
function templateFrom(items: any[]) {
  return items.map(item => {
    if (item.type === 'separator') return { type: 'separator' };
    if (!item.id) return { label: item.label, enabled: false };
    if (MENU_ROLES[item.id]) return { role: MENU_ROLES[item.id], label: item.label };
    const entry: any = { label: item.label, enabled: item.enabled !== false, click: () => runCommand(item.id) };
    if (item.accelerator) entry.accelerator = item.accelerator;
    if (typeof item.checked === 'boolean') { entry.type = 'checkbox'; entry.checked = item.checked; }
    return entry;
  });
}
function menu() {
  const items: any[] = [
    { label: `打开 ${PRODUCT_NAME}`, click: show },
    { label: '打开文件夹…', click: async () => {
      await ensureShown();
      const current = liveWindow();
      if (!current || !trustedPage(current.webContents.getURL(), devUrl)) return;
      const grant = await chooseFolder();
      const opened = liveWindow();
      if (grant && opened && trustedPage(opened.webContents.getURL(), devUrl)) opened.webContents.send('aichat-desktop:folder-selected', grant.path);
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
  const bar = desktopMenus();
  applicationMenu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: PRODUCT_NAME, submenu: [{ label: `关于 ${PRODUCT_NAME}`, enabled: false }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }] }] : []),
    { label: 'File', submenu: templateFrom(bar.file) },
    { label: 'Edit', submenu: templateFrom(bar.edit) },
    { label: 'View', submenu: templateFrom(bar.view) },
    { label: 'Help', submenu: templateFrom(bar.help) },
  ]);
  Menu.setApplicationMenu(applicationMenu);
  const current = liveWindow();
  if (current && process.platform !== 'darwin') current.setMenu(null);
}
async function chooseFolder() {
  const parent = liveWindow();
  const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : files.grant(result.filePaths[0]);
}
function clearTerminals() { terminals.closeAll(); terminalIds.clear(); }
function setupBridge() {
  ipcMain.handle('aichat-desktop:v1', async (event, method, args = {}) => {
    const current = liveWindow();
    if (!current) throw new Error('window closed');
    assertSender(event, current.webContents, devUrl);
    if (!args || typeof args !== 'object') throw new Error('Invalid request');
    if (method === 'theme') {
      if (!['light', 'dark'].includes(args.theme)) throw new Error('Invalid theme');
      nativeTheme.themeSource = args.theme;
      current.setTitleBarOverlay({ ...titlebarColors(args.theme), height: 34 });
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
    if (method === 'menu') return menuPayload(String(args.id || ''));
    if (method === 'command') {
      const id = String(args.id || '');
      if (!HOST_COMMANDS.has(id) && !PAGE_COMMANDS.has(id)) throw new Error('Invalid command');
      runCommand(id); return;
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
          const answer = await dialog.showMessageBox(current, { message: `使用默认应用打开 ${path.basename(target)}？`, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
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
function openWindow() {
  const created = new BrowserWindow({ title: PRODUCT_NAME, icon: appIcon, width: 1360, height: 900, show: false,
    backgroundColor: settings.theme === 'dark' ? '#0a0a0f' : '#ffffff',
    titleBarStyle: 'hidden', titleBarOverlay: { ...titlebarColors(settings.theme), height: 34 },
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: 'persist:aichat', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, webviewTag: false } });
  win = created;
  if (process.platform !== 'darwin') created.setMenu(null);
  created.on('page-title-updated', event => event.preventDefault());
  // Destroy past the page's beforeunload so the renderer process is released. Quit still closes normally.
  created.on('close', event => {
    if (quitting || created.isDestroyed()) return;
    event.preventDefault();
    clearTerminals();
    try { created.webContents.session.flushStorageData(); } catch { /* page already gone */ }
    created.destroy();
  });
  created.on('closed', () => {
    if (win === created) win = undefined;
    if (!quitting) tray?.setToolTip(closedTip);
  });
  created.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clearTerminals(); });
  created.webContents.on('will-navigate', (e, url) => { if (!trustedPage(url, devUrl)) { e.preventDefault(); if (externalUrl(url)) void shell.openExternal(url); } });
  created.webContents.on('will-redirect', (e, url, _inPlace, mainFrame) => { if (mainFrame && !trustedPage(url, devUrl)) e.preventDefault(); });
  created.webContents.setWindowOpenHandler(({ url }) => { if (externalUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
  const session = created.webContents.session;
  session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === created.webContents && details.isMainFrame === true && trustedPage(details.embeddingOrigin || '', devUrl) && ['clipboard-sanitized-write'].includes(permission));
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (created.isDestroyed() || contents !== created.webContents || !details.isMainFrame || !trustedPage(details.requestingUrl, devUrl)
        || !['media', 'notifications', 'clipboard-sanitized-write'].includes(permission)) return callback(false);
    const answer = await dialog.showMessageBox(created, { message: `允许 AIChat 使用 ${permission}？`, buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0 });
    callback(answer.response === 1);
  });
  return created.loadURL(devUrl || ENTRY).catch(() => {
    // No native privileges on this offline error page. Reload retries the official entry.
    if (!created.isDestroyed()) void dialog.showMessageBox(created, { message: '无法连接 AIChat，请检查网络后从菜单重新加载。' });
  }).then(() => {
    if (!created.isDestroyed()) { created.show(); created.focus(); tray?.setToolTip(PRODUCT_NAME); }
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
    appIcon = nativeImage.createFromPath(path.join(__dirname, 'keepwork.png'));
    if (process.platform === 'darwin') app.dock?.setIcon(appIcon);
    setupBridge();
    const icon = appIcon.resize({ width: process.platform === 'darwin' ? 22 : 16 });
    tray = new Tray(icon); tray.setToolTip(PRODUCT_NAME); tray.on('click', show); menu();
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => { updateState = 'checking'; menu(); });
    autoUpdater.on('update-not-available', () => { updateState = 'current'; menu(); });
    autoUpdater.on('update-downloaded', () => { updateState = 'pending restart'; menu(); });
    autoUpdater.on('error', e => { updateError = e.message; menu(); });
    if (process.argv.includes('--background')) tray.setToolTip(closedTip);
    else await ensureShown();
    if (!disableDevMcp) void runtime.start().then(menu).catch((e: Error) => { updateError = e.message; menu(); });
    setTimeout(() => { void checkUpdates(); }, 15000).unref();
    setInterval(() => { void checkUpdates(); }, 6 * 60 * 60 * 1000).unref();
  });
  app.on('activate', show);
  app.on('window-all-closed', () => { /* Tray and Keepwork MCP stay after the window is destroyed. */ });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; clearTerminals(); developmentServer?.close();
    void (async () => {
      try { await runtime?.restarting; await runtime?.starting; } catch { /* Finish shutdown after failed startup. */ }
      await runtime?.stop();
    })().finally(() => app.quit());
  });
}
