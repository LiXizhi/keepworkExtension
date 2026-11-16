import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { aichatRuntimePlugin } from './aichat-runtime-build.mjs';
const require = createRequire(import.meta.url);
const { context, build } = require('../apps/mcp-runtime/node_modules/esbuild');
const { syncRuntime } = require('./sync-aichat-runtime.cjs');

test('explicit packaged builds ignore canonical drift, never sync and still reject modified vendor bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-packaged-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'AIChat/runtime'), dest = path.join(root, 'vendor');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'agent.mjs'), 'export const value = 1;');
  syncRuntime({ source, dest, freshness: () => undefined });
  const before = fs.readdirSync(dest).sort().map(file => [file, fs.readFileSync(path.join(dest, file), 'utf8')]);
  fs.writeFileSync(path.join(source, 'agent.mjs'), 'export const value = 42;');
  const options = {
    entryPoints: [path.join(dest, 'agent.cjs')], bundle: true, platform: 'node', write: false, logLevel: 'silent',
    plugins: [aichatRuntimePlugin({ source, dest, mode: 'packaged', development: true, freshness: () => { throw Error('packaged must never synchronize'); } })],
  };
  const result = await build(options);
  assert.match(result.outputFiles[0].text, /value = 1/);
  assert.doesNotMatch(result.outputFiles[0].text, /value = 42/);
  assert.deepEqual(fs.readdirSync(dest).sort().map(file => [file, fs.readFileSync(path.join(dest, file), 'utf8')]), before);
  // Verify the documented environment route in a separate process so the test
  // cannot affect other builds running in this worker.
  const module = pathToFileURL(path.join(import.meta.dirname, 'aichat-runtime-build.mjs')).href;
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const {build}=require(${JSON.stringify(require.resolve('../apps/mcp-runtime/node_modules/esbuild'))}); const {aichatRuntimePlugin}=await import(${JSON.stringify(module)}); const result=await build({entryPoints:[${JSON.stringify(path.join(dest, 'agent.cjs'))}],bundle:true,platform:'node',write:false,logLevel:'silent',plugins:[aichatRuntimePlugin({source:${JSON.stringify(source)},dest:${JSON.stringify(dest)},development:true,freshness:()=>{throw Error('must not sync')}})]}); console.log(result.outputFiles[0].text);`;
  const envResult = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, KEEPWORK_AICHAT_RUNTIME_MODE: 'packaged' }, encoding: 'utf8' });
  assert.match(envResult, /value = 1/);
  assert.doesNotMatch(envResult, /value = 42/);
  fs.appendFileSync(path.join(dest, 'agent.cjs'), '// tampered');
  await assert.rejects(build(options), /modified/);
  assert.throws(() => aichatRuntimePlugin({ mode: 'typo' }), /mode must be/);
});

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
