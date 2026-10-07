import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creationSkillPlugin } from './creation-skill-build.mjs';

const canonical = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/paracraft-create');
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'keepwork-skill-build-'));
  assert.equal(path.dirname(root), parent);
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith('keepwork-skill-build-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const out = path.join(root, 'dist');await fs.mkdir(out);
  let finish;creationSkillPlugin(out).setup({onEnd(callback) { finish = callback; }});
  return {root, out, finish, target:path.join(out, 'skills/paracraft-create')};
}
async function contents(root, relative = '') {
  const result = {};
  for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes:true})) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await contents(root, file));
    else result[file] = await fs.readFile(path.join(root, file), 'utf8');
  }
  return result;
}

test('successful rebuild is an exact canonical copy and removes obsolete subskills', async t => {
  const f = await fixture(t);await f.finish({errors:[]});
  await fs.writeFile(path.join(f.target, 'obsolete.md'), 'removed guide');
  await fs.writeFile(path.join(f.target, 'SKILL.md'), 'outdated root');
  const neighbor = path.join(f.out, 'cli.js');await fs.writeFile(neighbor, 'leave build entry intact');
  await f.finish({errors:[]});
  assert.deepEqual(await contents(f.target), await contents(canonical));
  assert.deepEqual(await contents(path.join(f.out, 'skills/agent-cli-verify')), await contents(path.resolve(canonical, '../agent-cli-verify')));
  assert.equal(await fs.readFile(neighbor, 'utf8'), 'leave build entry intact');
});
test('failed build retains the last successful skill output', async t => {
  const f = await fixture(t);await f.finish({errors:[]});
  const before = await contents(f.target);await f.finish({errors:[{text:'compile failure'}]});
  assert.deepEqual(await contents(f.target), before);
});
test('output cannot overwrite or recursively copy the canonical skill', async () => {
  const before = await contents(canonical);
  for (const out of [path.dirname(path.dirname(canonical)), canonical]) {
    let finish;creationSkillPlugin(out).setup({onEnd(callback) { finish = callback; }});
    await assert.rejects(finish({errors:[]}), /overlaps canonical source/);
  }
  assert.deepEqual(await contents(canonical), before);
});
test('linked output parent or target cannot delete or overwrite another directory', async t => {
  for (const linkedParent of [true, false]) {
    const f = await fixture(t);const other = path.join(f.root, 'other');await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'keep.txt'), 'protected');
    if (!linkedParent) await fs.mkdir(path.join(f.out, 'skills'));
    await fs.symlink(other, linkedParent ? path.join(f.out, 'skills') : f.target, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.finish({errors:[]}), /must not be a link/);
    assert.equal(await fs.readFile(path.join(other, 'keep.txt'), 'utf8'), 'protected');
  }
});
