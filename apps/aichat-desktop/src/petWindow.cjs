const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CHANNEL = 'aichat-desktop:pet-v1';
const ACTIONS = new Set(['input', 'send', 'stop', 'dictation', 'call', 'mute']);
const EMPTY = Object.freeze({ version: 1, context: '', title: '打开 AIChat 开始聊天', draft: '', messages: [], ready: false });
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
function projectState(value) {
  if (!value || value.version !== 1 || typeof value.context !== 'string') throw new Error('Invalid pet state');
  const pet = value.pet || {};
  let sheetUrl = '';
  try { const url = new URL(pet.sheetUrl); if (url.protocol === 'https:' && url.hostname === 'cdn.keepwork.com' && !url.username && !url.password && !url.search) sheetUrl = url.href; } catch {}
  const percent = value => /^\d+(\.\d+)?% \d+(\.\d+)?%$/.test(value) ? value : '0% 0%';
  return { version: 1, context: text(value.context, 200), title: text(value.title, 160), draft: text(value.draft, 32000),
    ready: value.ready === true, busy: value.busy === true, richDraft: value.richDraft === true,
    attention: text(value.attention, 300), error: text(value.error, 300), dictating: value.dictating === true,
    canCall: value.canCall === true, voice: { active: value.voice?.active === true, muted: value.voice?.muted === true, state: text(value.voice?.state, 32) },
    pet: { name: text(pet.name, 80), sheetUrl, bgSize: percent(pet.bgSize), bgPos: percent(pet.bgPos) },
    messages: (Array.isArray(value.messages) ? value.messages : []).slice(-8).filter(m => ['user', 'assistant'].includes(m?.role))
      .map(m => ({ role: m.role, content: text(m.content, 4000) })) };
}
function assertPetSender(event, window, url) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url) throw new Error('Untrusted pet caller');
}
function clampBounds(position, size, area) {
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
  return { width, height, x: Math.round(Math.max(area.x, Math.min(position.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(position.y, area.y + area.height - height))) };
}
function createPetWindow({ BrowserWindow, ipcMain, screen }, directory, services) {
  const url = pathToFileURL(path.join(directory, 'pet.html')).href;
  let window, visible = false, expanded = false, snapshot = EMPTY, sequence = 0, position = services.position();
  let drag = null, stopped = false, captureBlocked = false, blockedContext = null;
  const pending = new Map();
  const send = () => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL, { ...snapshot, expanded }); };
  const rejectPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('AIChat context changed')); } pending.clear(); };
  function bounds() {
    const fallback = screen.getPrimaryDisplay().workArea;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) position = { x: fallback.x + fallback.width - 144, y: fallback.y + fallback.height - 160 };
    const area = screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) }).workArea;
    const size = expanded ? { width: 360, height: 520 } : { width: 128, height: 144 };
    const target = expanded ? { x: position.x - 232, y: position.y - 376 } : position;
    return clampBounds(target, size, area);
  }
  function layout() { if (window && !window.isDestroyed()) window.setBounds(bounds()); }
  function create() {
    if (window && !window.isDestroyed()) return;
    window = new BrowserWindow({ width: 128, height: 144, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
      webPreferences: { preload: path.join(directory, 'pet-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.on('closed', () => { window = undefined; });
    window.webContents.on('did-finish-load', () => { send(); if (visible) window.showInactive(); });
    void window.loadURL(url).catch(() => { visible = false; });
  }
  function command(action, args) {
    const requestId = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('AIChat did not respond. Open AIChat to continue.')); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      try { services.command({ version: 1, requestId, context: snapshot.context, action, ...args }); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  }
  ipcMain.handle(CHANNEL, async (event, action, args = {}) => {
    assertPetSender(event, window, url);
    if (!args || typeof args !== 'object') throw new Error('Invalid pet request');
    if (action === 'state') return { ...snapshot, expanded };
    if (action === 'open') { services.open(); return; }
    if (!visible) throw new Error('Pet is hidden');
    if (action === 'expand') { expanded = args.expanded === true; layout(); send(); return; }
    if (action === 'hit-test') { window.setIgnoreMouseEvents(args.interactive !== true, { forward: true }); return; }
    if (action === 'drag-start') { drag = { cursor: screen.getCursorScreenPoint(), bounds: window.getBounds() }; return; }
    if (action === 'drag' || action === 'drag-end') {
      if (!drag) return;
      const cursor = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      const next = clampBounds({ x: drag.bounds.x + cursor.x - drag.cursor.x, y: drag.bounds.y + cursor.y - drag.cursor.y }, drag.bounds, area);
      window.setBounds(next);
      position = { x: next.x + (expanded ? 232 : 0), y: next.y + (expanded ? 376 : 0) };
      if (action === 'drag-end') { drag = null; services.savePosition(position); }
      return;
    }
    if (!ACTIONS.has(action) || !snapshot.context || args.context !== snapshot.context) throw new Error('Stale or invalid pet action');
    if (action === 'input' && (typeof args.text !== 'string' || args.text.length > 32000)) throw new Error('Invalid pet text');
    await command(action, action === 'input' ? { text: args.text } : {});
    return { ...snapshot, expanded };
  });
  const displayChanged = () => { layout(); };
  screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged);
  return {
    show() { if (stopped) return; captureBlocked = false; visible = true; expanded = false; create(); layout(); send(); window.showInactive(); },
    hide(stopVoice = false) {
      visible = false; captureBlocked = stopVoice; drag = null; window?.hide();
      if (stopVoice) { captureBlocked = true; blockedContext = snapshot.context; try { services.command({ version: 1, action: 'hide', context: snapshot.context }); } catch {} }
    },
    update(value) { const next = projectState(value); if (next.context !== snapshot.context) rejectPending(); snapshot = next; send();
      if (captureBlocked && blockedContext !== next.context) { blockedContext = next.context; try { services.command({ version: 1, action: 'hide', context: next.context }); } catch {} }
    },
    result(value) { const item = pending.get(value.requestId); if (!item) return; pending.delete(value.requestId); clearTimeout(item.timer); value.ok ? item.resolve() : item.reject(new Error(text(value.error, 300) || 'Pet action failed')); },
    reset() { snapshot = EMPTY; rejectPending(); send(); },
    dispose() { stopped = true; visible = false; rejectPending(); window?.destroy(); screen.removeListener('display-removed', displayChanged); screen.removeListener('display-metrics-changed', displayChanged); ipcMain.removeHandler(CHANNEL); },
  };
}
module.exports = { createPetWindow, projectState, clampBounds, assertPetSender };
