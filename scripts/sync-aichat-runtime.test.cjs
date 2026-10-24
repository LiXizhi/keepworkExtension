const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncRuntime } = require('./sync-aichat-runtime.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'AIChat', 'runtime'), dest = path.join(root, 'vendor');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'agent.mjs'), 'export const value = 1;\n');
  return { root, source, dest, freshness: () => undefined };
}
test('checks reject stale source without repairing it; sync handles added/deleted modules and tampering', t => {
  const options = fixture(t);
  syncRuntime(options);
  syncRuntime({ ...options, check: true });
  const target = path.join(options.dest, 'agent.cjs');
  const before = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(path.join(options.source, 'agent.mjs'), 'export const value = 2;\n');
  assert.throws(() => syncRuntime({ ...options, check: true }), /out of sync/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  syncRuntime(options);
  fs.writeFileSync(path.join(options.source, 'child.mjs'), 'export const child = true;');
  assert.throws(() => syncRuntime({ ...options, check: true }), /out of sync/);
  syncRuntime(options);
  fs.unlinkSync(path.join(options.source, 'child.mjs'));
  assert.throws(() => syncRuntime({ ...options, check: true }), /out of sync/);
  syncRuntime(options);
  assert.equal(fs.existsSync(path.join(options.dest, 'child.cjs')), false);
  fs.appendFileSync(target, '// tampered');
  assert.throws(() => syncRuntime({ ...options, check: true }), /modified/);
  fs.rmSync(options.source, { recursive: true });
  assert.throws(() => syncRuntime(options), /source missing/);
  assert.throws(() => syncRuntime({ ...options, check: true }), /source missing/);
});
test('default source resolves independently of current working directory', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'sync-aichat-runtime.cjs'), '--check'], { cwd: os.tmpdir() });
});

test('Git checkout with autocrlf preserves packaged runtime integrity', t => {
  const options = fixture(t);
  syncRuntime(options);
  const repo = path.join(options.root, 'checkout');
  const dest = path.join(repo, 'src/core/vendor/aichat-runtime');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../.gitattributes'), path.join(repo, '.gitattributes'));
  for (const file of fs.readdirSync(options.dest)) {
    fs.copyFileSync(path.join(options.dest, file), path.join(dest, file));
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'true');
  git('add', '.');
  for (const file of fs.readdirSync(dest)) fs.unlinkSync(path.join(dest, file));
  git('checkout-index', '--all', '--force');
  const source = path.join(options.root, 'absent/runtime');
  assert.deepEqual(syncRuntime({ source, dest }), []);
  assert.deepEqual(syncRuntime({ source, dest, check: true }), []);
  // Controlled reproduction: without the attributes, Windows checkout breaks hashes.
  fs.writeFileSync(path.join(repo, '.gitattributes'), '');
  for (const file of fs.readdirSync(dest)) fs.unlinkSync(path.join(dest, file));
  git('checkout-index', '--force', '--', 'src/core/vendor/aichat-runtime/agent.cjs');
  const checkedOut = fs.readFileSync(path.join(dest, 'agent.cjs'), 'utf8');
  assert.ok(checkedOut.includes('\r\n'));
  git('checkout-index', '--all', '--force');
  assert.deepEqual(syncRuntime({ source, dest }), []);
  fs.appendFileSync(path.join(dest, 'agent.cjs'), '// modified');
  assert.throws(() => syncRuntime({ source, dest }), /modified/);
});
test('build and watch automatically refresh canonical source edits and inventory changes', async t => {
  const options = fixture(t);
  const { aichatRuntimePlugin } = await import('./aichat-runtime-build.mjs');
  const { context } = require('../apps/vscode-extension/node_modules/esbuild');
  let completions = 0, latest;
  const ctx = await context({ stdin: { contents: `module.exports = require(${JSON.stringify(path.join(options.dest, 'agent.cjs'))});`, resolveDir: options.root },
    bundle: true, platform: 'node', write: false, logLevel: 'silent',
    plugins: [aichatRuntimePlugin(options), { name: 'observe', setup(build) { build.onEnd(result => { latest = result; completions++; }); } }] });
  t.after(() => ctx.dispose());
  await ctx.watch();
  async function waitFor(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(predicate(), 'watch rebuild completed');
    assert.deepEqual(latest.errors, []);
  }
  await waitFor(() => completions > 0);
  assert.match(latest.outputFiles[0].text, /value = 1/);
  await new Promise(resolve => setTimeout(resolve, 300));
  const previous = completions;
  fs.writeFileSync(path.join(options.source, 'agent.mjs'), 'export const value = 42;');
  await waitFor(() => completions > previous && latest.outputFiles?.[0].text.includes('value = 42'));
  await new Promise(resolve => setTimeout(resolve, 300));
  const beforeAddition = completions;
  fs.writeFileSync(path.join(options.source, 'extra.mjs'), 'export const extra = true;');
  await waitFor(() => completions > beforeAddition && fs.existsSync(path.join(options.dest, 'extra.cjs')));
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.unlinkSync(path.join(options.source, 'extra.mjs'));
  await waitFor(() => !fs.existsSync(path.join(options.dest, 'extra.cjs')));
  syncRuntime({ ...options, check: true });
});

test('standalone builds and checks verify the committed copy without AIChat', async t => {
  const options = fixture(t);
  syncRuntime(options);
  fs.rmSync(path.dirname(options.source), { recursive: true });
  const before = fs.readFileSync(path.join(options.dest, 'manifest.json'), 'utf8');
  assert.deepEqual(syncRuntime(options), []);
  assert.deepEqual(syncRuntime({ ...options, check: true }), []);
  assert.equal(fs.readFileSync(path.join(options.dest, 'manifest.json'), 'utf8'), before);
  const { aichatRuntimePlugin } = await import('./aichat-runtime-build.mjs');
  const { build } = require('../apps/vscode-extension/node_modules/esbuild');
  const buildOptions = { entryPoints: [path.join(options.dest, 'agent.cjs')], bundle: true,
    platform: 'node', write: false, logLevel: 'silent', plugins: [aichatRuntimePlugin(options)] };
  const result = await build(buildOptions);
  assert.match(result.outputFiles[0].text, /value = 1/);
  fs.appendFileSync(path.join(options.dest, 'agent.cjs'), '// tamper');
  assert.throws(() => syncRuntime({ ...options, check: true }), /modified/);
  await assert.rejects(build(buildOptions), /modified/);
});
test('standalone checks reject missing or extra modules and invalid manifests', t => {
  const options = fixture(t);
  syncRuntime(options);
  fs.rmSync(path.dirname(options.source), { recursive: true });
  const extra = path.join(options.dest, 'extra.cjs');
  fs.writeFileSync(extra, '');
  assert.throws(() => syncRuntime(options), /inventory/);
  fs.unlinkSync(extra);
  fs.unlinkSync(path.join(options.dest, 'agent.cjs'));
  assert.throws(() => syncRuntime(options), /inventory/);
  fs.writeFileSync(path.join(options.dest, 'manifest.json'), '{}');
  assert.throws(() => syncRuntime(options), /Invalid/);
  fs.unlinkSync(path.join(options.dest, 'manifest.json'));
  assert.throws(() => syncRuntime(options), /ENOENT/);
});
