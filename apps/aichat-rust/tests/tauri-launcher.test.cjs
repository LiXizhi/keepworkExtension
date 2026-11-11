const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { launch } = require('../scripts/tauri.cjs');

function fixture(env = {}) {
  const calls = [];
  const nodeRoot = path.resolve('fixture-node-runtime'), rustRoot = path.resolve('fixture-rust-runtime');
  const options = {
    env, appRoot: path.resolve(__dirname, '..'),
    prepareNodeRuntime: () => { calls.push({ action: 'prepare-node' }); return nodeRoot; },
    prepareRustRuntime: () => { calls.push({ action: 'prepare-rust' }); return rustRoot; },
    validateNodeRuntime: () => { calls.push({ action: 'validate-node' }); },
    runTauri: async (args, launchEnv) => { calls.push({ action: 'tauri', args, env: launchEnv }); return 0; },
  };
  return { calls, options, nodeRoot, rustRoot };
}

test('ordinary desktop development prepares the CLI-capable runtime before starting Tauri', async () => {
  const f = fixture({ PATH: '/test/path', AICHAT_DESKTOP_LOCAL_SOURCE: '1' });
  assert.equal(await launch(['dev', '--no-watch'], f.options), 0);
  assert.equal(f.calls[0].action, 'prepare-node');
  const started = f.calls.at(-1);
  assert.equal(started.action, 'tauri');
  assert.deepEqual(started.args, ['dev', '--no-watch']);
  assert.equal(started.env.AICHAT_MCP_BUNDLED_DIR, f.nodeRoot);
  assert.equal(started.env.PATH, '/test/path');
  assert.equal(started.env.AICHAT_DESKTOP_LOCAL_SOURCE, '1');
  assert.equal(f.options.env.AICHAT_MCP_BUNDLED_DIR, undefined, 'caller environment must not be mutated');
});

for (const args of [['--help'], ['dev', '--help'], ['dev', '-h'], ['dev', '-V'], ['build', '--target', 'aarch64-apple-darwin'], ['info']]) {
  test(`Tauri ${args.join(' ')} passes through without staging or selecting a runtime`, async () => {
    const f = fixture({ EXISTING: 'preserved' });
    assert.equal(await launch(args, f.options), 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { action: 'tauri', args, env: { EXISTING: 'preserved' } });
  });
}

for (const mode of ['flag', 'environment']) {
  test(`explicit Rust preview by ${mode} remains opt-in`, async () => {
    const f = fixture(mode === 'environment' ? { AICHAT_MCP_ENGINE: 'rust' } : {});
    await launch(mode === 'flag' ? ['--mcp-rust', 'dev'] : ['dev'], f.options);
    assert.equal(f.calls[0].action, 'prepare-rust');
    assert.equal(f.calls.some(call => call.action === 'prepare-node'), false);
    assert.deepEqual(f.calls.at(-1).args, ['dev']);
    assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, f.rustRoot);
  });
}

test('a caller-selected complete Node runtime is validated and preserved', async () => {
  const runtime = path.resolve('caller-selected-runtime');
  const f = fixture({ AICHAT_MCP_BUNDLED_DIR: runtime });
  await launch(['dev'], f.options);
  assert.equal(f.calls.some(call => call.action === 'prepare-node'), false);
  assert.equal(f.calls.some(call => call.action === 'validate-node'), true);
  assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, runtime);
});

test('an invalid caller-selected runtime prevents Tauri launch', async () => {
  const f = fixture({ AICHAT_MCP_BUNDLED_DIR: path.resolve('invalid-runtime') });
  f.options.validateNodeRuntime = () => { throw new Error('runtime has no valid Node manifest'); };
  await assert.rejects(launch(['dev'], f.options), /valid Node manifest/);
  assert.equal(f.calls.some(call => call.action === 'tauri'), false);
});

test('runtime preparation failure prevents Tauri launch and preserves the cause', async () => {
  const f = fixture();
  f.options.prepareNodeRuntime = () => { throw new Error('runtime staging failed'); };
  await assert.rejects(launch(['dev'], f.options), /runtime staging failed/);
  assert.equal(f.calls.some(call => call.action === 'tauri'), false);
});

test('Tauri exit status and literal argument boundaries reach the caller unchanged', async () => {
  const f = fixture(); const args = ['dev', '--config', 'config with spaces/$(not-a-shell).json'];
  f.options.runTauri = async (received) => { assert.deepEqual(received, args); return 17; };
  assert.equal(await launch(args, f.options), 17);
});


for (const args of [['--verbose', 'dev'], ['-vv', 'dev'], ['dev', '--', '--help']]) {
  test(`development startup remains selected with ${args.join(' ')}`, async () => {
    const f = fixture();
    await launch(args, f.options);
    assert.equal(f.calls[0].action, 'prepare-node');
    assert.deepEqual(f.calls.at(-1).args, args);
    assert.equal(f.calls.at(-1).env.AICHAT_MCP_BUNDLED_DIR, f.nodeRoot);
  });
}
