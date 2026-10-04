const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeFiles } = require('../src/files.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'workspace'); fs.mkdirSync(root);
  return { dir, root, files: new NativeFiles(path.join(dir, 'grants.json')) };
}
test('native grants survive restart and support bytes, search, directories and deletion without MCP', t => {
  const { dir, root, files } = fixture(t); const grant = files.grant(root);
  const reopened = new NativeFiles(path.join(dir, 'grants.json'));
  const call = (op, rel, args) => reopened.execute(op, { rootId: grant.id, rel, ...args });
  call('write', 'nested/text.txt', { text: '你好 desktop' });
  assert.equal(Buffer.from(call('read', 'nested/text.txt').bytes).toString(), '你好 desktop');
  call('write', 'binary.dat', { bytes: new Uint8Array([0, 255, 128]) });
  assert.deepEqual([...call('read', 'binary.dat').bytes], [0, 255, 128]);
  assert.deepEqual(call('search', '', { query: 'TEXT', max: 10 }).files, ['nested/text.txt']);
  assert.equal(call('stat', 'missing').exists, false);
  assert.equal(call('read', 'missing'), null);
  call('mkdir', 'empty'); assert.equal(call('stat', 'empty').isDirectory, true);
  call('delete', 'nested', { folder: true }); assert.equal(call('stat', 'nested').exists, false);
  reopened.revoke(grant.id); assert.throws(() => call('read', 'binary.dat'), /not granted/);
});
test('remembered paths and traversal do not grant access', t => {
  const { root, files } = fixture(t);
  assert.throws(() => files.execute('read', { rootId: root, rel: 'x' }), /not granted/);
  const grant = files.grant(root);
  for (const rel of ['../secret', 'a/../../secret', '/absolute', 'C:\\secret', 'file:stream', 'bad\0name']) {
    assert.throws(() => files.resolve(grant.id, rel), /Invalid|escapes/);
  }
  assert.throws(() => files.execute('delete', { rootId: grant.id, rel: '', folder: true }), /root/);
});
test('junctions remain visible but cannot access ungranted targets; deletion only removes the link', t => {
  const { dir, root, files } = fixture(t);
  const external = path.join(dir, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret'), 'secret');
  fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const grant = files.grant(root);
  assert.equal(files.execute('list', { rootId: grant.id }).entries[0].symlink, true);
  assert.throws(() => files.execute('read', { rootId: grant.id, rel: 'linked/secret' }), /another folder grant/);
  assert.deepEqual(files.execute('search', { rootId: grant.id, query: 'secret' }).files, []);
  files.grant(external);
  assert.equal(Buffer.from(files.execute('read', { rootId: grant.id, rel: 'linked/secret' }).bytes).toString(), 'secret');
  files.execute('delete', { rootId: grant.id, rel: 'linked', folder: true });
  assert.equal(fs.readFileSync(path.join(external, 'secret'), 'utf8'), 'secret');
});
