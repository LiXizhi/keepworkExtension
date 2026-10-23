const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CHANNEL = 'aichat-desktop:pet-v1';
const ACTIONS = new Set(['input', 'send', 'stop', 'dictation', 'call', 'mute']);
const EMPTY = Object.freeze({ version: 1, context: '', title: '打开 AIChat 开始聊天', draft: '', messages: [], ready: false });
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const PET_SIZES = [0.5, 1, 1.5, 2, 3, 4];
function petPreferences(value = {}) {
  return { scale: PET_SIZES.includes(value?.scale) ? value.scale : 1, appearance: value?.appearance === 'dragon' ? 'dragon' : 'current' };
}
function projectState(value) {
  if (!value || value.version !== 1 || typeof value.context !== 'string') throw new Error('Invalid pet state');
  const pet = value.pet || {};
  const imageData = typeof pet.imageData === 'string' && pet.imageData.length <= 8 * 1024 * 1024 + 64
    && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(pet.imageData) ? pet.imageData : '';
  let sheetUrl = '';
  try { const url = new URL(pet.sheetUrl); if (url.protocol === 'https:' && url.hostname === 'cdn.keepwork.com' && !url.username && !url.password && !url.search) sheetUrl = url.href; } catch {}
  const percent = value => /^\d+(\.\d+)?% \d+(\.\d+)?%$/.test(value) ? value : '0% 0%';
  return { version: 1, context: text(value.context, 200), title: text(value.title, 160), draft: text(value.draft, 32000),
    ready: value.ready === true, busy: value.busy === true, richDraft: value.richDraft === true,
    attention: text(value.attention, 300), error: text(value.error, 300), dictating: value.dictating === true,
    canCall: value.canCall === true, voice: { active: value.voice?.active === true, muted: value.voice?.muted === true, state: text(value.voice?.state, 32) },
    pet: { name: text(pet.name, 80), sheetUrl, imageData, bgSize: percent(pet.bgSize), bgPos: percent(pet.bgPos) },
    reply: value.reply && typeof value.reply === 'object' ? {
      text: text(value.reply.text, 128000), thinking: value.reply.thinking === true, immediate: value.reply.immediate !== false,
      options: (Array.isArray(value.reply.options) ? value.reply.options : []).slice(0, 20)
        .filter(item => item && typeof item.text === 'string' && item.text.trim())
        .map(item => ({ text: text(item.text, 4000), icon: text(item.icon, 32) })),
    } : null,
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
function createPetWindow({ BrowserWindow, ipcMain, screen, Menu }, directory, services) {
  const url = pathToFileURL(path.join(directory, 'pet.html')).href;
  let window, visible = false, expanded = false, snapshot = EMPTY, sequence = 0, position = services.position();
  let drag = null, stopped = false, captureBlocked = false, blockedContext = null;
  let preferences = petPreferences(services.preferences?.()), popup, exitPrompt = null;
  const pending = new Map();
  const view = () => { const { pixels, left, top } = geometry(); return { ...snapshot, expanded, preferences, exitPrompt, petPixels: pixels, petLeft: left, petTop: top }; };
  const send = () => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL, view()); };
  const rejectPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('AIChat context changed')); } pending.clear(); };
  function geometry() {
    const fallback = screen.getPrimaryDisplay().workArea;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) position = { x: fallback.x + fallback.width - 144, y: fallback.y + fallback.height - 160 };
    const area = screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) }).workArea;
    // Keep the transparent native canvas stable when toggling chat or receiving a
    // reply. Resizing a layered Windows window on every click causes flashing.
    const pixels = Math.max(32, Math.min(112 * preferences.scale, area.width - 16, area.height - 300));
    // A work-area canvas also leaves room below a pet dragged near the top.
    // Transparent pixels are click-through; only the pet and chat intercept input.
    const left = Math.max(8, Math.min(position.x + 120 - pixels - area.x, area.width - pixels - 8));
    const top = Math.max(8, Math.min(position.y + 120 - pixels - area.y, area.height - pixels - 24));
    return { pixels, left, top, bounds: { ...area }, anchor: { x: area.x + left + pixels - 120, y: area.y + top + pixels - 120 } };
  }
  function layout() {
    if (!window || window.isDestroyed()) return;
    const next = geometry().bounds, previous = window.getBounds();
    if (['x', 'y', 'width', 'height'].some(key => previous?.[key] !== next[key])) window.setBounds(next);
  }
  function configure(change) {
    preferences = petPreferences({ ...preferences, ...change });
    services.savePreferences?.(preferences); layout(); send();
  }
  async function requestExit() {
    const prompt = { id: String(++sequence), loading: true, personas: [], unavailable: false, sharedRuntime: services.sharedRuntime?.() === true };
    exitPrompt = prompt; send();
    window?.focus?.();
    try {
      const rows = await command('exit-info', {});
      if (exitPrompt !== prompt) return;
      if (!Array.isArray(rows)) throw new Error('Missing persona status');
      prompt.personas = rows.slice(0, 100).map(row => ({ name: text(row?.name, 160),
        channels: (Array.isArray(row?.channels) ? row.channels : []).slice(0, 20).map(channel => text(channel, 60)).filter(Boolean) }));
    } catch { if (exitPrompt !== prompt) return; prompt.unavailable = true; }
    prompt.loading = false; send();
  }
  function showMenu() {
    if (!Menu || popup) return;
    window.setIgnoreMouseEvents(false);
    popup = Menu.buildFromTemplate([
      { label: preferences.appearance === 'dragon' ? '抱抱龙' : snapshot.pet?.name || '桌面宠物', enabled: false },
      { label: '大小', submenu: PET_SIZES.map(scale => ({ label: `${scale}×${scale === 1 ? '（默认）' : ''}`, type: 'radio', checked: preferences.scale === scale, click: () => configure({ scale }) })) },
      { label: '外观', submenu: [
        { label: '跟随 AIChat 宠物', type: 'radio', checked: preferences.appearance === 'current', click: () => configure({ appearance: 'current' }) },
        { label: '抱抱龙', type: 'radio', checked: preferences.appearance === 'dragon', click: () => configure({ appearance: 'dragon' }) },
        { type: 'separator' },
        { label: '在哈奇星球更换宠物…', click: () => services.appearance?.() },
      ] },
      { type: 'separator' },
      { label: '打开 AIChat', click: () => services.open() },
      { label: '隐藏桌面宠物', click: () => services.hide?.() },
      { type: 'separator' },
      { label: '完全退出…', click: () => { void requestExit(); } },
    ]);
    popup.popup({ window, callback: () => { popup = null; if (window && !window.isDestroyed()) { window.setIgnoreMouseEvents(true, { forward: true }); send(); } } });
  }
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
    if (action === 'state') return view();
    if (action === 'open') { services.open(); return; }
    if (!visible) throw new Error('Pet is hidden');
    if (action === 'exit-cancel') { exitPrompt = null; send(); return; }
    if (action === 'exit-confirm') {
      if (!exitPrompt || exitPrompt.loading || args.id !== exitPrompt.id) throw new Error('Exit confirmation expired');
      exitPrompt = null; send(); services.quit?.(); return;
    }
    if (action === 'menu') { showMenu(); return; }
    if (action === 'expand') { expanded = args.expanded === true; send(); return; }
    if (action === 'hit-test') { window.setIgnoreMouseEvents(args.interactive !== true, { forward: true }); return; }
    if (action === 'drag-start') { drag = { cursor: screen.getCursorScreenPoint(), position: geometry().anchor }; return; }
    if (action === 'drag' || action === 'drag-end') {
      if (!drag) return;
      const cursor = screen.getCursorScreenPoint();
      position = { x: drag.position.x + cursor.x - drag.cursor.x, y: drag.position.y + cursor.y - drag.cursor.y };
      layout(); position = geometry().anchor; send();
      if (action === 'drag-end') { drag = null; services.savePosition(position); }
      return;
    }
    if (!ACTIONS.has(action) || !snapshot.context || args.context !== snapshot.context) throw new Error('Stale or invalid pet action');
    if (action === 'input' && (typeof args.text !== 'string' || args.text.length > 32000)) throw new Error('Invalid pet text');
    await command(action, action === 'input' ? { text: args.text } : {});
    return view();
  });
  const displayChanged = () => { layout(); send(); };
  screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged);
  return {
    show() { if (stopped) return; captureBlocked = false; visible = true; expanded = false; create(); layout(); window.setIgnoreMouseEvents(true, { forward: true }); send(); window.showInactive(); },
    hide(stopVoice = false) {
      visible = false; captureBlocked = stopVoice; drag = null; exitPrompt = null; popup?.closePopup(); popup = null; window?.hide();
      if (stopVoice) { captureBlocked = true; blockedContext = snapshot.context; try { services.command({ version: 1, action: 'hide', context: snapshot.context }); } catch {} }
    },
    update(value) { const next = projectState(value); if (next.context !== snapshot.context) { exitPrompt = null; rejectPending(); }
      snapshot = next;
      send();
      if (captureBlocked && blockedContext !== next.context) { blockedContext = next.context; try { services.command({ version: 1, action: 'hide', context: next.context }); } catch {} }
    },
    result(value) { const item = pending.get(value.requestId); if (!item) return; pending.delete(value.requestId); clearTimeout(item.timer); value.ok ? item.resolve(value.data) : item.reject(new Error(text(value.error, 300) || 'Pet action failed')); },
    reset() { snapshot = EMPTY; exitPrompt = null; rejectPending(); layout(); send(); },
    dispose() { stopped = true; visible = false; popup?.closePopup(); popup = null; rejectPending(); window?.destroy(); screen.removeListener('display-removed', displayChanged); screen.removeListener('display-metrics-changed', displayChanged); ipcMain.removeHandler(CHANNEL); },
  };
}
module.exports = { createPetWindow, projectState, clampBounds, assertPetSender };
