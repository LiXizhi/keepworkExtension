import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { TerminalSessionManager } from '../../../src/core/terminalSessions';
const { NativeFiles, atomicJson } = require('./files.cjs');
const { defaultBrainFolder } = require('./brainFolder.cjs');
const { checkGit, installGit } = require('./gitSetup.cjs');
const { createUpdateWindow } = require('./updateWindow.cjs');
const { createPetWindow } = require('./petWindow.cjs');
const { RuntimeSupervisor } = require('./runtime.cjs');
const { ENTRY, trustedPage, assertSender, externalUrl } = require('./security.cjs');
const { MediaGrants, installPermissions } = require('./permissions.cjs');
let devUrl = !app.isPackaged ? process.env.AICHAT_DESKTOP_DEV_URL || '' : '';
let developmentServer: { close: () => void } | undefined;
let applicationMenu: Menu;
const disableDevMcp = !app.isPackaged && process.env.AICHAT_DESKTOP_DISABLE_MCP === '1';
if (devUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(devUrl)) throw new Error('Development URL must be loopback HTTP');
app.setAppUserModelId('com.keepwork.aichat-desktop');
const PRODUCT_NAME = 'KeepWork 第二大脑';
const MAC_APP_NAME = 'Keepwork';
if (process.platform === 'darwin') app.setName(MAC_APP_NAME);
// Keep the original profile across product renames; explicit test/user profiles win.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'AIChat Desktop' : 'aichat-desktop'));
}
let win: BrowserWindow | undefined, tray: Tray, quitting = false, runtime: any, modelRuntime: any, files: any;
let runtimeHeartbeat: ReturnType<typeof setInterval> | undefined;
let opening: Promise<void> | null = null;
let appIcon: ReturnType<typeof nativeImage.createFromPath> | undefined;
const closedTip = `${PRODUCT_NAME}（窗口已关闭，点击重新打开）`;
let updateState = 'idle', updateError = '', updateProgress = 0, checking: Promise<void> | null = null;
let floatingPet: any;
let updatesWindow: any, shellLatest: any, shellCheckedAt = '', updateActionBusy = false;
let shellStale = false;
const terminals = new TerminalSessionManager();
const terminalIds = new Set<string>();
let settingsFile: string;
let mediaGrants: InstanceType<typeof MediaGrants>;
let settings = { openAtLogin: false, theme: 'light', petVisible: true, petPosition: null as null | { x: number; y: number }, petPreferences: { scale: 1, appearance: 'current' } };
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
  if (serviceBusy || updateActionBusy || disableDevMcp) return;
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
async function checkRuntimeHeartbeat() {
  if (disableDevMcp || quitting || serviceBusy || updateActionBusy || runtime?.restarting) return;
  const supervisors = [
    ['mcp', runtime],
    ['local-model', modelRuntime],
  ] as const;
  for (const [name, supervisor] of supervisors) {
    if (!supervisor) continue;
    try {
      await supervisor.refresh();
      if (serviceBusy || updateActionBusy || runtime?.restarting || quitting) return;
      if (!['running', 'attached'].includes(supervisor.state?.state)) await supervisor.start();
    } catch (error) {
      console.warn(`${name} heartbeat recovery failed:`, error);
    }
  }
}
function startRuntimeHeartbeat() {
  runtimeHeartbeat = setInterval(() => { void checkRuntimeHeartbeat(); }, 60_000);
  runtimeHeartbeat.unref?.();
}
function ensureShown() {
  floatingPet?.hide();
  const current = liveWindow();
  if (current) {
    if (current.isMinimized()) current.restore();
    current.show(); current.focus();
    if (current.webContents.isCrashed?.()) return current.loadURL(devUrl || ENTRY).catch((error: Error) => dialog.showErrorBox(PRODUCT_NAME, error.message));
    return Promise.resolve();
  }
  if (!opening) opening = openWindow().finally(() => { opening = null; });
  return opening;
}
function updatesSnapshot() {
  const mcp = runtime?.updateSnapshot() || { state: 'unavailable' };
  return { checking: !!checking, mcp: { ...mcp,
    state: updateActionBusy && serviceBusy ? 'applying' : mcp.state,
    canApply: !updateActionBusy && !serviceBusy && (['available', 'ready'].includes(mcp.state) || (mcp.state === 'error' && !!runtime?.record.pending)) },
    desktop: { state: app.isPackaged ? updateState : 'unavailable', currentVersion: app.getVersion(),
      latest: shellLatest, checkedAt: shellCheckedAt, stale: shellStale, progress: updateProgress, error: updateError,
      canApply: !updateActionBusy && ['available', 'pending restart'].includes(updateState) } };
}
function openUpdates() { updatesWindow?.open(); }
function persistShellMetadata() {
  if (settingsFile) atomicJson(path.join(path.dirname(settingsFile), 'update-metadata.json'), { latest: shellLatest, checkedAt: shellCheckedAt });
}
function receiveShellMetadata(info: any) {
  shellLatest = { version: info.version, releaseDate: info.releaseDate };
  shellCheckedAt = new Date().toISOString(); shellStale = false; persistShellMetadata();
}
function mcpUpdateChanged(snapshot: any) {
  notifyUpdateStatus();
  if (snapshot.state !== 'ready' || !runtime?.record.pending || runtime.record.notified === runtime.record.pending) return;
  runtime.record.notified = runtime.record.pending; runtime.save();
  if (Notification.isSupported()) {
    const notification = new Notification({ title: 'Keepwork MCP 更新已就绪', body: `版本 ${snapshot.pending?.version || ''} 已下载。点击查看并确认更新，或在下次启动时生效。` });
    notification.on('click', openUpdates); notification.show();
  }
}
async function confirmUpdate(message: string, detail: string) {
  const answer = await dialog.showMessageBox({ title: '检查更新', message, detail,
    buttons: ['稍后', '立即更新'], defaultId: 0, cancelId: 0 });
  return answer.response === 1;
}
async function applyMcpUpdate() {
  if (updateActionBusy || serviceBusy || disableDevMcp) return;
  updateActionBusy = true; notifyUpdateStatus();
  try {
    if (runtime.checking) await runtime.checking;
    if (!runtime.record.pending) await runtime.check();
    if (!runtime.record.pending) return;
    if (!await confirmUpdate('现在重启 MCP 并更新？', '正在执行的 MCP 操作会被中断。桌面窗口保持打开；选择稍后将在退出应用并重新启动后更新。')) return;
    if (quitting) return;
    serviceBusy = true; runtime.setUpdate({ state: 'applying', error: '' });
    await runtime.restart(true);
    if (runtime.record.pending) throw new Error('更新尚未生效：当前服务由其他进程管理，请在管理应用中停止服务后重试。');
    if (!runtime.record.rollbackError) runtime.setUpdate({ state: 'current', error: '', progress: 100 });
  } catch (error) { runtime.setUpdate({ state: 'error', error: String(error) }); }
  finally { serviceBusy = false; updateActionBusy = false; menu(); notifyUpdateStatus(); }
}
async function applyDesktopUpdate() {
  if (updateActionBusy || !app.isPackaged) return;
  updateActionBusy = true; notifyUpdateStatus();
  try {
    if (updateState === 'available') await autoUpdater.downloadUpdate();
    if (updateState === 'pending restart' && await confirmUpdate('退出并更新桌面应用？', '应用将关闭并安装已下载的新版本。')) autoUpdater.quitAndInstall();
  } catch (error) { updateError = String(error); setUpdateState('error'); }
  finally { updateActionBusy = false; notifyUpdateStatus(); }
}
async function checkUpdates() {
  if (disableDevMcp) return;
  if (updateActionBusy) return;
  if (checking) return checking;
  checking = (async () => {
    const jobs = [runtime.check()];
    if (app.isPackaged) jobs.push(autoUpdater.checkForUpdates().catch((error: Error) => {
      updateError = error.message; shellStale = true; setUpdateState('error');
    }));
    await Promise.allSettled(jobs);
  })().finally(() => { checking = null; menu(); notifyUpdateStatus(); });
  notifyUpdateStatus();
  return checking;
}
function updatePayload() {
  return { state: updateState, progress: updateProgress, error: updateError || '', mcp: runtime?.updateSnapshot() };
}
function notifyUpdateStatus() {
  updatesWindow?.send();
  const current = liveWindow();
  if (current && trustedPage(current.webContents.getURL(), devUrl)) current.webContents.send('aichat-desktop:update-status', updatePayload());
}
function setUpdateState(state: string, progress = 0) {
  updateState = state; updateProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  menu(); notifyUpdateStatus();
}
const PAGE_COMMANDS = new Set(['new-chat', 'toggle-sidebar', 'toggle-files', 'open-settings', 'experience-simple', 'experience-professional', 'theme-light', 'theme-dark']);
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
  if (id === 'check-updates') { openUpdates(); return; }
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
      { id: 'check-updates', label: '检查更新…' },
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
      { id: 'experience-simple', label: '简洁模式', check: true },
      { id: 'experience-professional', label: '专业模式', check: true },
      { type: 'separator' },
      { id: 'theme-light', label: '浅色外观', check: true },
      { id: 'theme-dark', label: '深色外观', check: true },
      { type: 'separator' },
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
      { id: 'check-updates', label: '检查更新…' },
      { type: 'separator' },
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
    { label: '显示桌面宠物', type: 'checkbox', checked: settings.petVisible, click: (item: any) => {
      settings.petVisible = item.checked; atomicJson(settingsFile, settings);
      if (!item.checked) floatingPet?.hide(true);
      else if (liveWindow() && !liveWindow()!.isVisible()) floatingPet?.show();
      else if (!liveWindow() && !opening) opening = openWindow(true).finally(() => { opening = null; });
      menu();
    } },
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
    { label: '检查更新…', click: openUpdates },
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
    ...(process.platform === 'darwin' ? [{ label: MAC_APP_NAME, submenu: [{ label: `关于 ${PRODUCT_NAME}`, enabled: false }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }] }] : []),
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
    if (method === 'petState') return floatingPet?.update(args);
    if (method === 'petResult') return floatingPet?.result(args);
    if (method === 'theme') {
      if (!['light', 'dark'].includes(args.theme)) throw new Error('Invalid theme');
      nativeTheme.themeSource = args.theme;
      const colors = titlebarColors(args.theme);
      if (typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color)) colors.color = args.color;
      if (typeof args.symbolColor === 'string' && /^#[0-9a-f]{6}$/i.test(args.symbolColor)) colors.symbolColor = args.symbolColor;
      if (process.platform !== 'darwin' && typeof current.setTitleBarOverlay === 'function') {
        current.setTitleBarOverlay({ ...colors, height: 34 });
      }
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
    if (method === 'status') return { version: app.getVersion(), mcp: runtime.state, shell: updateState, progress: updateProgress, error: updateError };
    if (method === 'checkUpdates') { await checkUpdates(); return { mcp: runtime.state, shell: updateState, progress: updateProgress, error: updateError }; }
    if (method === 'installUpdate') {
      if (updateState !== 'pending restart') return updatePayload();
      await applyDesktopUpdate();
      return updatePayload();
    }
    if (method === 'file') {
      if (args.op === 'reveal') {
        const target = files.resolve(args.rootId, args.rel, { followLinks: true });
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
function openWindow(startHidden = false) {
  let keepHidden = startHidden;
  const created = new BrowserWindow({ title: PRODUCT_NAME, icon: appIcon, width: 1360, height: 900, show: false,
    backgroundColor: settings.theme === 'dark' ? '#0a0a0f' : '#ffffff',
    titleBarStyle: 'hidden', titleBarOverlay: { ...titlebarColors(settings.theme), height: 34 },
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: 'persist:aichat', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, webviewTag: false } });
  win = created;
  if (process.platform !== 'darwin') created.setMenu(null);
  created.on('page-title-updated', event => event.preventDefault());
  // Keep one page/runtime alive: the pet is only a projection of this window.
  created.on('close', event => {
    if (quitting || created.isDestroyed()) return;
    event.preventDefault();
    keepHidden = true;
    created.hide();
    if (settings.petVisible) floatingPet?.show();
    else floatingPet?.hide(true);
    tray?.setToolTip(`${PRODUCT_NAME}（后台运行）`);
  });
  created.on('closed', () => {
    if (win === created) win = undefined;
    if (!quitting) tray?.setToolTip(closedTip);
  });
  created.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { clearTerminals(); floatingPet?.reset(); } });
  created.webContents.on('will-navigate', (e, url) => { if (!trustedPage(url, devUrl)) { e.preventDefault(); if (externalUrl(url)) void shell.openExternal(url); } });
  created.webContents.on('will-redirect', (e, url, _inPlace, mainFrame) => { if (mainFrame && !trustedPage(url, devUrl)) e.preventDefault(); });
  created.webContents.setWindowOpenHandler(({ url }) => { if (externalUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
  created.webContents.on('render-process-gone', () => floatingPet?.reset());
  installPermissions(created, mediaGrants, () => devUrl, dialog);
  return created.loadURL(devUrl || ENTRY).catch(() => {
    // No native privileges on this offline error page. Reload retries the official entry.
    if (!created.isDestroyed()) void dialog.showMessageBox(created, { message: '无法连接 AIChat，请检查网络后从菜单重新加载。' });
  }).then(() => {
    if (!created.isDestroyed()) {
      if (!keepHidden) { created.show(); created.focus(); tray?.setToolTip(PRODUCT_NAME); }
      else if (!created.isVisible() && settings.petVisible) floatingPet?.show();
    }
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
    mediaGrants = new MediaGrants(path.join(home, 'media-grants.json'));
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first launch */ }
    nativeTheme.themeSource = settings.theme === 'dark' ? 'dark' : 'light';
    files = new NativeFiles(path.join(home, 'folder-grants.json'));
    const target = `${process.platform === 'win32' ? 'windows' : 'macos'}-${process.arch}`;
    const stagedRuntime = path.resolve(__dirname, '../../mcp-runtime/staging', target);
    const stagedModelRuntime = path.resolve(__dirname, '../../local-model-runtime/runtime-staging', target);
    runtime = new RuntimeSupervisor(path.join(home, 'mcp-runtimes'), app.isPackaged ? path.join(process.resourcesPath, 'mcp-runtime') : process.env.AICHAT_MCP_RUNTIME_DIR || (fs.existsSync(path.join(stagedRuntime, 'runtime.json')) ? stagedRuntime : ''), app.getVersion(), {}, { onUpdate: mcpUpdateChanged });
    modelRuntime = new RuntimeSupervisor(path.join(home, 'local-model-runtimes'), app.isPackaged ? path.join(process.resourcesPath, 'local-model-runtime') : process.env.KP_LOCAL_MODEL_RUNTIME_DIR || (fs.existsSync(path.join(stagedModelRuntime, 'runtime.json')) ? stagedModelRuntime : ''), app.getVersion(), {}, {
      product: 'keepwork-local-model-node-runtime', entry: 'app/dist/src/cli.js', port: 18089, healthPath: '/v1/health', updates: false,
      matcher: (body: any) => body.service === 'keepwork-local-model' && body.protocolVersion === '1.0.0',
    });
    appIcon = nativeImage.createFromPath(path.join(__dirname, 'keepwork.png'));
    if (process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(path.join(__dirname, 'keepwork-mac.png')));
    }
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(home, 'update-metadata.json'), 'utf8'));
      shellLatest = stored.latest; shellCheckedAt = stored.checkedAt; shellStale = true;
    } catch { /* no cached release information */ }
    updatesWindow = createUpdateWindow({ BrowserWindow, ipcMain }, __dirname, {
      status: updatesSnapshot, check: checkUpdates, mcp: applyMcpUpdate, desktop: applyDesktopUpdate,
    });
    floatingPet = createPetWindow({ BrowserWindow, ipcMain, screen, Menu }, __dirname, {
      preferences: () => settings.petPreferences,
      savePreferences: (value: { scale: number; appearance: string }) => { settings.petPreferences = value; atomicJson(settingsFile, settings); },
      appearance: () => { void shell.openExternal('https://keepwork.com/api/raw/official/apps/MagicHaqi/release/MagicHaqi_v1.html'); },
      hide: () => { settings.petVisible = false; atomicJson(settingsFile, settings); floatingPet?.hide(true); menu(); },
      quit: () => app.quit(),
      sharedRuntime: () => runtime?.state.owner !== 'desktop',
      position: () => settings.petPosition,
      savePosition: (position: { x: number; y: number }) => { settings.petPosition = position; atomicJson(settingsFile, settings); },
      open: show,
      command: (command: unknown) => {
        const current = liveWindow();
        if (!current || !trustedPage(current.webContents.getURL(), devUrl)) throw new Error('AIChat unavailable');
        current.webContents.send('aichat-desktop:pet-command', command);
      },
    });
    setupBridge();
    const icon = appIcon.resize({ width: process.platform === 'darwin' ? 22 : 16 });
    tray = new Tray(icon); tray.setToolTip(PRODUCT_NAME); tray.on('click', show); menu();
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => { updateError = ''; setUpdateState('checking'); });
    autoUpdater.on('update-available', info => { receiveShellMetadata(info); updateError = ''; setUpdateState('downloading'); });
    autoUpdater.on('download-progress', info => { setUpdateState('downloading', info?.percent); });
    autoUpdater.on('update-not-available', info => { receiveShellMetadata(info); updateError = ''; setUpdateState('current'); });
    autoUpdater.on('update-downloaded', info => { receiveShellMetadata(info); updateError = ''; setUpdateState('pending restart', 100); });
    autoUpdater.on('error', e => { shellStale = true; updateError = e.message; setUpdateState('error'); });
    if (!disableDevMcp) {
      // AIChat probes the local MCP server as soon as the remote page loads. Make
      // the server ready first so its one-shot initial discovery includes tools
      // such as run_terminal instead of caching an offline result for the chat.
      try { await runtime.start(); }
      catch (e: unknown) { updateError = e instanceof Error ? e.message : String(e); }
      menu();
    }
    if (process.argv.includes('--background')) tray.setToolTip(closedTip);
    else await ensureShown();
    if (!disableDevMcp) {
      void modelRuntime.start().then(menu).catch((e: Error) => { console.error('local-model startup failed:', e); updateError = e.message; menu(); });
      startRuntimeHeartbeat();
    }
    setTimeout(() => { void checkUpdates(); }, 15000).unref();
    setInterval(() => { void checkUpdates(); }, 6 * 60 * 60 * 1000).unref();
  });
  app.on('activate', show);
  app.on('window-all-closed', () => { /* Tray and Keepwork MCP stay after the window is destroyed. */ });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; floatingPet?.hide(true); floatingPet?.dispose(); clearTerminals(); developmentServer?.close();
    if (runtimeHeartbeat) { clearInterval(runtimeHeartbeat); runtimeHeartbeat = undefined; }
    void (async () => {
      try { await runtime?.restarting; await runtime?.starting; } catch { /* Finish shutdown after failed startup. */ }
      await runtime?.stop();
      await modelRuntime?.stop();
    })().finally(() => app.quit());
  });
}
