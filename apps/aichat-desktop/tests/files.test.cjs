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
test('native files read and write above 16 MB and enforce the same PPT/PDF and generic limits', t => {
  const { root, files } = fixture(t);
  const grant = files.grant(root);
  const call = (op, rel, args) => files.execute(op, { rootId: grant.id, rel, ...args });
  const payload = Buffer.alloc(17 * 1024 * 1024, 0x5a);
  call('write', '桂花雨.PPTX', { bytes: payload });
  assert.deepEqual(Buffer.from(call('read', '桂花雨.PPTX').bytes), payload);
  call('write', '手册.PDF', { bytes: payload });
  assert.deepEqual(Buffer.from(call('read', '手册.PDF').bytes), payload);
  for (const [name, limit] of [['oversize.pptx', 100 * 1024 * 1024], ['oversize.pdf', 100 * 1024 * 1024], ['oversize.bin', 1024 * 1024 * 1024]]) {
    fs.writeFileSync(path.join(root, name), '');
    fs.truncateSync(path.join(root, name), limit + 1);
    assert.throws(() => call('read', name), new RegExp(`read limit \\(${limit / 1024 / 1024} MiB\\)`));
  }
});
test('workspace links support onboarding browse and file operations without another grant; deletion preserves target', t => {
  const { dir, root, files } = fixture(t);
  const external = path.join(dir, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret'), 'secret');
  fs.symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const grant = files.grant(root);
  assert.equal(files.execute('list', { rootId: grant.id }).entries[0].symlink, true);
  assert.throws(() => files.resolve(grant.id, 'linked'), /another folder grant/);
  assert.equal(files.execute('list', { rootId: grant.id, rel: 'linked' }).entries[0].name, 'secret');
  assert.equal(files.execute('stat', { rootId: grant.id, rel: 'linked/secret' }).isFile, true);
  assert.deepEqual(files.execute('search', { rootId: grant.id, query: 'secret' }).files, ['linked/secret']);
  files.execute('write', { rootId: grant.id, rel: 'linked/new/file.txt', text: 'new' });
  assert.equal(fs.readFileSync(path.join(external, 'new/file.txt'), 'utf8'), 'new');
  assert.equal(files.roots().length, 1);
  assert.equal(Buffer.from(files.execute('read', { rootId: grant.id, rel: 'linked/secret' }).bytes).toString(), 'secret');
  files.execute('delete', { rootId: grant.id, rel: 'linked', folder: true });
  assert.equal(fs.readFileSync(path.join(external, 'secret'), 'utf8'), 'secret');
});

test('linked folders remain bounded, reject traversal, broken links and replaced roots', t => {
  const { dir, root, files } = fixture(t);
  const external = path.join(dir, 'external'); fs.mkdirSync(external);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(external, path.join(root, 'linked'), linkType);
  fs.symlinkSync(root, path.join(external, 'loop'), linkType);
  fs.symlinkSync(path.join(dir, 'missing'), path.join(root, 'broken'), linkType);
  fs.writeFileSync(path.join(external, 'note.txt'), 'note');
  const grant = files.grant(root);
  assert.deepEqual(files.execute('search', { rootId: grant.id, query: 'note' }).files, ['linked/note.txt']);
  assert.throws(() => files.execute('read', { rootId: grant.id, rel: 'linked/../note.txt' }), /Invalid/);
  assert.throws(() => files.execute('write', { rootId: grant.id, rel: 'broken/file', text: 'x' }), /Unavailable symlink/);
  fs.renameSync(root, root + '-old');
  fs.symlinkSync(external, root, linkType);
  assert.throws(() => files.execute('list', { rootId: grant.id }), /Folder changed/);
});

test('missing wiki directories return empty native listings without IPC exceptions', t => {
  const { root, files } = fixture(t); const { id: rootId } = files.grant(root);
  assert.deepEqual(files.execute('list', { rootId, rel: '_wiki' }), { entries: [], truncated: false });
  assert.deepEqual(files.execute('search', { rootId, rel: '_wiki' }), { files: [], truncated: false });
  assert.equal(files.execute('read', { rootId, rel: '_wiki/index.md' }), null);
  assert.throws(() => files.execute('list', { rootId, rel: '../_wiki' }), /Invalid relative path/);
  assert.throws(() => files.execute('list', { rootId: 'ungranted', rel: '_wiki' }), /not granted/);
});

test('native directory listing still reports permission failures', t => {
  const { root, files } = fixture(t); const { id: rootId } = files.grant(root);
  fs.mkdirSync(path.join(root, '_wiki'));
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (target, ...args) {
    if (target === path.join(root, '_wiki')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original.call(this, target, ...args);
  });
  assert.throws(() => files.execute('list', { rootId, rel: '_wiki' }), { code: 'EACCES' });
});
