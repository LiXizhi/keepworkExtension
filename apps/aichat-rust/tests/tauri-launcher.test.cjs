const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, runtimeTarget } = require('../scripts/tauri.cjs');

function fixture(env = {}) {
  const calls = [];
  const nodeRoot = path.resolve('fixture-node-runtime'), rustRoot = path.resolve('fixture-rust-runtime');
  const options = {
    env, appRoot: path.resolve(__dirname, '..'),
    prepareNodeRuntime: () => { calls.push({ action: 'prepare-node' }); return nodeRoot; },
    prepareRustRuntime: () => { calls.push({ action: 'prepare-rust' }); return rustRoot; },
    validateNodeRuntime: () => { calls.push({ action: 'validate-node' }); },
    validateRustRuntime: () => { calls.push({ action: 'validate-rust' }); },
    runTauri: async (args, launchEnv) => { calls.push({ action: 'tauri', args, env: launchEnv }); return 0; },
  };
  return { calls, options, nodeRoot, rustRoot };
}

test('ordinary desktop development prepares Rust MCP before starting Tauri', async () => {
  const f = fixture({ PATH: '/test/path', AICHAT_DESKTOP_LOCAL_SOURCE: '1' });
  assert.equal(await launch(['dev', '--no-watch'], f.options), 0);
  assert.equal(f.calls[0].action, 'prepare-rust');
  assert.equal(f.calls.some(call => call.action === 'prepare-node'), false);
  const started = f.calls.at(-1);
  assert.equal(started.action, 'tauri');
  assert.deepEqual(started.args, ['dev', '--no-watch']);
  assert.equal(started.env.AICHAT_MCP_BUNDLED_DIR, f.rustRoot);
  assert.equal(started.env.AICHAT_MCP_ENGINE, 'rust');
  assert.equal(started.env.PATH, '/test/path');
  assert.equal(started.env.AICHAT_DESKTOP_LOCAL_SOURCE, '1');
  assert.equal(f.options.env.AICHAT_MCP_BUNDLED_DIR, undefined, 'caller environment must not be mutated');
  assert.equal(f.options.env.AICHAT_MCP_ENGINE, undefined);
});

for (const args of [['--help'], ['dev', '--help'], ['dev', '-h'], ['dev', '-V'], ['build', '--target', 'aarch64-apple-darwin'], ['info']]) {
  test(`Tauri ${args.join(' ')} passes through without staging or selecting a runtime`, async () => {
    const f = fixture({ EXISTING: 'preserved' });
    assert.equal(await launch(args, f.options), 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { action: 'tauri', args, env: { EXISTING: 'preserved' } });
  });
}

for (const engine of ['rust', 'node']) {
  for (const mode of ['flag', 'environment']) {
    test(`explicit ${engine} development by ${mode} selects only that runtime`, async () => {
      const f = fixture(mode === 'environment' ? { AICHAT_MCP_ENGINE: engine } : {});
      await launch(mode === 'flag' ? [`--mcp-${engine}`, 'dev'] : ['dev'], f.options);
      assert.equal(f.calls[0].action, `prepare-${engine}`);
      assert.equal(f.calls.some(call => call.action === `prepare-${engine === 'rust' ? 'node' : 'rust'}`), false);
      assert.deepEqual(f.calls.at(-1).args, ['dev']);
      assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, engine === 'rust' ? f.rustRoot : f.nodeRoot);
      assert.equal(f.calls.at(-1).env.AICHAT_MCP_ENGINE, engine);
    });
  }
  test(`explicit ${engine} flag overrides an inherited opposite engine`, async () => {
    const f = fixture({ AICHAT_MCP_ENGINE: engine === 'rust' ? 'node' : 'rust' });
    await launch([`--mcp-${engine}`, 'dev'], f.options);
    assert.equal(f.calls[0].action, `prepare-${engine}`);
    assert.equal(f.calls.at(-1).env.AICHAT_MCP_ENGINE, engine);
  });
  for (const key of ['AICHAT_MCP_BUNDLED_DIR', 'AICHAT_MCP_RUNTIME_DIR']) {
    test(`a caller-selected ${engine} runtime via ${key} is validated and preserved`, async () => {
      const runtime = path.resolve('caller-selected-runtime');
      const f = fixture({ [key]: runtime, AICHAT_MCP_ENGINE: engine });
      await launch(['dev'], f.options);
      assert.equal(f.calls.some(call => call.action.startsWith('prepare-')), false);
      assert.equal(f.calls[0].action, `validate-${engine}`);
      assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, runtime);
      assert.equal(f.calls.at(-1).env.AICHAT_MCP_ENGINE, engine);
    });
  }
  test(`an invalid caller-selected ${engine} runtime prevents Tauri launch`, async () => {
    const f = fixture({ AICHAT_MCP_BUNDLED_DIR: path.resolve('invalid-runtime'), AICHAT_MCP_ENGINE: engine });
    f.options[engine === 'rust' ? 'validateRustRuntime' : 'validateNodeRuntime'] = () => { throw new Error(`invalid ${engine} runtime`); };
    await assert.rejects(launch(['dev'], f.options), new RegExp(`invalid ${engine} runtime`));
    assert.equal(f.calls.some(call => call.action === 'tauri' || call.action.startsWith('prepare-')), false);
  });
  test(`${engine} preparation failure prevents Tauri launch without switching engines`, async () => {
    const f = fixture({ AICHAT_MCP_ENGINE: engine });
    f.options[engine === 'rust' ? 'prepareRustRuntime' : 'prepareNodeRuntime'] = () => { throw new Error('runtime staging failed'); };
    await assert.rejects(launch(['dev'], f.options), /runtime staging failed/);
    assert.deepEqual(f.calls, []);
  });
}

test('bundled-directory override takes precedence over the generic runtime directory', async () => {
  const selected = path.resolve('preferred-runtime');
  const f = fixture({ AICHAT_MCP_BUNDLED_DIR: selected, AICHAT_MCP_RUNTIME_DIR: path.resolve('other-runtime') });
  await launch(['dev'], f.options);
  assert.equal(f.calls[0].action, 'validate-rust');
  assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, selected);
});

function rustRuntime(t, changes = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-rust-launcher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = runtimeTarget();
  const entry = target.platform === 'windows' ? 'bin/keepwork-mcp.exe' : 'bin/keepwork-mcp';
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, entry), '#!/bin/sh\n');
  fs.chmodSync(path.join(directory, entry), 0o755);
  const manifest = { schemaVersion: 2, id: 'keepwork-mcp', product: 'keepwork-mcp-runtime', engine: 'rust', version: '0.1.0', commit: 'a'.repeat(40), ...target, entry, ...changes };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(manifest));
  const f = fixture({ AICHAT_MCP_BUNDLED_DIR: directory });
  delete f.options.validateRustRuntime;
  return { directory, manifest, ...f };
}

test('default development accepts a complete caller-selected Rust manifest', async t => {
  const f = rustRuntime(t);
  await launch(['dev'], f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'tauri');
  assert.equal(f.calls[0].env.AICHAT_MCP_ENGINE, 'rust');
  assert.equal(f.calls[0].env.AICHAT_MCP_BUNDLED_DIR, f.directory);
});

for (const [name, changes] of [
  ['Node manifest', { schemaVersion: 1, product: 'keepwork-mcp-node-runtime', engine: 'node' }],
  ['legacy Node manifest without engine', { schemaVersion: 1, product: 'keepwork-mcp-node-runtime', engine: undefined }],
  ['unknown product', { product: 'unrelated-runtime' }],
  ['wrong platform', { platform: process.platform === 'win32' ? 'macos' : 'windows' }],
  ['wrong architecture', { arch: process.arch === 'arm64' ? 'x64' : 'arm64' }],
  ['missing source commit', { commit: undefined }],
  ['invalid source commit', { commit: 'not-a-commit' }],
  ['missing executable', { entry: 'bin/missing-runtime' }],
  ['escaping executable', { entry: '../outside-runtime' }],
]) {
  test(`default development rejects ${name} without silently starting Node`, async t => {
    const f = rustRuntime(t, changes);
    await assert.rejects(launch(['dev'], f.options));
    assert.deepEqual(f.calls, [], 'invalid overrides must not stage an alternative runtime or start Tauri');
  });
}

test('a Rust executable symlink cannot escape a caller-selected runtime', async t => {
  const f = rustRuntime(t);
  const outside = path.join(f.directory, '..', `${path.basename(f.directory)}-outside`);
  fs.writeFileSync(outside, '#!/bin/sh\n');
  fs.chmodSync(outside, 0o755);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.rmSync(path.join(f.directory, f.manifest.entry));
  try {
    fs.symlinkSync(outside, path.join(f.directory, f.manifest.entry));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks are unavailable in this environment');
    throw error;
  }
  await assert.rejects(launch(['dev'], f.options));
  assert.deepEqual(f.calls, []);
});

test('Tauri exit status and literal argument boundaries reach the caller unchanged', async () => {
  const f = fixture(); const args = ['dev', '--config', 'config with spaces/$(not-a-shell).json'];
  f.options.runTauri = async (received) => { assert.deepEqual(received, args); return 17; };
  assert.equal(await launch(args, f.options), 17);
});


for (const args of [['--verbose', 'dev'], ['-vv', 'dev'], ['dev', '--', '--help']]) {
  test(`Rust development startup remains selected with ${args.join(' ')}`, async () => {
    const f = fixture();
    await launch(args, f.options);
    assert.equal(f.calls[0].action, 'prepare-rust');
    assert.deepEqual(f.calls.at(-1).args, args);
    assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, f.rustRoot);
  });
}
