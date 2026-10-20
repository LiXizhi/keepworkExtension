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
