// Run with the extracted Electron from package_test.go and an isolated profile.
const { app, BrowserWindow, session, net } = require('electron');
const path = require('node:path');
const { installAppPage } = require('../src/launcher-client.cjs');
const root = process.env.KP_LAUNCHER_SMOKE_ROOT;
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Timed out loading packaged AIChat'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const partition = 'smoke';
  const ses = session.fromPartition(partition);
  installAppPage(ses, net, path.join(root, 'web'));
  // Permit local page and pinned boot scripts only. Chat APIs may be offline.
  const originalFetch = ses.fetch.bind(ses);
  ses.fetch = (input, options) => {
    if (options?.bypassCustomProtocolHandlers) return Promise.resolve(new Response(null,{status:503}));
    return originalFetch(input, options);
  };
  const win = new BrowserWindow({show:false, webPreferences:{partition, sandbox:true, contextIsolation:true}});
  win.webContents.on('console-message', (_e, ...args) => { if (process.env.KP_LAUNCHER_SMOKE_DEBUG) console.error(...args); });
  await win.loadURL('https://keepwork.com/chat');
  const status = await win.webContents.executeJavaScript(`(async () => ({
    origin: location.origin, sdk: await new Promise(resolve => { let count = 0; const timer = setInterval(() => {
      if (window.keepwork || ++count >= 60) { clearInterval(timer); resolve(!!window.keepwork); }
    }, 100); }),
    styles: document.querySelector('link[rel=stylesheet]')?.sheet != null,
    module: typeof (await import('./js/package_registry.js')).initializePackages
  }))()`);
  if (status.origin !== 'https://keepwork.com' || !status.sdk || !status.styles || status.module !== 'function') throw Error(JSON.stringify(status));
  clearTimeout(timeout);app.exit(0);
}).catch(error => { console.error(error);app.exit(1); });
