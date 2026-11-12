const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { uploadLargeEntry } = require('./lib/qiniu-release.cjs');

test('multipart requests mint a fresh upload token, including after a failed part attempt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-multipart-'));
  const filePath = path.join(dir, 'client.zip');
  fs.writeFileSync(filePath, Buffer.alloc(4 * 1024 * 1024 + 1));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const originalRequest = https.request;
  const authorizations = [];
  let failedPartOnce = false;
  https.request = (requestUrl, options, callback) => {
    authorizations.push(options.headers.Authorization);
    const request = new Writable({
      write(_chunk, _encoding, done) { done(); },
      final(done) {
        const method = options.method || 'GET';
        let statusCode = 200;
        let responseBody;
        if (method === 'PUT' && !failedPartOnce) {
          failedPartOnce = true;
          statusCode = 401;
          responseBody = JSON.stringify({ error: 'expired token' });
        } else if (method === 'PUT') {
          responseBody = JSON.stringify({ etag: 'part-etag' });
        } else if (method === 'POST' && options.headers['Content-Type'] === 'application/json') {
          responseBody = JSON.stringify({ key: 'release/client.zip' });
        } else if (method === 'POST') {
          responseBody = JSON.stringify({ uploadId: 'upload-1' });
        } else {
          statusCode = 500;
          responseBody = '{}';
        }
        process.nextTick(() => {
          const response = Readable.from([Buffer.from(responseBody)]);
          response.statusCode = statusCode;
          callback(response);
          done();
        });
      },
    });
    request.setTimeout = () => request;
    return request;
  };

  t.after(() => { https.request = originalRequest; });
  let nextToken = 0;
  await uploadLargeEntry(
    { bucket: 'haqi', uploadHost: 'https://upload.example.test' },
    { filePath, name: 'client.zip', remoteKey: 'release/client.zip', size: fs.statSync(filePath).size },
    () => `fresh-token-${++nextToken}`,
  );

  assert.deepEqual(authorizations, [
    'UpToken fresh-token-1',
    'UpToken fresh-token-2',
    'UpToken fresh-token-3',
    'UpToken fresh-token-4',
  ]);
});

test('exhausted part retries drain active uploads before aborting and never start later parts', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-abort-'));
  const filePath = path.join(dir, 'client.zip');
  // Five parts: four start together and the fifth must remain unstarted.
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 32 * 1024 * 1024 + 1);
  const originalRequest = https.request;
  const calls = [];
  const pending = new Map();
  const active = new Set();
  let draining = false;
  let failedAttempts = 0;
  let prepared;
  const ready = new Promise((resolve) => { prepared = resolve; });
  function checkReady() {
    if (failedAttempts === 3 && pending.size === 3) prepared();
  }
  https.request = (requestUrl, options, callback) => {
    const method = options.method || 'GET';
    const part = method === 'PUT' ? Number(new URL(requestUrl).pathname.split('/').pop()) : undefined;
    const operation = part ? `part:${part}`
      : method === 'DELETE' ? 'abort'
        : options.headers['Content-Type'] === 'application/json' ? 'complete' : 'initialize';
    calls.push(operation);
    let finished;
    const completion = new Promise((resolve) => { finished = resolve; });
    active.add(completion);
    const request = new Writable({
      write(_chunk, _encoding, done) { done(); },
      final(done) {
        const respond = () => {
          const body = part === 1 ? { error: 'part rejected' }
            : part ? { etag: `etag-${part}` }
              : operation === 'initialize' ? { uploadId: 'upload-1' } : { key: 'release/client.zip' };
          const response = Readable.from([Buffer.from(JSON.stringify(body))]);
          response.statusCode = part === 1 ? 503 : 200;
          response.on('end', () => { active.delete(completion); finished(); });
          callback(response);
          if (part === 1) { failedAttempts += 1; checkReady(); }
        };
        if (part && part !== 1 && !draining) {
          pending.set(part, respond);
          checkReady();
        } else {
          process.nextTick(respond);
        }
        done();
      },
    });
    request.setTimeout = () => request;
    return request;
  };

  let settled = false;
  const outcome = uploadLargeEntry(
    { bucket: 'haqi', uploadHost: 'https://upload.example.test' },
    { filePath, name: 'client.zip', remoteKey: 'release/client.zip', size: fs.statSync(filePath).size },
    () => 'test-token',
  ).then(
    () => { settled = true; return undefined; },
    (error) => { settled = true; return error; },
  );
  t.after(async () => {
    draining = true;
    for (const respond of pending.values()) respond();
    pending.clear();
    await outcome;
    do {
      await Promise.all([...active]);
      await new Promise(setImmediate);
    } while (active.size);
    https.request = originalRequest;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ready;
  await new Promise(setImmediate);
  assert.equal(failedAttempts, 3);
  assert.equal(settled, false, 'the failed upload cannot settle while sibling PUTs are still active');
  assert.ok(!calls.includes('abort'), 'DELETE must wait for all active parts');
  assert.ok(!calls.includes('part:5'));
  for (const part of [2, 3]) {
    pending.get(part)();
    pending.delete(part);
  }
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.ok(!calls.includes('abort'));
  assert.ok(!calls.includes('part:5'), 'workers must stop dequeuing after a sibling fails');

  pending.get(4)();
  pending.delete(4);
  assert.match((await outcome).message, /part 1 upload failed.*HTTP 503/);
  assert.equal(calls.filter((call) => call === 'abort').length, 1);
  assert.ok(!calls.includes('complete'));
  assert.ok(!calls.includes('part:5'));
});
