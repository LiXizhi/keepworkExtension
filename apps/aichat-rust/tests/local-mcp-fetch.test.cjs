const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = () => fs.readFileSync(path.join(__dirname, '../src/localMcpFetch.js'), 'utf8')
  .replace(/export function installLocalMcpFetch/, 'function installLocalMcpFetch');
const tick = () => new Promise(setImmediate);
const base = 'http://localhost:8089';

function harness(options = {}) {
  const calls = [], fallback = [], streams = new Map(), listeners = new Map();
  const native = async payload => {
    calls.push(structuredClone(payload));
    if (options.message) {
      const result = options.message(payload);
      if (result !== undefined) return result;
    }
    if (payload.op === 'start') {
      streams.set(payload.id, [...(options.chunks || [Buffer.from('{"ok":true}')])]);
      return { status: options.status || 200, statusText: options.statusText || 'OK',
        headers: options.headers || [['Content-Type', 'application/json'], ['Mcp-Session-Id', 'legacy-session']], url: payload.url };
    }
    if (payload.op === 'read') {
      const chunks = streams.get(payload.id) || [];
      return chunks.length ? { done: false, data: Buffer.from(chunks.shift()).toString('base64') } : { done: true };
    }
    if (payload.op === 'cancel') { streams.delete(payload.id); return true; }
    throw Error('unexpected operation');
  };
  const original = (...args) => { fallback.push(args); return Promise.resolve(new Response('ordinary fetch')); };
  const window = {
    location: new URL(options.url || 'https://keepwork.com/chat?experience=simple#draft'),
    fetch: original,
    addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== callback)); },
  };
  window.top = options.subframe ? {} : window;
  if (options.handler !== false) window.webkit = { messageHandlers: { keepworkLocalMcp: { postMessage: native } } };
  const context = {
    window, location: window.location, document: {}, Request, Response, Headers, ReadableStream,
    AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    URL, Blob, FormData, URLSearchParams, crypto: { randomUUID }, atob, btoa, setTimeout, clearTimeout,
    fetch: original, console,
  };
  vm.runInNewContext(`${source()}\ninstallLocalMcpFetch({platform:${JSON.stringify(options.platform || 'darwin')},entryUrl:${JSON.stringify(options.entryUrl || 'https://keepwork.com/chat')}});`, context);
  return { window, calls, fallback, original, fire(name) { for (const fn of listeners.get(name) || []) fn(); } };
}

test('only a trusted HTTPS main-frame macOS page installs the optional transport', async () => {
  for (const options of [
    { platform: 'win32' }, { platform: 'linux' }, { subframe: true }, { handler: false },
    { url: 'http://localhost:3001/AIChat.html', entryUrl: 'http://localhost:3001/AIChat.html' },
    { url: 'https://evil.example/chat' }, { url: 'https://keepwork.com/other' },
    { url: 'https://user:secret@keepwork.com/chat' },
  ]) {
    const page = harness(options);
    assert.equal(page.window.fetch, page.original, JSON.stringify(options));
  }
  const custom = harness({ url: 'https://cdn.keepwork.com/release/AIChat.html?v=1', entryUrl: 'https://cdn.keepwork.com/release/AIChat.html' });
  assert.deepEqual(await (await custom.window.fetch(base + '/health')).json(), { ok: true });
});

test('all other fetch requests preserve the original call and Request body', async () => {
  const page = harness();
  for (const url of ['https://keepwork.com/api', 'http://localhost:8090/health', 'http://127.0.0.2:8089/health',
    'https://localhost:8089/health', 'http://localhost.evil:8089/health', 'http://user:secret@localhost:8089/health', '/api']) {
    const init = { method: 'POST', body: 'unchanged' };
    await page.window.fetch(url, init);
    assert.equal(page.fallback.at(-1)[0], url);
    assert.equal(page.fallback.at(-1)[1], init);
  }
  const request = new Request('https://keepwork.com/api', { method: 'POST', body: 'preserved' });
  await page.window.fetch(request);
  assert.equal(request.bodyUsed, false);
  assert.equal(page.calls.length, 0);
});

test('legacy MCP requests keep method, session/auth/owner headers and binary body bytes', async () => {
  const page = harness({ chunks: [Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}')] });
  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  const request = new Request(base + '/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer fixture-only', 'X-Agent-Owner': 'a'.repeat(32), Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': 'legacy-session', 'MCP-Protocol-Version': '2024-11-05',
  }, body: bytes });
  const response = await page.window.fetch(request, { targetAddressSpace: 'loopback' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), 'legacy-session');
  assert.equal((await response.json()).result.protocolVersion, '2024-11-05');
  const start = page.calls.find(value => value.op === 'start');
  assert.equal(start.method, 'POST');
  assert.equal(start.url, base + '/mcp');
  assert.deepEqual(Buffer.from(start.body || '', 'base64'), Buffer.from(bytes));
  const headers = new Headers(start.headers);
  assert.equal(headers.get('authorization'), 'Bearer fixture-only');
  assert.equal(headers.get('x-agent-owner'), 'a'.repeat(32));
  assert.equal(headers.get('mcp-protocol-version'), '2024-11-05');
  assert.match(start.document, /^[0-9a-f-]{36}$/i);
  assert.match(start.id, /^[0-9a-f-]{36}$/i);
  assert.equal(page.calls.filter(value => value.op === 'start').length, 1);
});

test('HTTP errors and empty-body statuses preserve standard Response behavior', async () => {
  const error = harness({ status: 404, statusText: 'Not Found', chunks: [Buffer.from('{"error":"unsupported"}')] });
  const response = await error.window.fetch(base + '/optional-feature');
  assert.equal(response.ok, false);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'unsupported' });
  for (const status of [204, 205, 304]) {
    const page = harness({ status, statusText: '', chunks: [] });
    const empty = await page.window.fetch(base + '/empty');
    assert.equal(empty.status, status);
    assert.equal(empty.body, null);
    assert.equal(await empty.text(), '');
  }
});

test('streaming SSE/NDJSON bytes use demand reads and native Response clone/bodyUsed semantics', async () => {
  const text = 'event: changed\ndata: {"agents":[]}\n\n{"cursor":1,"text":"你好"}\n';
  const bytes = Buffer.from(text), page = harness({ headers: [['Content-Type', 'text/event-stream']], chunks: [bytes.subarray(0, 13), bytes.subarray(13, 48), bytes.subarray(48)] });
  const response = await page.window.fetch('http://127.0.0.1:8089/agents/personas/events');
  assert.equal(response.bodyUsed, false);
  const copy = response.clone();
  assert.equal(await response.text(), text);
  assert.equal(response.bodyUsed, true);
  assert.equal(await copy.text(), text);
  assert.equal(page.calls.filter(value => value.op === 'start').length, 1);
  const start = page.calls.find(value => value.op === 'start');
  for (const read of page.calls.filter(value => value.op === 'read')) {
    assert.equal(read.id, start.id);
    assert.equal(read.document, start.document);
  }
});

test('aborted input never starts a mutation and an in-flight abort cancels without replay', async () => {
  const page = harness(), already = new AbortController(); already.abort();
  await assert.rejects(page.window.fetch(base + '/agents/personas', { method: 'POST', body: '{}', signal: already.signal }), { name: 'AbortError' });
  assert.equal(page.calls.filter(value => value.op === 'start').length, 0);
  let resolveStart;
  const pending = harness({ message: value => value.op === 'start' ? new Promise(resolve => { resolveStart = resolve; }) : undefined });
  const controller = new AbortController();
  const promise = pending.window.fetch(base + '/agents/personas', { method: 'POST', body: '{}', signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  resolveStart({ status: 200, statusText: 'OK', headers: [], url: base + '/agents/personas' });
  await tick();
  assert.equal(pending.calls.filter(value => value.op === 'start').length, 1);
  assert.ok(pending.calls.some(value => value.op === 'cancel'));
});

test('reader cancellation and native failures never trigger a second request', async () => {
  const page = harness({ chunks: [Buffer.from('first'), Buffer.from('second')] });
  const response = await page.window.fetch(base + '/terminal/sessions/fixture/stream?cursor=0');
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  await tick();
  assert.ok(page.calls.some(value => value.op === 'cancel'));
  assert.equal(page.calls.filter(value => value.op === 'start').length, 1);
  const failure = harness({ message: value => value.op === 'start' ? Promise.reject(Error('bounded native error')) : undefined });
  await assert.rejects(failure.window.fetch(base + '/mcp', { method: 'POST', body: '{}' }), /bounded native error/);
  assert.equal(failure.calls.filter(value => value.op === 'start').length, 1);
});

test('request bodies over the transport limit fail before native start', async () => {
  const page = harness();
  await assert.rejects(page.window.fetch(base + '/fs/file', { method: 'PUT', body: new Uint8Array(32 * 1024 * 1024 + 1) }), /32|large|limit|大小|上限/i);
  assert.equal(page.calls.filter(value => value.op === 'start').length, 0);
});


test('standard form and Blob bodies retain serialization and generated content types', async () => {
  const values = [
    [new URLSearchParams({ message: '你好', repeated: 'a b' }), 'application/x-www-form-urlencoded;charset=UTF-8', Buffer.from('message=%E4%BD%A0%E5%A5%BD&repeated=a+b')],
    [new Blob([Uint8Array.from([0, 128, 255])], { type: 'application/octet-stream' }), 'application/octet-stream', Buffer.from([0, 128, 255])],
  ];
  for (const [body, type, bytes] of values) {
    const page = harness();
    await (await page.window.fetch(base + '/fs/file', { method: 'POST', body })).text();
    const start = page.calls.find(value => value.op === 'start');
    assert.equal(new Headers(start.headers).get('content-type'), type);
    assert.deepEqual(Buffer.from(start.body, 'base64'), bytes);
  }
});

test('Abort during a pending stream read and pagehide release native work once', async () => {
  for (const navigate of [false, true]) {
    const page = harness({ message: value => value.op === 'read' ? new Promise(() => {}) : undefined });
    const controller = new AbortController();
    const response = await page.window.fetch(base + '/agents/personas/events', { signal: controller.signal });
    assert.equal(page.calls.filter(value => value.op === 'read').length, 0, 'response headers do not eagerly drain the stream');
    const reading = response.body.getReader().read();
    await tick();
    if (navigate) page.fire('pagehide'); else controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    await tick();
    assert.equal(page.calls.filter(value => value.op === 'start').length, 1);
    assert.equal(page.calls.filter(value => value.op === 'cancel').length, 1);
  }
});
