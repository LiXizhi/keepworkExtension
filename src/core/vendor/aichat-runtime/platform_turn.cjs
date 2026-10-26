"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPlatformTurn = runPlatformTurn;
const completion_cjs_1 = require("./completion.cjs");
// Compatibility entry for CLI/contract clients; uses the same engine as the workbench.
async function runPlatformTurn({ model, services, messages, signal, maxSteps = 20, onMessage = () => { } }) {
    const tools = new Map([...services].filter(([name]) => name.startsWith('tool:')).map(([name, value]) => [name.slice(5), value]));
    const result = await (0, completion_cjs_1.runCompletion)({ messages: structuredClone(messages), abortController: { signal }, maxIterations: maxSteps,
        tools: [...tools].map(([name, tool]) => ({ type: 'function', function: { ...tool.schema, name } })) }, {
        request: async (options) => { const reply = await model.complete({ messages: options.messages, signal, tools: options.tools }); return { choices: [{ message: { content: reply.content || '', tool_calls: reply.toolCalls } }] }; },
        execute: (call, args) => { const tool = tools.get(call.function.name); if (!tool)
            throw Error('Tool is not enabled in this profile'); return tool.execute(args, { signal }); },
        emit: event => event.message ? onMessage(event.message) : undefined,
    });
    return { role: 'assistant', content: (0, completion_cjs_1.responseText)(result) };
}
