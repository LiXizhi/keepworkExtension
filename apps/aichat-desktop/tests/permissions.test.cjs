const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MediaGrants, installPermissions } = require('../src/permissions.cjs');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-permissions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'media-grants.json');
}
function host(file, prompt = async () => ({ response: 1 })) {
  const state = { url: 'https://keepwork.com/chat', developmentUrl: '', destroyed: false, prompts: [] };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed, getURL: () => state.url,
    session: { setPermissionCheckHandler(fn) { state.check = fn; }, setPermissionRequestHandler(fn) { state.request = fn; } },
  });
  const window = { webContents: contents, isDestroyed: () => state.destroyed };
  installPermissions(window, new MediaGrants(file), () => state.developmentUrl, {
    showMessageBox: async (_window, options) => { state.prompts.push(options); return prompt(); },
  });
  return Object.assign(state, {
    contents,
    ask: (types = ['audio'], extra = {}, sender = contents, permission = 'media') => new Promise(resolve => {
      state.request(sender, permission, resolve, { isMainFrame: true, requestingUrl: state.url,
        securityOrigin: new URL(state.url).origin + '/', mediaTypes: types, ...extra });
    }),
    allowed: (type = 'audio', extra = {}, sender = contents, permission = 'media', origin = new URL(state.url).origin) =>
      state.check(sender, permission, origin, { isMainFrame: true, requestingUrl: state.url, mediaType: type, ...extra }),
  });
}

test('microphone approval survives repeated speech, reload, window recreation and app restart', async t => {
  const file = profile(t);
  const h = host(file);
  assert.equal(h.allowed(), false);
  assert.equal(await h.ask(), true);
  assert.match(h.prompts[0].message, /麦克风/);
  assert.equal(h.allowed(), true, 'top-level checks have no embeddingOrigin');
  assert.equal(h.allowed('audio', { securityOrigin: 'https://keepwork.com/' }, h.contents, 'media', 'https://keepwork.com/'), true);
  h.contents.emit('did-start-navigation', {}, h.url, false, true);
  h.url += '?chat=next';
  assert.equal(await h.ask(), true);
  assert.equal(h.prompts.length, 1);
  const restarted = host(file);
  assert.equal(restarted.allowed(), true);
  assert.equal(await restarted.ask(), true);
  assert.equal(restarted.prompts.length, 0);
});

test('audio approval never silently grants the camera or unknown media', async t => {
  const h = host(profile(t));
  await h.ask();
  assert.equal(h.allowed('video'), false);
  assert.equal(h.allowed('unknown'), false);
  assert.equal(await h.ask(['audio', 'video']), true);
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1].message, /摄像头/);
  assert.doesNotMatch(h.prompts[1].message, /麦克风/);
  assert.equal(h.allowed('video'), true);
  for (const types of [[], undefined, ['unknown']]) {
    assert.equal(await h.ask([], { mediaTypes: types }), false);
  }
});

test('concurrent microphone requests share a single consent dialog', async t => {
  let resolve;
  const h = host(profile(t), () => new Promise(done => { resolve = done; }));
  const requests = [h.ask(), h.ask(), h.ask()];
  assert.equal(h.prompts.length, 1);
  resolve({ response: 1 });
  assert.deepEqual(await Promise.all(requests), [true, true, true]);
});

test('denial is retryable and does not create an approval record', async t => {
  const file = profile(t);
  const h = host(file, async () => ({ response: 0 }));
  assert.equal(await h.ask(), false);
  assert.equal(h.allowed(), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await h.ask(), false);
  assert.equal(h.prompts.length, 2);
});

test('saved consent is limited to the selected top-level page and actual sender', async t => {
  const h = host(profile(t));
  await h.ask();
  for (const details of [
    { isMainFrame: false }, { requestingUrl: 'https://evil.test/chat' },
    { requestingUrl: 'https://keepwork.com/preview' }, { securityOrigin: 'https://evil.test' },
  ]) {
    assert.equal(h.allowed('audio', details), false);
    assert.equal(await h.ask(['audio'], details), false);
  }
  assert.equal(await h.ask(['audio'], {}, null), false);
  assert.equal(h.allowed('audio', {}, null), false);
  assert.equal(h.allowed('audio', {}, h.contents, 'media', 'https://evil.test'), false);
  h.url = 'https://keepwork.com/preview';
  assert.equal(await h.ask(['audio'], { requestingUrl: 'https://keepwork.com/chat' }), false);
  h.url = h.developmentUrl = 'http://127.0.0.1:3001/AIChat.html';
  assert.equal(h.allowed(), false);
  assert.equal(await h.ask(), true);
  assert.equal(h.prompts.length, 2);
  h.url = h.developmentUrl = 'http://127.0.0.1:3002/AIChat.html';
  assert.equal(h.allowed(), false);
});

test('navigation or window closure while consent is open cannot save or grant permission', async t => {
  for (const transition of ['navigate', 'close', 'switch-server']) {
    const file = profile(t);
    let resolve;
    const h = host(file, () => new Promise(done => { resolve = done; }));
    const request = h.ask();
    if (transition === 'navigate') h.contents.emit('did-start-navigation', {}, h.url, false, true);
    if (transition === 'close') h.destroyed = true;
    if (transition === 'switch-server') h.developmentUrl = 'http://127.0.0.1:3001/AIChat.html';
    resolve({ response: 1 });
    assert.equal(await request, false);
    assert.equal(fs.existsSync(file), false);
  }
});

test('dialog failures, corrupt files and write failures fail closed and allow retry', async t => {
  const file = profile(t);
  fs.writeFileSync(file, '{broken');
  const h = host(file, async () => { throw new Error('closed dialog'); });
  assert.equal(h.allowed(), false);
  assert.equal(await h.ask(), false);
  const writable = host(file);
  assert.equal(await writable.ask(), true);
  fs.rmSync(file);
  fs.mkdirSync(file);
  const blocked = host(file);
  assert.equal(await blocked.ask(), false);
  assert.equal(blocked.allowed(), false);
});

test('unsupported permissions remain denied and clipboard/notifications keep their policy', async t => {
  const h = host(profile(t));
  assert.equal(await h.ask([], {}, h.contents, 'geolocation'), false);
  assert.equal(h.allowed('audio', {}, h.contents, 'clipboard-sanitized-write'), true);
  assert.equal(h.allowed('audio', {}, h.contents, 'notifications'), false);
  assert.equal(await h.ask([], {}, h.contents, 'notifications'), true);
  assert.match(h.prompts[0].message, /通知/);
});
