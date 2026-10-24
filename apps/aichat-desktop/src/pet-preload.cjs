const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  const channel = 'aichat-desktop:pet-v1';
  const actions = new Set(['state', 'hit-test', 'open', 'menu', 'exit-cancel', 'exit-confirm', 'expand', 'drag-start', 'drag', 'drag-end', 'toggle-target', 'input', 'send', 'stop', 'dictation', 'call', 'mute']);
  contextBridge.exposeInMainWorld('desktopPet', Object.freeze({
    action: (action, args = {}) => {
      if (!actions.has(action)) return Promise.reject(new Error('Invalid pet action'));
      return ipcRenderer.invoke(channel, action, args);
    },
    subscribe: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  }));
}
