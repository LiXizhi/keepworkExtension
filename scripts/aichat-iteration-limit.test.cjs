const test = require('node:test');
const assert = require('node:assert/strict');
const { runCompletion, responseText } = require('../src/core/vendor/aichat-runtime/completion.cjs');

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const toolCall = (id, name = 't') => ({ id, type: 'function', function: { name, arguments: '{}' } });

// A transport that always requests a tool (so the loop can never finish by itself).
const alwaysToolRound = (counter, text = '') => async () => {
    counter.calls++;
    return { choices: [{ message: { content: text, tool_calls: [toolCall(`c${counter.calls}`)] } }] };
};

test('iteration limit is recoverable and the final round summarizes without tools', async () => {
    const seen = [];
    const counter = { calls: 0 };
    const result = await runCompletion(
        { messages: [{ role: 'user', content: 'go' }], maxIterations: 3, tools: [tool('t')] },
        {
            request: async options => {
                seen.push(options.tools.length);
                return alwaysToolRound(counter, `round ${counter.calls + 1}`)(options);
            },
            execute: async () => 'ok',
            emit: () => {},
        },
    );
    // The last (summarizing) round runs with no tools, so no dead-end error escapes.
    assert.equal(counter.calls, 3);
    assert.deepEqual(seen, [1, 1, 0]);
    assert.equal(responseText(result), 'round 3');
});

test('a silent final round that still asks for a tool surfaces a recoverable limit error', async () => {
    const counter = { calls: 0 };
    await assert.rejects(
        () => runCompletion(
            { messages: [{ role: 'user', content: 'go' }], maxIterations: 2, tools: [tool('t')] },
            { request: alwaysToolRound(counter), execute: async () => 'ok', emit: () => {} },
        ),
        error => {
            assert.equal(error.code, 'E_TOOL_ITERATION_LIMIT');
            assert.equal(error.recoverable, true);
            assert.equal(error.iterations, 2);
            return true;
        },
    );
});

test('reserveFinalResponse:false keeps the hard stop but still carries the marker', async () => {
    const counter = { calls: 0 };
    await assert.rejects(
        () => runCompletion(
            { messages: [{ role: 'user', content: 'go' }], maxIterations: 2, tools: [tool('t')], reserveFinalResponse: false },
            { request: alwaysToolRound(counter), execute: async () => 'ok', emit: () => {} },
        ),
        error => error.code === 'E_TOOL_ITERATION_LIMIT' && error.recoverable === true,
    );
});

test('a normal answer is untouched and never enters the summarizing round', async () => {
    const result = await runCompletion(
        { messages: [{ role: 'user', content: 'hi' }], maxIterations: 5, tools: [tool('t')] },
        { request: async () => ({ choices: [{ message: { content: 'hello' } }] }), execute: async () => 'ok', emit: () => {} },
    );
    assert.equal(responseText(result), 'hello');
});
