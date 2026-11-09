const path = require('node:path');
const { pathToFileURL } = require('node:url');
// A separate local page: it has no AIChat/native files bridge, and no URL inputs.
function createStartupWindow({ BrowserWindow, ipcMain, shell }, directory, retry) {
  let win, state = { stage: '检查服务', error: '', busy: true }, running = false;
  const url = pathToFileURL(path.join(directory, 'startup.html')).href;
  function valid(event) {
    return win && !win.isDestroyed() && event.sender === win.webContents
      && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === url;
  }
  ipcMain.handle('aichat-startup:v1', async (event, action) => {
    if (!valid(event)) throw Error('Untrusted startup caller');
    if (action === 'status') return state;
    if (action === 'dashboard') return shell.openExternal('http://127.0.0.1:8089/dashboard');
    if (action === 'retry' && !running && !state.busy) {
      running = true;
      try { await retry(); } finally { running = false; }
      return;
    }
  });
  return {
    open() {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
      win = new BrowserWindow({ title: '准备 KeepWork 第二大脑', width: 560, height: 390, resizable: false,
        webPreferences: { preload: path.join(directory, 'startup-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-redirect', event => event.preventDefault());
      void win.loadURL(url);
    },
    update(stage, error = '') {
      state = { stage, error, busy: !error };
      if (win && !win.isDestroyed()) win.webContents.send('aichat-startup:status', state);
    },
    close() { if (win && !win.isDestroyed()) win.destroy(); win = undefined; },
    dispose() { this.close(); ipcMain.removeHandler('aichat-startup:v1'); },
  };
}
module.exports = { createStartupWindow };
