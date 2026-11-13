const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { createUploadToken, uploadEntry, uploadLargeEntry } = require('./lib/qiniu-release.cjs');

function uploadPolicy(token) {
  return JSON.parse(Buffer.from(token.split(':')[2], 'base64url').toString('utf8'));
}

test('insert-only upload tokens preserve the legacy deadline and default overwrite policy', () => {
  const deadline = 1234567890;
  const expected = { scope: 'haqi:release/client.zip', deadline };
  const token = options => createUploadToken('fixture-access', 'fixture-secret', 'haqi', 'release/client.zip', deadline, options);
  assert.deepEqual(uploadPolicy(token()), expected);
  for (const insertOnly of [undefined, false, 0, 1, 'true']) {
    assert.deepEqual(uploadPolicy(token({ insertOnly })), expected);
  }
  assert.deepEqual(uploadPolicy(token({ insertOnly: true })), { ...expected, insertOnly: 1 });
});

test('form and multipart uploads carry insert-only policy only when explicitly enabled', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-upload-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policies = [];
  t.mock.method(https, 'request', (requestUrl, options, callback) => {
    const form = options.headers['Content-Type']?.startsWith('multipart/form-data');
    const chunks = [];
    if (options.headers.Authorization) policies.push(uploadPolicy(options.headers.Authorization.slice('UpToken '.length)));
    const request = new Writable({
      write(chunk, _encoding, done) { if (form) chunks.push(chunk); done(); },
      final(done) {
        if (form) {
          const match = Buffer.concat(chunks).toString('utf8').match(/name="token"\r\n\r\n([^\r]+)/);
          policies.push(uploadPolicy(match[1]));
        }
        const body = options.method === 'PUT' ? { etag: 'part-etag' }
          : new URL(requestUrl).pathname.endsWith('/uploads') ? { uploadId: 'upload-1' }
            : { key: 'release/client.zip' };
        process.nextTick(() => {
          const response = Readable.from([Buffer.from(JSON.stringify(body))]);
          response.statusCode = 200;
          callback(response);
          done();
        });
      },
    });
    request.setTimeout = () => request;
    return request;
  });

  for (const size of [7, 4 * 1024 * 1024 + 1]) {
    const filePath = path.join(dir, `${size}.zip`);
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, size);
    for (const insertOnly of [undefined, true]) {
      policies.length = 0;
      await uploadEntry({
        accessKey: 'fixture-access', secretKey: 'fixture-secret', bucket: 'haqi',
        uploadHost: 'https://upload.example.test', insertOnly,
      }, { filePath, name: 'client.zip', remoteKey: 'release/client.zip', size });
      assert.equal(policies.length, size > 4 * 1024 * 1024 ? 3 : 1);
      for (const policy of policies) {
        assert.equal(policy.scope, 'haqi:release/client.zip');
        assert.ok(policy.deadline > Math.floor(Date.now() / 1000));
        if (insertOnly) assert.equal(policy.insertOnly, 1);
        else assert.equal(Object.hasOwn(policy, 'insertOnly'), false);
      }
    }
  }
});

test('form and multipart uploads preserve default metadata and apply explicit JSON cache metadata', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-upload-metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  t.mock.method(https, 'request', (requestUrl, options, callback) => {
    const chunks = [];
    const request = new Writable({
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        requests.push({ method: options.method, type: options.headers['Content-Type'], body: Buffer.concat(chunks) });
        const body = options.method === 'PUT' ? { etag: 'part-etag' }
          : new URL(requestUrl).pathname.endsWith('/uploads') ? { uploadId: 'metadata-upload' }
            : { key: 'release/latest.json' };
        process.nextTick(() => {
          const response = Readable.from([Buffer.from(JSON.stringify(body))]); response.statusCode = 200;
          callback(response); done();
        });
      },
    });
    request.setTimeout = () => request;
    return request;
  });
  const config = { accessKey: 'fixture-access', secretKey: 'fixture-secret', bucket: 'haqi', uploadHost: 'https://upload.example.test' };
  for (const size of [7, 4 * 1024 * 1024 + 1]) {
    const filePath = path.join(dir, `${size}.json`);
    fs.closeSync(fs.openSync(filePath, 'w')); fs.truncateSync(filePath, size);
    for (const explicit of [false, true]) {
      requests.length = 0;
      const metadata = explicit ? { mimeType: 'application/json', cacheControl: 'public, max-age=60, must-revalidate' } : {};
      await uploadEntry(config, { filePath, name: 'latest.json', remoteKey: 'release/latest.json', size, ...metadata });
      if (size > 4 * 1024 * 1024) {
        const complete = requests.find(request => request.type === 'application/json');
        const body = JSON.parse(complete.body.toString());
        assert.equal(body.mimeType, explicit ? 'application/json' : 'application/octet-stream');
        assert.deepEqual(body.parts, [{ partNumber: 1, etag: 'part-etag' }]);
        if (explicit) assert.equal(body.cacheControl, metadata.cacheControl);
        else assert.equal(Object.hasOwn(body, 'cacheControl'), false);
        assert.equal(requests.find(request => request.method === 'PUT').type, 'application/octet-stream', 'part bytes remain binary');
      } else {
        const form = requests[0].body.toString();
        assert.match(form, new RegExp('Content-Type: ' + (explicit ? 'application/json' : 'application/octet-stream') + '\\r\\n'));
        if (explicit) assert.ok(form.includes('name="cacheControl"\r\n\r\npublic, max-age=60, must-revalidate\r\n'));
        else assert.equal(form.includes('name="cacheControl"'), false);
      }
    }
  }
});

test('invalid object metadata fails before making an upload request', async (t) => {
  let requests = 0;
  t.mock.method(https, 'request', () => { requests += 1; throw Error('Unexpected upload'); });
  for (const size of [7, 4 * 1024 * 1024 + 1]) {
    for (const metadata of [{ mimeType: 'application/json\r\nInjected: true' }, { mimeType: '' },
      { cacheControl: 'max-age=60\r\nInjected: true' }, { cacheControl: '' }]) {
      await assert.rejects(uploadEntry({ accessKey: 'fixture-access', secretKey: 'fixture-secret', bucket: 'haqi', uploadHost: 'https://upload.example.test' },
        { filePath: '/not-read-by-this-test', name: 'latest.json', remoteKey: 'release/latest.json', size, ...metadata }), /Invalid Qiniu object/);
    }
  }
  assert.equal(requests, 0);
});

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
