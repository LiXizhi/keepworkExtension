"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completeWithSdk = completeWithSdk;
const completion_cjs_1 = require("./completion.cjs");
/** Preserve SDK streaming/providers; bypass only its recursive tool dispatcher. */
async function completeWithSdk(client, options) {
    let originalResponse, wrappedResponse;
    const response = await (0, completion_cjs_1.runCompletion)(options, {
        request: async (request) => {
            let completed;
            originalResponse = await client.aiChat._chatRequest({ ...request, onComplete: (text, metadata) => {
                    // Only the final completion callback of this request is used.
                    // A successful stream continuation supersedes an interim stop.
                    completed = metadata;
                    request.onComplete?.(text, metadata);
                } });
            const metadata = (0, completion_cjs_1.completionMetadata)(completed);
            const calls = completed?.tool_calls;
            if (!Object.keys(metadata).length && !Array.isArray(calls)) {
                wrappedResponse = undefined;
                return originalResponse;
            }
            wrappedResponse = { ...(originalResponse && typeof originalResponse === 'object' ? originalResponse : {}),
                ...metadata, result: (0, completion_cjs_1.responseText)(originalResponse), ...(Array.isArray(calls)
                    ? { tool_calls: [...(Array.isArray(originalResponse?.tool_calls) ? originalResponse.tool_calls : []), ...calls] } : {}) };
            return wrappedResponse;
        },
        execute: call => client.aiChat.executeTool(call, options),
    });
    // Keep the SDK's historical string/response shape at the public boundary.
    return wrappedResponse && response === wrappedResponse ? originalResponse : response;
}
