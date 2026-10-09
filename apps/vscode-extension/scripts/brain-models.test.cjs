const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function fixture() {
    const state = { calls: [], discovery: [] };
    class Text { constructor(value) { this.value = value; } }
    class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
    class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
    class Cancellation {
        token = { isCancellationRequested: false };
        cancel() { this.token.isCancellationRequested = true; state.release?.(); }
        dispose() {}
    }
    class LMError extends Error { code = 'NoPermissions'; }
    const vscode = { LanguageModelError: LMError, CancellationTokenSource: Cancellation, LanguageModelTextPart: Text,
        LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result, LanguageModelChatToolMode: { Auto: 1 },
        LanguageModelChatMessage: { User: content => ({ role: 'user', content }), Assistant: content => ({ role: 'assistant', content }) },
        lm: { async selectChatModels(selector) {
            state.discovery.push(selector);
            if (state.denied) throw new LMError('private-secret');
            if (state.empty) return [];
            return ['first', 'second'].map(id => ({ id, name: id, maxInputTokens: 32000, async sendRequest(messages, options, token) {
                state.calls.push({ id, messages, options, token });
                return { stream: (async function* () {
                    if (state.wait) await new Promise(resolve => { state.release = resolve; });
                    if (state.fail) throw new Error('private-provider-secret');
                    if (state.extraParts) yield { value: ['internal reasoning'], metadata: { private: true } };
                    yield new Text('Hello 中文');
                    if (state.extraParts) yield { mimeType: 'application/json', data: new Uint8Array([123, 125]) };
                    yield new Call('tool-1', 'read_file', { path: 'a.txt' });
                    if (state.extraParts) yield { futurePart: true };
                    if (state.failAfterText) throw new Error('private-provider-secret');
                })() };
            } }));
        } },
    };
    function load(name) {
        const api = {};
        const source = fs.readFileSync(path.resolve(__dirname, '../src/vscode', name + '.ts'), 'utf8');
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
            { exports: api, setTimeout, clearTimeout, require: name => name === 'vscode' ? vscode : name === './modelBridge' ? load('modelBridge') : name.endsWith('/vscodeModels') ? {} : require(name) });
        return api;
    }
    return { state, models: load('brainModels').createBrainModels() };
}
test('Copilot discovery and selected-model streaming preserve text, tools and result IDs without CLI', async () => {
    const { state, models } = fixture();
    assert.equal(state.discovery.length, 0);
    assert.equal((await models.request('list', 'models', {}, () => {})).length, 2);
    assert.equal(state.discovery[0].vendor, 'copilot'); assert.equal(state.calls.length, 0);
    const parts = [];
    const result = await models.request('chat', 'chat', { model: 'second', messages: [
        { role: 'system', content: 'Instructions' },
        { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'a', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a', content: 'file contents' },
    ], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] }, part => parts.push(part));
    assert.equal(result.model, 'second'); assert.equal(parts[0].text, 'Hello 中文'); assert.equal(parts[1].toolCall.id, 'tool-1');
    assert.equal(state.calls[0].messages[2].content[0].callId, 'a'); assert.equal(state.calls[0].options.tools[0].name, 'read_file');
    await assert.rejects(models.request('bad', 'chat', { model: 'missing', messages: [] }, () => {}), /unavailable/);
    state.denied = true; await assert.rejects(models.request('denied', 'models', {}, () => {}), error => /NoPermissions/.test(error.message) && !/secret/.test(error.message));
});
test('cancel and session reset stop streams, reject duplicates, and redact provider errors', async () => {
    const { state, models } = fixture(); state.wait = true;
    const parts = [], chat = models.request('chat', 'chat', { messages: [] }, part => parts.push(part));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(models.request('chat', 'models', {}, () => {}), /busy/);
    models.cancel('chat'); await assert.rejects(chat, /cancelled/); assert.equal(parts.length, 0);
    const reset = models.request('reset', 'chat', { messages: [] }, part => parts.push(part));
    await new Promise(resolve => setImmediate(resolve)); models.reset(); await assert.rejects(reset, /cancelled/);
    state.wait = false; state.fail = true;
    await assert.rejects(models.request('fail', 'chat', { messages: [] }, () => {}), error => /request failed/.test(error.message) && !/secret/.test(error.message));
});

test('supplemental Copilot stream parts do not turn successful text and tool calls into errors', async () => {
    const { state, models } = fixture(); state.extraParts = true;
    const parts = [];
    const result = await models.request('extra', 'chat', { messages: [] }, part => parts.push(part));
    assert.equal(result.model, 'first');
    assert.deepEqual(JSON.parse(JSON.stringify(parts)), [
        { text: 'Hello 中文' },
        { toolCall: { id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } } },
    ]);
    state.failAfterText = true;
    await assert.rejects(models.request('actual-error', 'chat', { messages: [] }, () => {}),
        error => /request failed/.test(error.message) && !/secret/.test(error.message));
});
