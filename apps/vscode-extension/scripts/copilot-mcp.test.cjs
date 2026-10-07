const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function fixture({ api = true } = {}) {
    const state = { enableHttp: true, connectCopilot: true, port: 8089, health: { ok: true }, starts: 0, reads: 0, fires: 0 };
    class EventEmitter {
        event = () => {};
        fire() { state.fires++; }
        dispose() {}
    }
    const vscode = {
        EventEmitter,
        Uri: { parse: value => value },
        McpHttpServerDefinition: class {
            constructor(label, uri, headers, version) { Object.assign(this, { label, uri, headers, version }); }
        },
        lm: api ? { registerMcpServerDefinitionProvider(id, provider) {
            state.id = id; state.provider = provider;
            return { dispose() {} };
        } } : undefined,
        workspace: {
            getConfiguration: () => ({ get: (key, fallback) => state[key] ?? fallback }),
            onDidChangeConfiguration: listener => { state.change = listener; return { dispose() {} }; },
        },
    };
    const source = fs.readFileSync(path.join(root, 'src/vscode/copilotMcp.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require(name) {
        if (name === 'vscode') return vscode;
        if (name.endsWith('/config')) return { readToken: () => { state.reads++; return state.token; } };
        if (name === './daemon') return {
            mcpEnabled: () => state.enableHttp,
            mcpBaseUrl: () => `http://127.0.0.1:${state.port}`,
            ensureDaemon: async () => { state.starts++; return state.health; },
        };
        throw new Error(`Unexpected dependency: ${name}`);
    } });
    state.context = { subscriptions: [], extension: { packageJSON: { version: 'test-version' } } };
    exports.registerCopilotMcp(state.context);
    return state;
}
const cancellation = { isCancellationRequested: false };

test('default discovery advertises the singleton HTTP endpoint without starting or exposing credentials', async () => {
    const state = fixture();
    state.token = 'test-secret';
    const [server] = state.provider.provideMcpServerDefinitions(cancellation);
    assert.equal(state.id, 'keepwork.mcp');
    assert.equal(server.uri, 'http://127.0.0.1:8089/mcp');
    assert.equal(server.version, 'test-version');
    assert.equal(JSON.stringify(server.headers), '{}');
    assert.equal(state.starts, 0);
    assert.equal(state.reads, 0);
    assert.equal(await state.provider.resolveMcpServerDefinition(server, cancellation), server);
    assert.equal(state.starts, 1);
    assert.equal(state.reads, 0);
});

test('connection uses actual daemon authentication and a fresh token, then clears stale headers', async () => {
    const state = fixture();
    const [server] = state.provider.provideMcpServerDefinitions(cancellation);
    state.health = { ok: true, requireAuth: true };
    state.token = 'fresh-test-token';
    await state.provider.resolveMcpServerDefinition(server, cancellation);
    assert.equal(server.headers.Authorization, 'Bearer fresh-test-token');
    state.health = { ok: true, requireAuth: false };
    await state.provider.resolveMcpServerDefinition(server, cancellation);
    assert.equal(JSON.stringify(server.headers), '{}');
});

test('settings update discovery and opt-out suppresses discovery and connection', async () => {
    const state = fixture();
    state.port = 8090;
    state.change({ affectsConfiguration: key => key === 'keepwork.mcp.port' });
    assert.equal(state.fires, 1);
    const [server] = state.provider.provideMcpServerDefinitions(cancellation);
    assert.equal(server.uri, 'http://127.0.0.1:8090/mcp');
    for (const setting of ['connectCopilot', 'enableHttp']) {
        state[setting] = false;
        assert.equal(state.provider.provideMcpServerDefinitions(cancellation).length, 0);
        assert.equal(await state.provider.resolveMcpServerDefinition(server, cancellation), undefined);
        state[setting] = true;
    }
    assert.equal(state.starts, 0);
});

test('unrelated MCP preferences preserve editor discovery; connection settings invalidate it', () => {
    const state = fixture();
    for (const setting of ['terminalTimeoutMs', 'maxOutputChars']) {
        state.change({ affectsConfiguration: key => key === `keepwork.mcp.${setting}` || key === 'keepwork.mcp' });
    }
    assert.equal(state.fires, 0);
    for (const setting of ['enableHttp', 'connectCopilot', 'port', 'workspaceRoot', 'requireAuth']) {
        state.change({ affectsConfiguration: key => key === `keepwork.mcp.${setting}` || key === 'keepwork.mcp' });
    }
    assert.equal(state.fires, 5);
    assert.equal(state.starts, 0);
});

test('cancellation, unhealthy daemon and missing credentials do not produce a connection', async () => {
    const state = fixture();
    const [server] = state.provider.provideMcpServerDefinitions(cancellation);
    assert.equal(await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: true }), undefined);
    assert.equal(state.starts, 0);
    state.health = { ok: false, error: 'port occupied' };
    await assert.rejects(state.provider.resolveMcpServerDefinition(server, cancellation), /port occupied/);
    state.health = { ok: true, requireAuth: true };
    await assert.rejects(state.provider.resolveMcpServerDefinition(server, cancellation), /token is missing/);
});

test('older editors without the MCP API still activate', () => {
    const state = fixture({ api: false });
    assert.equal(state.provider, undefined);
    assert.equal(state.context.subscriptions.length, 0);
});

test('manifest publishes the provider and the complete packaged Paracraft skill', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(manifest.contributes.mcpServerDefinitionProviders.some(entry => entry.id === 'keepwork.mcp'));
    assert.equal(manifest.contributes.configuration.properties['keepwork.mcp.connectCopilot'].default, true);
    const skill = manifest.contributes.chatSkills.find(entry => entry.path.includes('paracraft-create'));
    assert.ok(skill);
    const skillFile = path.join(root, skill.path);
    const content = fs.readFileSync(skillFile, 'utf8');
    assert.match(content, /name: paracraft-create/);
    assert.ok(fs.existsSync(path.join(path.dirname(skillFile), 'references/connection.md')));
    assert.equal(content, fs.readFileSync(path.resolve(root, '../../skills/paracraft-create/SKILL.md'), 'utf8'));
});
