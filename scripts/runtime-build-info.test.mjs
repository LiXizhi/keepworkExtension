import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runtimeBuildInfoPlugin } from './runtime-build-info.mjs';

const require = createRequire(new URL('../apps/vscode-extension/package.json', import.meta.url));
const { context } = require('esbuild');
const source = fileURLToPath(new URL('../src/core/runtimeBuildInfo.ts', import.meta.url));

test('bundle identity is fixed at build time and refreshed on incremental rebuilds', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'keepwork-build-info-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const commit = () => {
    git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const firstCommit = commit();
  const manifest = path.join(root, 'package.json');
  await fs.writeFile(manifest, JSON.stringify({ version: '1.2.3' }));
  const build = await context({
    stdin: { contents: `export { runtimeBuildInfo } from ${JSON.stringify(source)};`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [runtimeBuildInfoPlugin(root)],
  });
  t.after(() => build.dispose());
  const read = output => {
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(output.outputFiles[0].text, sandbox);
    return JSON.parse(JSON.stringify(sandbox.module.exports.runtimeBuildInfo));
  };
  const started = Date.now();
  const firstOutput = await build.rebuild();
  const first = read(firstOutput);
  assert.equal(first.version, '1.2.3');
  assert.equal(first.commit, firstCommit);
  assert.ok(Date.parse(first.builtAt) >= started && Date.parse(first.builtAt) <= Date.now());
  assert.deepEqual(read(firstOutput), first, 'loading/restarting the same bundle must not reset its build date');

  await fs.writeFile(manifest, JSON.stringify({ version: '1.2.4' }));
  const secondCommit = commit();
  const second = read(await build.rebuild());
  assert.equal(second.version, '1.2.4');
  assert.equal(second.commit, secondCommit);
  assert.notEqual(second.commit, first.commit);
  assert.ok(Date.parse(second.builtAt) > Date.parse(first.builtAt));
});
