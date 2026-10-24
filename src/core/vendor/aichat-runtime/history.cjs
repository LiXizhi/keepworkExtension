"use strict";
// ============ Model history normalization ============
Object.defineProperty(exports, "__esModule", { value: true });
exports.markPrimaryChatStarted = markPrimaryChatStarted;
exports.modelMessageText = modelMessageText;
exports.appendMergedModelMessage = appendMergedModelMessage;
/** Mark a root conversation as having received real user activity. */
function markPrimaryChatStarted(conv) {
    if (!conv || conv.parentId || conv.observerParentId || conv.isNewTask !== true)
        return false;
    conv.isNewTask = false;
    return true;
}
function relaySourceName(message, resolveConvById) {
    const source = message?.fromAgentId && typeof resolveConvById === 'function'
        ? resolveConvById(message.fromAgentId)
        : null;
    return String(source?.title || message?.fromAgentTitle || message?.fromAgentName || 'Agent').trim() || 'Agent';
}
function modelMessageText(message, resolveConvById = null) {
    const content = String(message?.content || '').trim();
    if (!message?.agentRelay)
        return content;
    return `from ${relaySourceName(message, resolveConvById)}：${content}`;
}
function mergeContent(left, right) {
    if (typeof left === 'string' && typeof right === 'string') {
        return [left, right].filter(Boolean).join('\n');
    }
    const parts = value => Array.isArray(value)
        ? value.slice()
        : (value ? [{ type: 'text', text: String(value) }] : []);
    const merged = parts(left);
    const incoming = parts(right);
    const last = merged.at(-1);
    const first = incoming[0];
    if (last?.type === 'text' && first?.type === 'text') {
        last.text = [last.text, first.text].filter(Boolean).join('\n');
        incoming.shift();
    }
    return [...merged, ...incoming];
}
function appendMergedModelMessage(messages, message) {
    const previous = messages.at(-1);
    if (message?.role === 'user' && previous?.role === 'user') {
        let previousContent = previous.content;
        let incomingContent = message.content;
        if (previous.agentRelay && !message.agentRelay && typeof incomingContent === 'string') {
            incomingContent = `user: ${incomingContent}`;
        }
        else if (!previous.agentRelay && message.agentRelay && typeof previousContent === 'string') {
            previousContent = `user: ${previousContent}`;
        }
        previous.content = mergeContent(previousContent, incomingContent);
        previous.agentRelay = previous.agentRelay || message.agentRelay;
        return previous;
    }
    const agentRelay = !!message?.agentRelay;
    delete message.agentRelay;
    Object.defineProperty(message, 'agentRelay', {
        value: agentRelay,
        writable: true,
        configurable: true,
    });
    messages.push(message);
    return message;
}
