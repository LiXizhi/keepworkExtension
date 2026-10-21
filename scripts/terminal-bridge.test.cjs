const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, overrides, extra = {}) {
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, Buffer, URL, process, AbortController, setTimeout, clearTimeout,
        require: name => overrides[name] || require(name), ...extra });
    return exports;
}

async function editor(t, { shell = 'pwsh.exe', mode = 'stall' } = {}) {
    const ends = new Set(), closes = new Set();
    let info, publish;
    const ready = new Promise(r => { publish = r; });
    const state = { runs: 0, ends, closes };
    const terminal = { creationOptions: { shellPath: shell }, show() {}, shellIntegration: {
        executeCommand() {
            state.runs++;
            const execution = { read() { return (async function* () {
                yield 'latency_probe\r\n';
                if (mode === 'end-stalled') setTimeout(() => ends.forEach(fn => fn({ execution, exitCode: 0 })), 0);
                if (mode === 'complete') { setTimeout(() => ends.forEach(fn => fn({ execution, exitCode: 0 })), 0); return; }
                if (mode === 'close') setTimeout(() => closes.forEach(fn => fn(terminal)), 0);
                await new Promise(() => {});
            })(); } };
            return execution;
        },
    } };
    const event = listeners => fn => { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; };
    const mod = load('apps/vscode-extension/src/vscode/terminalBridge.ts', {
        vscode: { env: { shell }, window: { terminals: [Object.assign(terminal, { name: 'Keepwork' })],
            onDidEndTerminalShellExecution: event(ends), onDidCloseTerminal: event(closes) } },
        '../../../../src/core/config': { BIND_HOST: '127.0.0.1', OUTPUT_CHAR_CAP: 24000,
            writeTerminalBridge(value) { info = value; publish(); }, clearTerminalBridge() {} },
        '../../../../src/core/terminalEncoding': { POWERSHELL_UTF8_INIT: '', cmdUtf8Command: c => c },
    }, { process: { platform: 'win32', pid: process.pid } });
    const handle = mod.startTerminalBridge();
    t.after(() => handle.dispose());
    await ready;
    state.run = async () => {
        const r = await fetch(`http://127.0.0.1:${info.port}/run`, { method: 'POST',
            headers: { Authorization: `Bearer ${info.token}` },
            body: JSON.stringify({ command: 'echo latency_probe', cwd: 'C:\\fixture', timeoutMs: 150 }) });
        return { status: r.status, body: await r.json() };
    };
    return state;
}

test('cmd is rejected before execution even if shellIntegration exists', async t => {
    const s = await editor(t, { shell: 'C:\\Windows\\System32\\cmd.exe' });
    const r = await s.run();
    assert.equal(r.status, 503); assert.equal(r.body.executed, false); assert.equal(s.runs, 0);
});
test('output followed by a stalled reader returns at the deadline with partial output', { timeout: 2000 }, async t => {
    const s = await editor(t);
    const r = await s.run();
    assert.equal(r.body.timedOut, true); assert.equal(r.body.ok, false);
    assert.match(r.body.stdout, /latency_probe/); assert.match(r.body.stderr, /not retried/);
    assert.equal(s.ends.size, 0); assert.equal(s.closes.size, 0);
});
test('completion event returns success and a terminal close returns failure', async t => {
    for (const mode of ['complete', 'end-stalled', 'close']) {
        const s = await editor(t, { mode });
        const r = await s.run();
        assert.equal(r.body.ok, mode !== 'close'); assert.equal(r.body.timedOut, false);
        assert.match(r.body.stdout, /latency_probe/); assert.equal(s.ends.size, 0);
    }
});

function daemon() {
    let now = 0;
    const s = { info: { pid: 1, port: 2, token: 'fixture' }, calls: [], behavior: 'ok' };
    const mod = load('src/core/vscodeBridge.ts', { './config': {
        OUTPUT_CHAR_CAP: 24000, readTerminalBridge: () => s.info,
    } }, { Date: { now: () => now },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 25)),
        fetch: async (url, opts) => {
            s.calls.push(url);
            if (s.behavior === 'dead' || (s.behavior === 'lost' && url.endsWith('/run'))) {
                return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
            }
            if (url.endsWith('/health')) return { ok: true, json: async () => ({ name: 'keepwork-vscode-terminal' }) };
            if (s.behavior === 'unavailable') return { ok: false, json: async () => ({ executed: false }) };
            if (s.behavior === 'bad-response') return { ok: true, json: async () => ({}) };
            return { ok: true, json: async () => ({ command: 'echo probe', stdout: 'probe', ok: s.behavior !== 'timeout',
                exitCode: s.behavior === 'timeout' ? null : 0, timedOut: s.behavior === 'timeout' }) };
        },
    });
    s.run = () => mod.tryRunInVscodeTerminal({ command: 'echo probe', cwd: '.', timeoutMs: 30000 });
    s.advance = () => { now += 60001; };
    return s;
}
test('unresponsive health probe falls back quickly and cools down; expiry and new bridge allow recovery', async () => {
    const s = daemon(); s.behavior = 'dead';
    assert.equal(await s.run(), null); assert.equal(s.calls.length, 1);
    assert.equal(await s.run(), null); assert.equal(s.calls.length, 1);
    s.advance(); s.behavior = 'ok'; assert.equal((await s.run()).ok, true);
    s.behavior = 'dead'; await s.run(); const count = s.calls.length;
    s.info = { ...s.info, token: 'new-editor' }; s.behavior = 'ok';
    assert.equal((await s.run()).ok, true); assert.equal(s.calls.length, count + 2);
});
test('lost response or malformed result never replays a dispatched command; subsequent calls bypass bridge', async () => {
    for (const behavior of ['lost', 'bad-response', 'timeout']) {
        const s = daemon(); s.behavior = behavior;
        const r = await s.run(); assert.equal(r.ok, false); assert.equal(r.via, 'vscode-terminal');
        if (behavior !== 'timeout') assert.match(r.stderr, /Not retried/);
        assert.equal(await s.run(), null); assert.equal(s.calls.length, 2);
    }
});
test('explicit pre-execution rejection permits fallback and avoids repeated editor waits', async () => {
    const s = daemon(); s.behavior = 'unavailable';
    assert.equal(await s.run(), null); assert.equal(await s.run(), null); assert.equal(s.calls.length, 2);
});

