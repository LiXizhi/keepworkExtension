const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../windows/cef-host/pet_art.js'), 'utf8');
const bridgeScript = fs.readFileSync(path.join(__dirname, '../windows/cef-host/pet_bridge.js'), 'utf8');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAElFTkSuQmCC';
const otherPng = png + 'AAAA';
const cdn = 'https://cdn.keepwork.com/pets/fixture.png';
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function install(options = {}) {
  const published = [], images = [], draws = [], canvases = [], fetches = [], controllers = [], objects = new Map(), revoked = [], timers = new Map();
  let objectSequence = 0, timerSequence = 0;
  class Image {
    constructor() { this.naturalWidth = this.naturalHeight = 0; images.push(this); }
    set src(value) { this.source = value; }
    get src() { return this.source; }
    load(width = 1254, height = 1254) {
      this.naturalWidth = width; this.naturalHeight = height;
      this.width = width; this.height = height;
      this.onload?.();
    }
    fail() { this.onerror?.(Error('fixture decode failed')); }
  }
  class FixtureURL extends URL {
    static createObjectURL(value) { const key = `blob:fixture-${++objectSequence}`; objects.set(key, value); return key; }
    static revokeObjectURL(value) { revoked.push(value); objects.delete(value); }
  }
  class FixtureAbortController extends AbortController {
    constructor() { super(); controllers.push(this); }
  }
  const response = (overrides = {}) => ({
    ok: true,
    headers: { get: key => key.toLowerCase() === 'content-type' ? 'image/png' : null },
    body: { getReader() {
      let read = false;
      return { read: async () => read ? { done: true } : (read = true, { done: false, value: Uint8Array.from([137, 80, 78, 71]) }),
        cancel: async () => {} };
    } },
    arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    blob: async () => new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }),
    ...overrides,
  });
  const fetch = (url, settings) => {
    fetches.push({ url, settings });
    return options.fetch ? options.fetch(url, settings, response) : Promise.resolve(response());
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          clearRect() {},
          drawImage(...args) { draws.push({ width: canvas.width, height: canvas.height, args }); },
        }),
        toDataURL(...args) {
          return options.encode ? options.encode(canvas, args) : png;
        },
      };
      canvases.push(canvas); return canvas;
    },
  };
  const calls = [], events = new Map();
  let dispatch;
  const window = {
    __keepworkPetTransport(kind, payload) {
      if (kind === 'register') dispatch = payload;
      else calls.push({ kind, payload });
      return true;
    },
    addEventListener(type, listener) { events.set(type, listener); },
  };
  const scope = { window, document, Image, fetch, URL: FixtureURL,
    AbortController: FixtureAbortController, Blob, Uint8Array, console,
    setTimeout(fn, delay) { const id = ++timerSequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.createContext(scope); vm.runInContext(script, scope);
  assert.equal(typeof window.__keepworkCreatePetArtwork, 'function');
  const art = window.__keepworkCreatePetArtwork(value => published.push(JSON.parse(JSON.stringify(value))));
  if (options.bridge) vm.runInContext(bridgeScript, scope);
  return { art, published, images, draws, canvases, fetches, controllers, objects, revoked, timers, response,
    window, bridge: window.aichatDesktop, calls, dispatch: (...args) => dispatch(...args),
    navigate: () => events.get('pagehide')() };
}

test('CEF artwork keeps legacy and missing pet fields usable with a bounded fallback name', async () => {
  const fixture = install();
  fixture.art.update(undefined, 'old-page');
  await tick();
  assert.equal(fixture.published.at(-1).context, 'old-page');
  assert.equal(fixture.published.at(-1).png, '');
  assert.equal(fixture.images.length, 0);
  assert.equal(fixture.fetches.length, 0);
  fixture.art.update({ name: 'n'.repeat(500), unexpected: 'omit' }, 'new-page');
  assert.ok(fixture.published.at(-1).name.length <= 80);
  assert.equal(fixture.published.at(-1).unexpected, undefined);
  fixture.art.dispose();
});

test('CEF artwork uses the same fractional first 4 by 4 sprite frame as the standard pet', async () => {
  const fixture = install();
  fixture.art.update({ name: '哈奇', imageData: png }, 'owner-1');
  assert.equal(fixture.published.at(-1).png, '', 'old artwork clears before asynchronous replacement');
  await tick();
  assert.equal(fixture.images.length, 1);
  fixture.images[0].load(); await tick();
  assert.deepEqual(fixture.draws.at(-1).args.slice(1, 5), [0, 0, 313.5, 313.5]);
  assert.deepEqual(fixture.draws.at(-1).args.slice(5), [0, 0, 256, 256]);
  assert.deepEqual(fixture.published.at(-1), { context: 'owner-1', name: '哈奇', png });
  fixture.art.dispose();
});

test('CEF artwork translates percentage sprite size and position into the selected source cell', async () => {
  const fixture = install();
  fixture.art.update({ imageData: png, bgSize: '800% 400%', bgPos: '100% 100%' }, 'owner-1');
  await tick(); fixture.images[0].load(1600, 800); await tick();
  assert.deepEqual(fixture.draws.at(-1).args.slice(1, 5), [1400, 600, 200, 200]);
  assert.equal(fixture.published.at(-1).png, png);
  fixture.art.dispose();
});

test('CEF artwork malformed and extreme CSS frame fields use the safe default frame', async () => {
  for (const frame of [
    { bgSize: '0% 0%', bgPos: '-100% 100%' },
    { bgSize: '999999999999999999% 400%', bgPos: '200% 100%' },
    { bgSize: 'url(https://evil.invalid)', bgPos: 'calc(10%) 0%' },
  ]) {
    const fixture = install();
    fixture.art.update({ imageData: png, ...frame }, 'owner-1'); await tick();
    fixture.images[0].load(400, 400); await tick();
    assert.deepEqual(fixture.draws.at(-1).args.slice(1, 5), [0, 0, 100, 100]);
    fixture.art.dispose();
  }
});

test('CEF artwork prefers data images and fetches only the allowlisted CDN without cookies or redirects', async () => {
  const data = install();
  data.art.update({ imageData: png, sheetUrl: cdn }, 'owner-1');
  await tick();
  assert.equal(data.fetches.length, 0);
  assert.equal(data.images[0].src, png);
  data.art.dispose();
  const remote = install();
  remote.art.update({ sheetUrl: cdn }, 'owner-2'); await tick();
  assert.equal(remote.fetches.length, 1);
  assert.equal(remote.fetches[0].url, cdn);
  assert.equal(remote.fetches[0].settings.credentials, 'omit');
  assert.equal(remote.fetches[0].settings.redirect, 'error');
  assert.ok(remote.fetches[0].settings.signal);
  assert.equal(remote.images.length, 1);
  remote.images[0].load(400, 400); await tick();
  assert.equal(remote.published.at(-1).png, png);
  remote.art.dispose();
  assert.equal(remote.objects.size, 0, 'temporary image blobs cannot survive disposal');
});

test('CEF artwork rejects executable, foreign, credentialed, tokenized and oversized sources', async () => {
  for (const pet of [
    { imageData: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { imageData: 'data:text/html;base64,PHNjcmlwdD4=' },
    { imageData: 'javascript:alert(1)' },
    { imageData: 'data:image/png;base64,!!!!' },
    { imageData: 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024 + 65) },
    { sheetUrl: 'http://cdn.keepwork.com/pet.png' },
    { sheetUrl: 'https://cdn.keepwork.com.evil.invalid/pet.png' },
    { sheetUrl: 'https://user:password@cdn.keepwork.com/pet.png' },
    { sheetUrl: cdn + '?token=private' },
    { sheetUrl: cdn + '#fragment' },
    { sheetUrl: 'file:///private/pet.png' },
  ]) {
    const fixture = install();
    fixture.art.update(pet, 'owner-1'); await tick();
    assert.equal(fixture.fetches.length, 0, 'rejected URL never reaches the network');
    assert.equal(fixture.images.length, 0, 'rejected source never reaches a decoder');
    assert.equal(fixture.published.at(-1).png, '');
    fixture.art.dispose();
  }
});

test('CEF artwork image failures and oversized natural dimensions leave the fallback usable', async () => {
  for (const size of [null, [0, 100], [100, 0], [4097, 100], [100, 4097]]) {
    const fixture = install();
    fixture.art.update({ imageData: png }, 'owner-1'); await tick();
    if (size) fixture.images[0].load(...size); else fixture.images[0].fail();
    await tick();
    assert.equal(fixture.published.at(-1).png, '');
    assert.equal(fixture.draws.length, 0, 'unbounded or broken artwork is never rasterized');
    fixture.art.dispose();
  }
});

test('CEF artwork retries large PNG output at 128 pixels and bounds the final transport', async () => {
  const fixture = install({ encode: canvas => canvas.width > 128 ? 'data:image/png;base64,' + 'A'.repeat(128 * 1024) : png });
  fixture.art.update({ imageData: png }, 'owner-1'); await tick();
  fixture.images[0].load(); await tick();
  assert.deepEqual(fixture.draws.map(draw => draw.width), [256, 128]);
  assert.equal(fixture.published.at(-1).png, png);
  fixture.art.dispose();
  const overflow = install({ encode: () => 'data:image/png;base64,' + 'A'.repeat(128 * 1024) });
  overflow.art.update({ imageData: png }, 'owner-1'); await tick();
  overflow.images[0].load(); await tick();
  assert.equal(overflow.published.at(-1).png, '');
  overflow.art.dispose();
});

test('CEF artwork canvas errors and non-PNG serialization preserve the fallback', async () => {
  for (const encode of [() => { throw Error('fixture canvas unavailable'); }, () => 'data:text/plain;base64,QUFBQQ==']) {
    const fixture = install({ encode });
    fixture.art.update({ imageData: png }, 'owner-1'); await tick();
    fixture.images[0].load(); await tick();
    assert.equal(fixture.published.at(-1).png, '');
    assert.equal(fixture.timers.size, 0);
    fixture.art.dispose();
  }
});

test('CEF artwork never lets a late image overwrite a newer source or owner context', async () => {
  const fixture = install();
  fixture.art.update({ imageData: png, name: 'old' }, 'owner-1'); await tick();
  const staleLoad = fixture.images[0].onload;
  fixture.art.update({ imageData: otherPng, name: 'new' }, 'owner-1'); await tick();
  fixture.images[1].load(); await tick();
  const count = fixture.published.length;
  fixture.images[0].naturalWidth = fixture.images[0].naturalHeight = 400;
  staleLoad?.(); await tick();
  assert.equal(fixture.published.length, count);
  assert.equal(fixture.published.at(-1).name, 'new');
  fixture.art.update({ imageData: otherPng, name: 'next account' }, 'owner-2');
  assert.equal(fixture.published.at(-1).context, 'owner-2');
  assert.equal(fixture.published.at(-1).png, '', 'an owner change cannot retain the earlier artwork');
  await tick();
  fixture.art.dispose();
});

test('CEF artwork disposal aborts a pending fetch and suppresses its late result and further updates', async () => {
  let complete;
  const fixture = install({ fetch: (_url, _settings, response) => new Promise(resolve => { complete = () => resolve(response()); }) });
  fixture.art.update({ sheetUrl: cdn }, 'owner-1'); await tick();
  const count = fixture.published.length;
  fixture.art.dispose();
  assert.equal(fixture.fetches[0].settings.signal.aborted, true);
  complete(); await tick();
  fixture.art.update({ imageData: png }, 'owner-2'); await tick();
  assert.equal(fixture.published.length, count);
  assert.equal(fixture.images.length, 0);
  assert.equal(fixture.objects.size, 0);
});

test('CEF artwork timeout cancels a stalled decoder, ignores its late completion and permits a fresh attempt', async () => {
  const fixture = install();
  fixture.art.update({ sheetUrl: cdn }, 'owner-1'); await tick();
  const late = fixture.images[0].onload;
  const timeout = [...fixture.timers.values()][0];
  assert.equal(timeout.delay, 15000);
  timeout.fn();
  assert.equal(fixture.published.at(-1).png, '');
  assert.equal(fixture.objects.size, 0);
  assert.equal(fixture.fetches[0].settings.signal.aborted, true);
  const count = fixture.published.length;
  fixture.images[0].naturalWidth = fixture.images[0].naturalHeight = 400;
  late(); await tick();
  assert.equal(fixture.published.length, count);
  fixture.art.update({ imageData: png }, 'owner-1'); await tick();
  fixture.images[1].load(); await tick();
  assert.equal(fixture.published.at(-1).png, png);
  assert.equal(fixture.timers.size, 0);
  fixture.art.dispose();
});

test('CEF artwork fetch failures and oversized bodies fail only the optional appearance', async () => {
  for (const fetch of [
    () => Promise.reject(Error('fixture offline')),
    (_url, _settings, response) => Promise.resolve(response({ ok: false })),
    (_url, _settings, response) => Promise.resolve(response({
      headers: { get: key => key.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024 + 1) : 'image/png' },
    })),
    (_url, _settings, response) => Promise.resolve(response({
      body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(6 * 1024 * 1024 + 1) }), cancel: async () => {} }) },
      arrayBuffer: async () => new ArrayBuffer(6 * 1024 * 1024 + 1),
      blob: async () => new Blob([new Uint8Array(6 * 1024 * 1024 + 1)], { type: 'image/png' }),
    })),
  ]) {
    const fixture = install({ fetch });
    fixture.art.update({ sheetUrl: cdn }, 'owner-1'); await tick();
    assert.equal(fixture.images.length, 0);
    assert.equal(fixture.published.at(-1).png, '');
    fixture.art.dispose();
  }
});

test('CEF bridge sends artwork separately from ordinary chat and invalid artwork cannot block text state', async () => {
  const fixture = install({ bridge: true });
  assert.equal(fixture.window.__keepworkCreatePetArtwork, undefined, 'the factory is private after bridge installation');
  fixture.bridge.onPetCommand(() => {});
  fixture.dispatch('connect', 'fixture-challenge');
  await fixture.bridge.publishPetState({ version: 1, context: 'owner-1', ready: true,
    draft: 'keep my draft', pet: { name: '哈奇', imageData: png }, credentials: 'omit' });
  await tick(); fixture.images[0].load(); await tick();
  const state = JSON.parse(fixture.calls.filter(call => call.kind === 'state').at(-1).payload);
  assert.equal(state.draft, 'keep my draft');
  assert.equal(state.ready, true);
  assert.equal(state.pet, undefined);
  assert.equal(state.credentials, undefined);
  const artwork = JSON.parse(fixture.calls.filter(call => call.kind === 'artwork').at(-1).payload);
  assert.deepEqual(artwork, { context: 'owner-1', name: '哈奇', png });
  await fixture.bridge.publishPetState({ version: 1, context: 'owner-1', ready: true,
    draft: 'new draft', pet: { imageData: 'data:image/svg+xml;base64,PHN2Zy8+' } });
  await tick();
  assert.equal(JSON.parse(fixture.calls.filter(call => call.kind === 'state').at(-1).payload).draft, 'new draft');
  assert.equal(JSON.parse(fixture.calls.filter(call => call.kind === 'artwork').at(-1).payload).png, '');
  fixture.navigate();
});

test('CEF bridge clears previous artwork on owner change and navigation suppresses pending decoder callbacks', async () => {
  const fixture = install({ bridge: true });
  fixture.bridge.onPetCommand(() => {}); fixture.dispatch('connect', 'fixture-challenge');
  await fixture.bridge.publishPetState({ version: 1, context: 'owner-1', pet: { imageData: png } });
  await tick(); fixture.images[0].load(); await tick();
  const before = fixture.calls.length;
  await fixture.bridge.publishPetState({ version: 1, context: 'owner-2', pet: { imageData: otherPng } });
  await tick();
  const newCalls = fixture.calls.slice(before);
  assert.ok(newCalls.some(call => call.kind === 'state'));
  for (const call of newCalls.filter(call => call.kind === 'artwork')) {
    const state = JSON.parse(call.payload);
    assert.equal(state.context, 'owner-2'); assert.equal(state.png, '');
  }
  const late = fixture.images[1].onload;
  fixture.navigate();
  const after = fixture.calls.length;
  fixture.images[1].naturalWidth = fixture.images[1].naturalHeight = 400;
  late(); await tick();
  assert.equal(fixture.calls.length, after);
  assert.equal(fixture.timers.size, 0);
  await assert.rejects(fixture.bridge.publishPetState({ version: 1, context: 'owner-2' }));
});
