const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadPage } = require('../src/pageLoad.cjs');
function fixture() {
  const contents = new EventEmitter();
  let fail, finish, stopped = 0;
  const win = { webContents: contents, isDestroyed: () => false, loadURL: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) };
  contents.stop = () => { stopped++; fail(Error('ERR_ABORTED')); };
  return { win, contents, fail: error => fail(error), finish: () => finish(), stopped: () => stopped };
}
test('a usable document does not wait for slow images or child frames', async () => {
  const f = fixture(); let shown = false;
  const loaded = loadPage(f.win, 'https://keepwork.com/chat', { ready: () => { shown = true; } });
  f.contents.emit('did-fail-load', {}, -105, 'child frame offline', 'https://other.invalid', false);
  assert.equal(shown, false);
  f.contents.emit('dom-ready');
  await loaded;
  assert.equal(shown, true);
  assert.equal(f.contents.listenerCount('dom-ready'), 0);
  // A late failure must be handled, without another readiness notification.
  f.fail(Error('late resource failure'));
  await new Promise(resolve => setImmediate(resolve));
});
test('main page failure can be retried in the same window', async () => {
  const f = fixture();
  const first = loadPage(f.win, 'https://keepwork.com/chat');
  f.fail(Error('ERR_INTERNET_DISCONNECTED'));
  await assert.rejects(first, /DISCONNECTED/);
  const second = loadPage(f.win, 'https://keepwork.com/chat');
  f.contents.emit('dom-ready'); await second;
});
test('a stalled main document has a deadline, stops loading, and leaves no listeners', async () => {
  const f = fixture();
  await assert.rejects(loadPage(f.win, 'https://keepwork.com/chat', { timeoutMs: 20 }), /超时/);
  assert.equal(f.stopped(), 1);
  assert.equal(f.contents.listenerCount('dom-ready'), 0);
});
test('closing during navigation does not leave startup pending', async () => {
  const f = fixture();
  const loaded = loadPage(f.win, 'https://keepwork.com/chat');
  f.contents.emit('destroyed'); await assert.rejects(loaded, /关闭/);
});
