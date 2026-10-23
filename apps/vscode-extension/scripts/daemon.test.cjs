const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

function fixture(overrides = {}, options = {}) {
    const calls = [];
    let health = { name: 'keepwork-mcp', pid: 32100, runtimeVersion: '1.0.0', ...overrides };
    let probes = 0;
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/vscode/daemon.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, {
        exports, URLSearchParams, AbortSignal,
        setTimeout: callback => callback(),
        process: { platform: 'win32', pid: 999, env: {}, kill(pid, signal) {
            calls.push(['kill', pid, signal]);
            if (options.killError) throw new Error('denied');
            if (!options.stuck) health = null;
        } },
        fetch: async url => {
            assert.ok(url.endsWith('/health'), 'unexpected admin stop');
            probes++;
            if (probes === 2 && options.race) health = options.race;
            if (!health) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => health };
        },
        require(name) {
            if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
            if (name === 'node:fs') return { existsSync: () => !options.missing, mkdirSync() {}, openSync: () => 1, closeSync() {} };
            if (name === 'node:child_process') return {
                execFile: (_cmd, _args, _opts, callback) => callback(null, 'node'),
                spawn: () => { calls.push(['spawn']); health = { name: 'keepwork-mcp', pid: 32101, runtimeVersion: '2.0.0' }; return { unref() {} }; },
            };
            if (name.endsWith('/runtimeBuildInfo')) return { runtimeBuildInfo: { version: '2.0.0' } };
            if (name.endsWith('/config')) return { SERVER_NAME: 'keepwork-mcp', DEFAULT_WORKSPACE_SLOT: 'default', resolvePort: () => 8089, mcpHomeDir: () => 'fixture-home' };
            if (name.endsWith('/paths')) return { resolveWorkspaceRoot: () => 'fixture-workspace' };
            return require(name);
        },
    });
    return { calls, run: () => exports.ensureDaemon({ extensionPath: 'fixture-extension' }) };
}

test('newer extension replaces the older daemon before spawning, coalescing concurrent startup', async () => {
    const f = fixture();
    const first = f.run();
    assert.equal(f.run(), first);
    assert.equal((await first).runtimeVersion, '2.0.0');
    assert.deepEqual(f.calls, [['kill', 32100, 'SIGKILL'], ['spawn']]);
});

test('equal, newer, prerelease-aware and unknown runtime versions are preserved', async () => {
    for (const runtimeVersion of ['2.0.0', '10.0.0', '2.1.0-beta.1', undefined, 'unknown']) {
        const f = fixture({ runtimeVersion, version: '0.1.2' });
        assert.equal((await f.run()).ok, true);
        assert.deepEqual(f.calls, []);
    }
    const f = fixture({ runtimeVersion: '2.0.0-beta.1' });
    await f.run();
    assert.equal(f.calls[0][0], 'kill');
});

test('newer shared runtime is preserved even with a different workspace preference', async () => {
    const f = fixture({ runtimeVersion: '3.0.0', workspaceRoot: 'another-root' });
    assert.equal((await f.run()).runtimeVersion, '3.0.0');
    assert.deepEqual(f.calls, []);
});

test('unknown services, missing local CLI and invalid PID cannot trigger termination', async () => {
    for (const [health, options] of [[{ name: 'other' }], [{ name: undefined }], [{ pid: 0 }], [{ pid: 999 }], [{ pid: undefined }], [{}, { missing: true }]]) {
        const f = fixture(health, options);
        assert.equal((await f.run()).ok, false);
        assert.deepEqual(f.calls, []);
    }
});

test('listener replaced by another client is attached without killing the replacement', async () => {
    const f = fixture({}, { race: { name: 'keepwork-mcp', pid: 45600, runtimeVersion: '3.0.0' } });
    assert.equal((await f.run()).pid, 45600);
    assert.deepEqual(f.calls, []);
});

test('termination failures never launch a competing daemon', async () => {
    for (const options of [{ killError: true }, { stuck: true }]) {
        const f = fixture({}, options);
        assert.equal((await f.run()).ok, false);
        assert.deepEqual(f.calls, [['kill', 32100, 'SIGKILL']]);
    }
});
