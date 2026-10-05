const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeFiles } = require('../src/files.cjs');
const { defaultBrainFolder } = require('../src/brainFolder.cjs');

test('Documents preview has no side effects; explicit preparation preserves files and reuses grants', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documents = path.join(root, '文档 with spaces');
  const files = new NativeFiles(path.join(root, 'grants.json'));
  const preview = defaultBrainFolder(files, documents);
  assert.equal(preview.path, path.join(documents, 'MyBrain'));
  assert.equal(fs.existsSync(documents), false);
  assert.deepEqual(files.roots(), []);
  const grant = defaultBrainFolder(files, documents, true);
  fs.writeFileSync(path.join(grant.path, 'knowledge.md'), 'existing knowledge');
  assert.equal(defaultBrainFolder(files, documents, true).id, grant.id);
  assert.equal(fs.readFileSync(path.join(grant.path, 'knowledge.md'), 'utf8'), 'existing knowledge');
  assert.equal(files.roots().length, 1);
});

test('occupied MyBrain is rejected without granting or overwriting it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-occupied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new NativeFiles(path.join(root, 'grants.json'));
  const target = path.join(root, 'MyBrain'); fs.writeFileSync(target, 'preserve me');
  assert.throws(() => defaultBrainFolder(files, root, true), /占用/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve me');
  assert.deepEqual(files.roots(), []);
});

test('a MyBrain link cannot silently grant a different directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(root, 'MyBrain'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = new NativeFiles(path.join(root, 'grants.json'));
  assert.throws(() => defaultBrainFolder(files, root, true), /占用/);
  assert.deepEqual(files.roots(), []);
});
