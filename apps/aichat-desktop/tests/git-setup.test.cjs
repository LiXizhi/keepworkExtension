const test = require('node:test');
const assert = require('node:assert/strict');
const { checkGit, installGit } = require('../src/gitSetup.cjs');
test('Git detection validates version, searches installed locations, and never installs', async () => {
  const calls = [];
  const result = await checkGit({ platform: 'win32', env: { ProgramFiles: 'C:/Programs' }, execute: async (file, args) => {
    calls.push([file, args]); if (file === 'git') return 'git version 2.50.0'; throw Error('not found');
  } });
  assert.equal(result.ready, true); assert.equal(result.executable, 'git');
  assert.ok(calls.every(([, args]) => args[0] === '--version'));
});
test('missing Mac command line tools do not trigger installation during detection', async () => {
  const calls = [];
  assert.equal((await checkGit({ platform: 'darwin', execute: async (file, args) => { calls.push([file, args]); throw Error('not installed'); } })).ready, false);
  assert.ok(!calls.some(([, args]) => args.includes('--install')));
});
test('explicit Git installation uses fixed official platform commands and propagates failure', async () => {
  const calls = []; const execute = async (file, args) => { calls.push([file, args]); return ''; };
  await installGit({ platform: 'win32', execute }); await installGit({ platform: 'darwin', execute });
  assert.deepEqual(calls[0][1].slice(0, 6), ['install', '--id', 'Git.Git', '-e', '--source', 'winget']);
  assert.deepEqual(calls[1], ['/usr/bin/xcode-select', ['--install']]);
  await assert.rejects(installGit({ platform: 'win32', execute: async () => { throw Error('offline'); } }), /offline/);
});
