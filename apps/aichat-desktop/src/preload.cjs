const { contextBridge, ipcRenderer } = require('electron');
// Electron only installs this preload on the application window; children get none.
if (process.isMainFrame) {
  const call = (method, args = {}) => ipcRenderer.invoke('aichat-desktop:v1', method, args);
  // App chrome lives in an isolated shadow root, not in AIChat's replaceable #app.
  if (typeof document !== 'undefined') window.addEventListener('DOMContentLoaded', async () => {
    try {
      const config = await call('titlebar'); // Main process validates the exact top-level URL.
      const host = document.createElement('div');
      host.id = 'keepwork-desktop-titlebar';
      host.style.cssText = 'position:fixed;inset:0 0 auto 0;height:34px;z-index:2147483647';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{font:12px system-ui;color:var(--chrome-text,#1a1a2e)}header{height:34px;display:flex;align-items:center;gap:4px;background:var(--chrome-bg,#f2f3f7);-webkit-app-region:drag;padding:0 145px 0 10px;box-sizing:border-box}img{width:18px;height:18px;margin-right:8px}button{border:0;background:transparent;color:inherit;font:inherit;padding:5px 10px;border-radius:4px;-webkit-app-region:no-drag;cursor:pointer;white-space:nowrap}button:hover,button:focus-visible{background:var(--chrome-hover,#e2e6ef)}.center{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-width:0}.title{white-space:nowrap}.address{color:var(--chrome-address,#4a4a5a);background:var(--chrome-pill,#e2e6ef)}.refresh{width:28px;height:28px;padding:5px;display:grid;place-items:center}.refresh svg{width:16px;height:16px}@media(max-width:850px){.title{display:none}}';
      const header = document.createElement('header');
      if (config.platform === 'darwin') header.style.paddingLeft = '80px';
      const icon = document.createElement('img'); icon.src = config.icon; icon.alt = ''; header.append(icon);
      ['文件', '编辑', '视图'].forEach((label, index) => {
        const button = document.createElement('button'); button.textContent = label; button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('click', () => { void call('menu', { index }); }); header.append(button);
      });
      const center = document.createElement('div'); center.className = 'center';
      const title = document.createElement('span'); title.className = 'title'; title.textContent = 'KeepWork 第二大脑';
      const address = document.createElement('button'); address.className = 'address'; address.textContent = config.address;
      address.title = '在外部浏览器打开'; address.setAttribute('aria-label', `在外部浏览器打开 ${config.address}`);
      address.addEventListener('click', () => { void call('openEntry'); });
      const refresh = document.createElement('button'); refresh.className = 'refresh'; refresh.title = '刷新页面'; refresh.setAttribute('aria-label', '刷新页面');
      refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 12 17.7 6.3"/></svg>';
      refresh.addEventListener('click', () => { void call('reloadPage'); });
      center.append(title, address, refresh); header.append(center);
      shadow.append(style, header);
      const layout = document.createElement('style');
      // #app has auto height, so the shell must use the viewport, not a percentage.
      layout.textContent = 'body{height:calc(100vh - 34px)!important;transform:translateY(34px);position:relative;box-sizing:border-box!important}.app-shell{height:calc(100vh - 34px)!important}';
      document.head.append(layout); document.documentElement.append(host);
      let lastTheme;
      const syncTheme = () => {
        const theme = document.body.classList.contains('light') ? 'light' : 'dark';
        if (theme === lastTheme) return;
        lastTheme = theme;
        const values = theme === 'light'
          ? ['#1a1a2e', '#f2f3f7', '#e2e6ef', '#4a4a5a', '#e2e6ef']
          : ['#d4d4dc', '#18181f', '#34343e', '#aebdd6', '#22222c'];
        ['text', 'bg', 'hover', 'address', 'pill'].forEach((key, i) => host.style.setProperty('--chrome-' + key, values[i]));
        void call('theme', { theme }).catch(() => {});
      };
      new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      syncTheme();
    } catch { /* Untrusted/offline documents never receive native chrome controls. */ }
  }, { once: true });
  contextBridge.exposeInMainWorld('aichatDesktop', Object.freeze({
    version: 1, capabilities: Object.freeze({ files: true, terminal: true }),
    roots: () => call('roots'), pickFolder: () => call('pickFolder'),
    revokeFolder: rootId => call('revokeFolder', { rootId }),
    file: (op, args) => call('file', { ...args, op }),
    terminal: (op, args) => call('terminal', { ...args, op }),
    status: () => call('status'), checkUpdates: () => call('checkUpdates'),
    onFolderSelected: callback => {
      const listener = (_event, selected) => { if (typeof selected === 'string') callback(selected); };
      ipcRenderer.on('aichat-desktop:folder-selected', listener);
      return () => ipcRenderer.removeListener('aichat-desktop:folder-selected', listener);
    },
  }));
}
