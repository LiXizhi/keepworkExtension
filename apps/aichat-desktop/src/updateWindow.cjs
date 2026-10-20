const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CHANNEL = 'aichat-update-window:v1';
function assertUpdateSender(event, window, url) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url) {
    throw new Error('Untrusted update window caller');
  }
}
function createUpdateWindow(electron, directory, actions) {
  const { BrowserWindow, ipcMain } = electron;
  const url = pathToFileURL(path.join(directory, 'updates.html')).href;
  let window;
  ipcMain.handle(CHANNEL, async (event, method) => {
    assertUpdateSender(event, window, url);
    if (!['status', 'check', 'mcp', 'desktop'].includes(method)) throw new Error('Invalid update action');
    return actions[method]();
  });
  return {
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ width: 680, height: 660, minWidth: 560, minHeight: 480,
        title: '检查更新', autoHideMenuBar: true,
        webPreferences: { preload: path.join(directory, 'updates-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('closed', () => { window = undefined; });
      window.webContents.once('did-finish-load', () => { this.send(); void actions.check(); });
      void window.loadURL(url);
    },
    send() { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL, actions.status()); },
  };
}
module.exports = { createUpdateWindow, assertUpdateSender };
