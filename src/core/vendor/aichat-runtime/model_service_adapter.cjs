"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completeWithServices = completeWithServices;
const completion_cjs_1 = require("./completion.cjs");
// All providers use the existing completion engine and its tool-result callbacks.
async function completeWithServices(services, options) {
    const model = services.get('model');
    if (!model)
        throw Error('No model provider is configured. Open Settings → Packages & profiles.');
    const registered = new Map([...services].filter(([name]) => name.startsWith('tool:')).map(([name, tool]) => [name.slice(5), tool]));
    const tools = new Map((options.tools || []).map(tool => [tool.function.name, tool]));
    for (const [name, tool] of registered)
        tools.set(name, { type: 'function', function: { name, ...tool.schema } });
    const messages = [...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []), ...(options.messages || [])];
    const response = await (0, completion_cjs_1.runCompletion)({ ...options, messages, tools: [...tools.values()] }, {
        request: async (request) => {
            const reply = await model.complete({ messages: request.messages, tools: request.tools, signal: options.abortController?.signal,
                onChunk: text => { options.onChunk?.(text); if (typeof text === 'string')
                    options.onMessage?.(text); }, model: options.model });
            options.onMessage?.(reply.content || '', { choices: [{ message: { content: reply.content || '' } }] });
            for (const call of reply.toolCalls || [])
                options.onToolCallChunk?.(call);
            return { choices: [{ message: { content: reply.content || '', tool_calls: reply.toolCalls } }] };
        },
        execute: async (call, args) => {
            const tool = registered.get(call.function.name);
            if (tool)
                return tool.execute(args, { signal: options.abortController?.signal });
            if (options.onToolCall)
                return options.onToolCall({ ...call, function: { ...call.function, arguments: args } });
            throw Error(`Unavailable tool: ${call.function.name}`);
        },
        emit: event => options.onEvent?.(event),
    });
    return (0, completion_cjs_1.responseText)(response);
}
