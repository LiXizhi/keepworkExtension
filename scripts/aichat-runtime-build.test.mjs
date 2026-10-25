import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { aichatRuntimePlugin } from './aichat-runtime-build.mjs';
const require = createRequire(import.meta.url);
const { context, build } = require('../apps/vscode-extension/node_modules/esbuild');
const { syncRuntime } = require('./sync-aichat-runtime.cjs');

test('development watches local modules without syncing packaged bytes or provenance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-dev-'));
  const source = path.join(root, 'AIChat/runtime'), dest = path.join(root, 'vendor');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'agent.mjs'), 'export const value = 1;');
  syncRuntime({ source, dest, freshness: () => undefined });
  const snapshot = () => fs.readdirSync(dest).sort().map(f => [f, fs.readFileSync(path.join(dest, f), 'utf8')]);
  const before = snapshot();
  fs.writeFileSync(path.join(source, 'agent.mjs'), "export { value } from './new.mjs';");
  fs.writeFileSync(path.join(source, 'new.mjs'), 'export const value = 42;');
  const options = {
    stdin: { contents: `module.exports = require(${JSON.stringify(path.join(dest, 'agent.cjs'))});`, resolveDir: root },
    bundle: true, platform: 'node', write: false, logLevel: 'silent',
  };
  const freshness = () => { throw Error('release freshness required'); };
  let latest;
  const ctx = await context({ ...options, plugins: [aichatRuntimePlugin({ source, dest, development: true, freshness }),
    { name: 'observe', setup(b) { b.onEnd(result => { latest = result; }); } }] });
  t.after(async () => { await ctx.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const value = () => {
    if (!latest || latest.errors.length) return undefined;
    const sandbox = { module: { exports: {} } };
    vm.runInNewContext(latest.outputFiles[0].text, sandbox);
    return sandbox.module.exports.value;
  };
  async function waitFor(expected) {
    const deadline = Date.now() + 10000;
    while (value() !== expected && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(value(), expected);
  }
  await ctx.watch();
  await waitFor(42);
  fs.writeFileSync(path.join(source, 'new.mjs'), 'export const value = 43;');
  await waitFor(43);
  assert.deepEqual(snapshot(), before);
  await assert.rejects(build({ ...options, plugins: [aichatRuntimePlugin({ source, dest, freshness })] }), /release freshness required/);
  assert.deepEqual(snapshot(), before);
  await ctx.dispose();
  fs.rmSync(path.dirname(source), { recursive: true });
  const fallback = await build({ ...options, plugins: [aichatRuntimePlugin({ source, dest, development: true, freshness })] });
  assert.match(fallback.outputFiles[0].text, /value = 1/);
  fs.appendFileSync(path.join(dest, 'agent.cjs'), '// tamper');
  await assert.rejects(build({ ...options, plugins: [aichatRuntimePlugin({ source, dest, development: true })] }), /modified/);
});
