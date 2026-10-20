const { contextBridge, ipcRenderer } = require('electron');
const channel = 'aichat-update-window:v1';
contextBridge.exposeInMainWorld('updates', {
  status: () => ipcRenderer.invoke(channel, 'status'),
  check: () => ipcRenderer.invoke(channel, 'check'),
  mcp: () => ipcRenderer.invoke(channel, 'mcp'),
  desktop: () => ipcRenderer.invoke(channel, 'desktop'),
  subscribe: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
