const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

async function fixture(t) {
    const state = { calls: [], cancelled: false };
    class Text { constructor(value) { this.value = value; } }
    class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
    class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
    class Cancellation {
        token = { isCancellationRequested: false };
        cancel() { this.token.isCancellationRequested = true; state.cancelled = true; state.release?.(); }
        dispose() {}
    }
    const model = { id: 'custom/model', name: 'Custom', vendor: 'my-provider', maxInputTokens: 200000,
        async sendRequest(messages, options, token) {
            state.calls.push({ messages, options, token });
            if (state.error) throw new Error('private-provider-secret');
            return { stream: (async function* () {
                if (state.wait) { await new Promise(r => { state.release = r; }); return; }
                if (messages.some(m => m.content.some(p => p instanceof Result))) yield new Text('Done 中文😀');
                else { yield new Text('Checking'); yield new Call('call-1', 'read_file', { path: 'notes.txt' }); }
            })() };
        } };
    const vscode = { lm: { selectChatModels: async () => state.offline ? [] : [model, { ...model, id: 'subscription', vendor: 'copilot' }] },
        LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
        LanguageModelChatToolMode: { Auto: 1, Required: 2 }, CancellationTokenSource: Cancellation,
        LanguageModelChatMessage: { User: content => ({ role: 'user', content }), Assistant: content => ({ role: 'assistant', content }) } };
    const source = fs.readFileSync(path.join(__dirname, '../src/vscode/modelBridge.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const exports = {}; let published;
    const ready = new Promise(r => { published = r; });
    vm.runInNewContext(code, { exports, Buffer, setTimeout, clearTimeout, process, require(name) {
        if (name === 'vscode') return vscode;
        if (name.endsWith('/vscodeModels')) return { writeModelBridge(info) { state.info = info; published(); }, clearModelBridge() {} };
        return require(name);
    } });
    const handle = exports.startModelBridge(); t.after(() => handle.dispose()); await ready;
    state.url = `http://127.0.0.1:${state.info.port}`;
    state.headers = { Authorization: `Bearer ${state.info.token}`, 'Content-Type': 'application/json' };
    state.post = (body, extra = {}) => fetch(state.url + '/v1/chat/completions', { method: 'POST', headers: state.headers, body: JSON.stringify({ model: model.id, ...body }), ...extra });
    return state;
}
test('loopback model discovery authenticates, excludes subscription duplicates and makes no model requests', async t => {
    const s = await fixture(t);
    assert.equal((await fetch(s.url + '/models')).status, 401);
    assert.equal((await fetch(s.url + '/models', { headers: { ...s.headers, Origin: 'https://keepwork.com' } })).status, 401);
    const list = await fetch(s.url + '/models', { headers: s.headers }).then(r => r.json());
    assert.deepEqual(list.models.map(m => m.id), ['custom/model']); assert.equal(s.calls.length, 0);
    assert.equal((await fetch(s.url + '/run', { method: 'POST', headers: s.headers })).status, 404);
});
test('SSE text/tool calls and subsequent tool results preserve IDs, schemas, Unicode and instructions', async t => {
    const s = await fixture(t);
    const messages = [{ role: 'system', content: 'Use the project instructions' }, { role: 'user', content: 'Read notes' }];
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read notes', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const res = await s.post({ messages, tools, stream: true });
    assert.match(res.headers.get('content-type'), /event-stream/);
    const chunks = (await res.text()).trim().split('\n\n').map(s => s.slice(6));
    assert.equal(chunks.pop(), '[DONE]');
    const deltas = chunks.map(s => JSON.parse(s).choices[0]);
    assert.equal(deltas[1].delta.content, 'Checking');
    const tool = deltas[2].delta.tool_calls[0];
    assert.equal(tool.id, 'call-1'); assert.equal(JSON.parse(tool.function.arguments).path, 'notes.txt');
    assert.equal(deltas.at(-1).finish_reason, 'tool_calls');
    assert.equal(s.calls[0].messages[0].content[1].value, 'Use the project instructions');
    assert.equal(s.calls[0].options.tools[0].inputSchema.properties.path.type, 'string');
    messages.push({ role: 'assistant', content: 'Checking', tool_calls: [tool] }, { role: 'tool', tool_call_id: 'call-1', content: 'notes contents' });
    const done = await s.post({ messages, tools }).then(r => r.json());
    assert.equal(done.choices[0].message.content, 'Done 中文😀');
    const result = s.calls[1].messages.at(-1).content[0];
    assert.equal(result.callId, 'call-1'); assert.equal(result.content[0].value, 'notes contents');
});
test('missing models, unsupported content and provider errors never fall back or expose provider secrets', async t => {
    const s = await fixture(t);
    assert.equal((await s.post({ model: 'missing', messages: [] })).status, 404);
    assert.equal((await s.post({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private/image' } }] }] })).status, 503);
    assert.equal(s.calls.length, 0);
    s.error = true;
    const res = await s.post({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 503); assert.ok(!(await res.text()).includes('private-provider-secret')); assert.equal(s.calls.length, 1);
});
test('disconnect cancels the editor request', async t => {
    const s = await fixture(t); s.wait = true;
    const ctrl = new AbortController();
    const request = s.post({ messages: [{ role: 'user', content: 'wait' }], stream: true }, { signal: ctrl.signal }).catch(() => {});
    const deadline = Date.now() + 2000;
    while (!s.release && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(s.release); ctrl.abort(); await request;
    while (!s.cancelled && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(s.cancelled, true);
});
