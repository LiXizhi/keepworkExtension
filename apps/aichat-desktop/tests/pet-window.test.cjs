const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPetWindow, projectState, clampBounds } = require('../../../src/pet/petWindow.cjs');

test('pet projection accepts bounded raster bytes without allowing active image payloads', () => {
  const project = imageData => projectState({ version: 1, context: 'chat', pet: { imageData, bgSize: '400% 400%', bgPos: '66.667% 100%' } }).pet;
  assert.equal(project('data:image/webp;base64,YQ==').imageData, 'data:image/webp;base64,YQ==');
  assert.equal(project('data:image/webp;base64,YQ==').bgPos, '66.667% 100%');
  for (const value of ['data:image/svg+xml;base64,YQ==', 'javascript:alert(1)', 'data:image/png;base64,invalid!', 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024 + 64)]) {
    assert.equal(project(value).imageData, '');
  }
});
function fixture() {
  const windows = [], commands = [], saved = [], preferences = [], menus = []; let handler, opened = 0, appearance = 0, quit = 0;
  const Menu = { buildFromTemplate(items) { const menu = { items, popup(options) { this.options = options; }, closePopup() { this.options?.callback(); } }; menus.push(menu); return menu; } };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.shown = false; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_, state) => { this.state = state; }; windows.push(this); }
    isDestroyed() { return !!this.destroyed; } setMenu() {} setBounds(value) { this.bounds = value; this.resizes = (this.resizes || 0) + 1; } getBounds() { return this.bounds; }
    showInactive() { this.shown = true; } hide() { this.shown = false; } destroy() { this.destroyed = true; this.emit('closed'); }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); return Promise.resolve(); }
  }
  const screen = new EventEmitter(); screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } });
  screen.getDisplayNearestPoint = screen.getPrimaryDisplay; screen.getCursorScreenPoint = () => ({ x: 300, y: 300 });
  const pet = createPetWindow({ BrowserWindow: Window, screen, Menu, ipcMain: { handle: (_, fn) => { handler = fn; }, removeHandler() {} } }, __dirname,
    { position: () => ({ x: 9000, y: -100 }), savePosition: p => saved.push(p), open: () => { opened++; pet.hide(); },
      preferences: () => preferences.at(-1), savePreferences: value => preferences.push(value), hide: () => pet.hide(true), appearance: () => { appearance++; },
      quit: () => { quit++; },
      command: command => commands.push(command) });
  const invoke = (action, args = {}, override = {}) => handler({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame, ...override }, action, args);
  return { windows, commands, saved, preferences, menus, pet, screen, invoke, opened: () => opened, appearance: () => appearance, quit: () => quit };
}
test('pet window remains single-instance, transparent/topmost and restores after hiding without requesting microphone restart', async () => {
  const h = fixture(); h.pet.show(); h.pet.show(); assert.equal(h.windows.length, 1);
  const w = h.windows[0]; assert.equal(w.options.transparent, true); assert.equal(w.options.alwaysOnTop, true);
  assert.equal(w.options.minimizable, false); assert.equal(w.options.maximizable, false);
  assert.equal(w.options.webPreferences.sandbox, true); assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.bounds.x, 0); assert.equal(w.bounds.y, 0);
  await h.invoke('expand', { expanded: true }); assert.equal(w.bounds.width, 1200); assert.ok(w.bounds.x + w.bounds.width <= 1200);
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

test('reply projection allows safe buttons on a stable collapsed native canvas', () => {
  const h = fixture(); h.pet.show();
  h.pet.update({ version: 1, context: 'chat', reply: { text: 'x'.repeat(9000), thinking: true,
    options: [{ icon: '▶', text: 'Continue', command: 'secret' }, null] } });
  const w = h.windows[0];
  assert.equal(w.state.expanded, false);
  assert.equal(w.bounds.width, 1200);
  assert.equal(w.state.reply.text.length, 9000);
  assert.deepEqual(w.state.reply.options, [{ text: 'Continue', icon: '▶' }]);
  h.pet.reset(); assert.equal(w.bounds.width, 1200);
  h.pet.dispose();
});

test('click, expand, collapse and reply arrival never resize or move the pet canvas', async () => {
  const h = fixture(); h.pet.show(); const w = h.windows[0], before = { ...w.bounds }, count = w.resizes;
  await h.invoke('drag-start'); await h.invoke('drag-end');
  await h.invoke('expand', { expanded: true });
  h.pet.update({ version: 1, context: 'chat', reply: { text: 'Hello', options: [] } });
  await h.invoke('expand', { expanded: false }); h.pet.reset();
  assert.deepEqual(w.bounds, before); assert.equal(w.resizes, count);
  h.pet.dispose();
});

test('right-click menu configures persisted size/appearance, opens pet world and hides without canceling tasks', async () => {
  const h = fixture(); h.pet.show();
  await h.invoke('menu'); const menu = h.menus.at(-1);
  const size = menu.items.find(item => item.label === '大小');
  size.submenu.find(item => item.label.startsWith('2×')).click();
  assert.equal(h.windows[0].state.petPixels, 224);
  const appearance = menu.items.find(item => item.label === '外观');
  appearance.submenu.find(item => item.label === '抱抱龙').click();
  assert.deepEqual(h.preferences.at(-1), { scale: 2, appearance: 'dragon' });
  appearance.submenu.at(-1).click(); assert.equal(h.appearance(), 1);
  menu.items.find(item => item.label === '隐藏桌面宠物').click();
  assert.equal(h.windows[0].shown, false); assert.equal(h.commands.at(-1).action, 'hide');
  assert.ok(h.commands.every(command => command.action !== 'stop'));
  await assert.rejects(h.invoke('menu'), /hidden/);
  h.pet.show(); assert.equal(h.windows[0].state.preferences.appearance, 'dragon');
  h.pet.dispose();
});

test('pet can move to the top of the display without resizing its transparent canvas', async () => {
  const h = fixture(); h.pet.show(); const w = h.windows[0], before = w.resizes;
  let cursor = { x: 300, y: 300 }; h.screen.getCursorScreenPoint = () => cursor;
  await h.invoke('drag-start'); cursor = { x: -600, y: -200 }; await h.invoke('drag-end');
  assert.equal(w.state.petTop, 8); assert.ok(w.state.petLeft >= 8);
  assert.equal(w.resizes, before); assert.equal(h.saved.length, 1);
  await h.invoke('expand', { expanded: true });
  assert.equal(w.state.petTop, 8); assert.equal(w.resizes, before);
  h.pet.dispose();
});

test('complete exit requires a loaded, current confirmation; cancel and owner changes invalidate it', async () => {
  const h = fixture(); h.pet.show(); h.pet.update({ version: 1, context: 'owner' });
  await h.invoke('menu');
  const open = () => h.menus.at(-1).items.find(item => item.label === '完全退出…').click();
  const respond = async data => { h.pet.result({ requestId: h.commands.at(-1).requestId, ok: true, data }); await new Promise(resolve => setImmediate(resolve)); };
  open(); let id = h.windows[0].state.exitPrompt.id;
  assert.equal(h.quit(), 0);
  await assert.rejects(h.invoke('exit-confirm', { id }), /expired/);
  await respond([{ name: '助手', channels: ['飞书', '钉钉'], secret: 'hidden' }]);
  assert.deepEqual(h.windows[0].state.exitPrompt.personas, [{ name: '助手', channels: ['飞书', '钉钉'] }]);
  await h.invoke('exit-cancel'); await assert.rejects(h.invoke('exit-confirm', { id }), /expired/);
  open(); id = h.windows[0].state.exitPrompt.id;
  await respond([]); h.pet.update({ version: 1, context: 'new-owner' });
  await assert.rejects(h.invoke('exit-confirm', { id }), /expired/);
  open(); id = h.windows[0].state.exitPrompt.id;
  h.pet.result({ requestId: h.commands.at(-1).requestId, ok: false, error: 'offline' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windows[0].state.exitPrompt.unavailable, true);
  await h.invoke('exit-confirm', { id }); assert.equal(h.quit(), 1);
  await assert.rejects(h.invoke('exit-confirm', { id }), /expired/);
  h.pet.dispose();
});

test('pet target toggle crosses the real preload and native IPC allowlists', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const h = fixture(); h.pet.show();
  h.pet.update({ version: 1, context: 'persona', target: 'persona', canSwitchTarget: true });
  let api;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopPet'); api = value; } },
    ipcRenderer: { invoke(channel, action, args) { assert.equal(channel, 'aichat-desktop:pet-v1'); return h.invoke(action, args); } },
  };
  const source = fs.readFileSync(require.resolve('../../../src/pet/pet-preload.cjs'), 'utf8');
  try {
    vm.runInNewContext(source, { process: { isMainFrame: true }, require: () => electron });
    const switched = api.action('toggle-target', { context: 'persona' });
    const command = h.commands.at(-1);
    if (command) {
      assert.equal(command.action, 'toggle-target');
      assert.equal(command.context, 'persona');
      h.pet.result({ requestId: command.requestId, ok: true });
      h.pet.update({ version: 1, context: 'chat', target: 'chat', canSwitchTarget: true });
    }
    assert.equal((await switched).target, 'chat');
    await assert.rejects(api.action('toggle-target', { context: 'persona' }), /Stale/);
    await assert.rejects(api.action('terminal'), /Invalid pet action/);
    api = undefined;
    vm.runInNewContext(source, { process: { isMainFrame: false }, require: () => electron });
    assert.equal(api, undefined, 'subframes must not receive the pet bridge');
  } finally { h.pet.dispose(); }
});


test('screenshot bubble is independent of chat; validates identity and hides before granting', async () => {
 const h=fixture(); h.pet.show();
 const pending=h.pet.requestPermission({id:'capture-1',client:'PPT teacher'});
 const w=h.windows[0]; assert.equal(w.state.permission.client,'PPT teacher'); assert.ok(w.state.petTop>=250);
 await assert.rejects(h.invoke('permission-choice',{id:'stale',choice:'always'}),/expired/);
 await assert.rejects(h.invoke('permission-choice',{id:'capture-1',choice:'once'},{sender:{}}),/Untrusted/);
 await h.invoke('permission-choice',{id:'capture-1',choice:'once'});
 assert.equal(await pending,'once'); assert.equal(w.shown,false); assert.equal(w.state.permission,null);
 h.pet.restorePermission(); assert.equal(w.shown,true); h.pet.dispose();
});
test('hiding or disposing permission pet cancels pending approval', async () => {
 for(const operation of ['hide','dispose']) { const h=fixture(); const pending=h.pet.requestPermission({id:'capture',client:'teacher'}); h.pet[operation](); await assert.rejects(pending,/hidden|closed/); if(operation!=='dispose')h.pet.dispose(); }
});
