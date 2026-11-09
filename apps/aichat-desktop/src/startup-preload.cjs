const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const stage = document.getElementById('stage'), error = document.getElementById('error'), retry = document.getElementById('retry');
  const render = value => { stage.textContent = value.stage; error.textContent = value.error; retry.disabled = value.busy; };
  ipcRenderer.on('aichat-startup:status', (_event, value) => render(value));
  void ipcRenderer.invoke('aichat-startup:v1', 'status').then(render);
  retry.onclick = () => { retry.disabled = true; void ipcRenderer.invoke('aichat-startup:v1', 'retry').catch(() => { retry.disabled = false; }); };
  document.getElementById('dashboard').onclick = () => { void ipcRenderer.invoke('aichat-startup:v1', 'dashboard'); };
});
