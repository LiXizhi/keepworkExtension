"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completeWithSdk = completeWithSdk;
const completion_cjs_1 = require("./completion.cjs");
/** Preserve SDK streaming/providers; bypass only its recursive tool dispatcher. */
function completeWithSdk(client, options) {
    return (0, completion_cjs_1.runCompletion)(options, {
        request: request => client.aiChat._chatRequest(request),
        execute: call => client.aiChat.executeTool(call, options),
    });
}
