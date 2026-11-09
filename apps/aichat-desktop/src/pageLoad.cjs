// Electron's loadURL waits for images and subframes. Startup only needs the
// main document: its deferred/module scripts have run by dom-ready.
function loadPage(win, url, { timeoutMs = 20000, ready = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const contents = win.webContents;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener('dom-ready', onReady);
      contents.removeListener('did-fail-load', onFailed);
      contents.removeListener('destroyed', onClosed);
    };
    const finish = error => {
      if (settled) return;
      settled = true; cleanup();
      if (error) { reject(error); return; }
      try { ready(); resolve(); } catch (error) { reject(error); }
    };
    const onReady = () => finish();
    const onFailed = (_event, code, description, _url, mainFrame) => {
      if (mainFrame) finish(new Error(`AIChat 连接失败：${description} (${code})`));
    };
    const onClosed = () => finish(new Error('窗口已关闭'));
    const timer = setTimeout(() => {
      finish(new Error('AIChat 主页面连接超时（20 秒），请检查网络后重试。'));
      if (!win.isDestroyed()) contents.stop();
    }, timeoutMs);
    contents.on('dom-ready', onReady);
    contents.on('did-fail-load', onFailed);
    contents.on('destroyed', onClosed);
    // Keep a rejection handler even after dom-ready; a late subresource failure
    // must never become an unhandled rejection or reopen the startup window.
    try { Promise.resolve(win.loadURL(url)).then(onReady, finish); }
    catch (error) { finish(error); }
  });
}
module.exports = { loadPage };
