const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateWindow, assertUpdateSender } = require('../src/updateWindow.cjs');
test('update window is single-instance, checks on opening and exposes only update actions', async () => {
  let handler, checks = 0, focused = 0; const windows = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {}; windows.push(this); }
    isDestroyed() { return false; } setMenu() {} show() {} focus() { focused++; }
    loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); return Promise.resolve(); }
  }
  const ui = createUpdateWindow({ BrowserWindow: Window, ipcMain: { handle: (_id, fn) => handler = fn } }, __dirname,
    { status: () => ({ mcp: {} }), check: async () => checks++, mcp: async () => 'applied', desktop: async () => {} });
  ui.open(); ui.open();
  assert.equal(windows.length, 1); assert.equal(focused, 1); assert.equal(checks, 1);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  assert.equal(await handler(event, 'mcp'), 'applied');
  await assert.rejects(handler(event, 'terminal'), /Invalid update action/);
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: event.senderFrame.url } }]) {
    await assert.rejects(handler(invalid, 'mcp'), /Untrusted/);
  }
  assert.throws(() => assertUpdateSender(event, windows[0], 'https://keepwork.com/chat'), /Untrusted/);
  windows[0].emit('closed'); ui.open(); assert.equal(windows.length, 2); assert.equal(checks, 2);
});
