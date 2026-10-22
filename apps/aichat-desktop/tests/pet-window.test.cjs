const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPetWindow, projectState, clampBounds } = require('../src/petWindow.cjs');
function fixture() {
  const windows = [], commands = [], saved = []; let handler, opened = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.shown = false; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_, state) => { this.state = state; }; windows.push(this); }
    isDestroyed() { return !!this.destroyed; } setMenu() {} setBounds(value) { this.bounds = value; } getBounds() { return this.bounds; }
    showInactive() { this.shown = true; } hide() { this.shown = false; } destroy() { this.destroyed = true; this.emit('closed'); }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); return Promise.resolve(); }
  }
  const screen = new EventEmitter(); screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } });
  screen.getDisplayNearestPoint = screen.getPrimaryDisplay; screen.getCursorScreenPoint = () => ({ x: 300, y: 300 });
  const pet = createPetWindow({ BrowserWindow: Window, screen, ipcMain: { handle: (_, fn) => { handler = fn; }, removeHandler() {} } }, __dirname,
    { position: () => ({ x: 9000, y: -100 }), savePosition: p => saved.push(p), open: () => { opened++; pet.hide(); }, command: command => commands.push(command) });
  const invoke = (action, args = {}, override = {}) => handler({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame, ...override }, action, args);
  return { windows, commands, saved, pet, screen, invoke, opened: () => opened };
}
test('pet window remains single-instance, transparent/topmost and restores after hiding without requesting microphone restart', async () => {
  const h = fixture(); h.pet.show(); h.pet.show(); assert.equal(h.windows.length, 1);
  const w = h.windows[0]; assert.equal(w.options.transparent, true); assert.equal(w.options.alwaysOnTop, true);
  assert.equal(w.options.webPreferences.sandbox, true); assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.bounds.x, 1072); assert.equal(w.bounds.y, 0);
  await h.invoke('expand', { expanded: true }); assert.equal(w.bounds.width, 360); assert.ok(w.bounds.x + w.bounds.width <= 1200);
  h.pet.hide(true); assert.equal(w.shown, false); assert.equal(h.commands.at(-1).action, 'hide');
  h.pet.show(); assert.equal(w.state.expanded, false); assert.equal(h.commands.length, 1);
  await h.invoke('open'); assert.equal(h.opened(), 1); assert.equal(w.shown, false);
  h.pet.dispose(); assert.equal(w.destroyed, true);
});
test('pet IPC rejects foreign frames, stale owners and arbitrary native operations', async () => {
  const h = fixture(); h.pet.show(); h.pet.update({ version: 1, context: 'chat-1', ready: true });
  for (const override of [{ sender: {} }, { senderFrame: { url: h.windows[0].webContents.mainFrame.url } }]) {
    await assert.rejects(h.invoke('open', {}, override), /Untrusted/);
  }
  await assert.rejects(h.invoke('terminal', { context: 'chat-1' }), /invalid/);
  await assert.rejects(h.invoke('send', { context: 'chat-0' }), /Stale/);
  const sent = h.invoke('send', { context: 'chat-1' });
  assert.equal(h.commands.at(-1).action, 'send'); h.pet.result({ requestId: h.commands.at(-1).requestId, ok: true }); await sent;
  const pending = h.invoke('input', { context: 'chat-1', text: 'draft' });
  h.pet.reset(); await assert.rejects(pending, /context changed/); assert.equal(h.windows[0].state.context, '');
  h.pet.dispose();
});
test('projection strips secrets/tool payloads and limits renderer data', () => {
  const state = projectState({ version: 1, context: 'c', token: 'secret', voice: { active: true, liveAPI: { apiKey: 'secret' } },
    pet: { sheetUrl: 'https://evil.example/pet?token=secret' }, messages: [{ role: 'tool', content: 'secret' }, { role: 'assistant', content: 'hello', reasoning: 'secret' }] });
  assert.ok(!JSON.stringify(state).includes('secret')); assert.equal(state.messages.length, 1); assert.equal(state.pet.sheetUrl, '');
});
test('small displays and monitor removal clamp pet panel inside work area', () => {
  assert.deepEqual(clampBounds({ x: -900, y: 9999 }, { width: 360, height: 520 }, { x: -100, y: 20, width: 300, height: 400 }), { x: -100, y: 20, width: 300, height: 400 });
});
