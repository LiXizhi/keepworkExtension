const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStartupWindow } = require('../src/startupWindow.cjs');
test('startup separates errors, confines callers, coalesces retry and opens only fixed diagnosis URL', async () => {
  const handlers = new Map(), windows = [], opened = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (_c, s) => { this.state = s; }; }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    isDestroyed() { return !!this.destroyed; } show() {} focus() {} destroy() { this.destroyed = true; }
  }
  let retry = 0, release;
  const startup = createStartupWindow({ BrowserWindow: Window, ipcMain: { handle: (key, cb) => handlers.set(key, cb), removeHandler: key => handlers.delete(key) }, shell: { openExternal: url => opened.push(url) } }, __dirname, async () => { retry++; await new Promise(r => { release = r; }); });
  startup.open(); startup.open(); assert.equal(windows.length, 1);
  const window = windows[0], invoke = handlers.get('aichat-startup:v1');
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await assert.rejects(invoke({ ...event, senderFrame: { url: event.senderFrame.url } }, 'retry'), /Untrusted/);
  await assert.rejects(invoke({ ...event, sender: {} }, 'status'), /Untrusted/);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  startup.update('MCP 启动失败', '端口冲突');
  assert.equal((await invoke(event, 'status')).busy, false);
  const first = invoke(event, 'retry'); await invoke(event, 'retry'); assert.equal(retry, 1);
  release(); await first;
  startup.update('AIChat 网页连接失败', '请检查网络');
  assert.match((await invoke(event, 'status')).stage, /网页/);
  await invoke(event, 'dashboard'); assert.deepEqual(opened, ['http://127.0.0.1:8089/dashboard']);
  startup.dispose(); assert.equal(window.destroyed, true); assert.equal(handlers.size, 0);
});
