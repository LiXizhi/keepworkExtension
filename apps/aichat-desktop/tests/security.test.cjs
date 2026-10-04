const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { assertSender, trustedPage, externalUrl } = require('../src/security.cjs');
test('only the trusted top-level window can call native IPC', () => {
  const contents = { isDestroyed: () => false, mainFrame: { url: 'https://keepwork.com/chat?layout=thin' } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.doesNotThrow(() => assertSender(event, contents));
  assert.throws(() => assertSender({ ...event, senderFrame: { url: contents.mainFrame.url } }, contents));
  assert.throws(() => assertSender({ ...event, sender: {} }, contents));
  for (const url of ['https://keepwork.com/other', 'https://keepwork.com/chat/preview', 'https://evil.test/chat', 'file:///chat', 'https://user@keepwork.com/chat']) {
    contents.mainFrame.url = url; assert.throws(() => assertSender(event, contents));
  }
  assert.equal(trustedPage('http://127.0.0.1:3000/AIChat.html', 'http://127.0.0.1:3000/AIChat.html'), true);
  assert.equal(externalUrl('javascript:alert(1)'), false);
  assert.equal(externalUrl('file:///C:/secret'), false);
});
test('preload exposes no Node/Electron primitives and is absent from subframes', () => {
  let exposed;
  const source = fs.readFileSync(require.resolve('../src/preload.cjs'), 'utf8');
  const context = { process: { isMainFrame: false }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } }, ipcRenderer: { invoke: () => null } }) };
  vm.runInNewContext(source, context); assert.equal(exposed, undefined);
  context.process.isMainFrame = true; vm.runInNewContext(`(()=>{${source}\n})()`, context);
  assert.equal(exposed.version, 1); assert.equal(exposed.require, undefined); assert.equal(exposed.ipcRenderer, undefined);
});
