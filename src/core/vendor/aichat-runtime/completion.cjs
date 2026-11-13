"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.throwIfAborted = throwIfAborted;
exports.abortable = abortable;
exports.parseArguments = parseArguments;
exports.responseText = responseText;
exports.runCompletion = runCompletion;
const text_tool_calls_cjs_1 = require("./text_tool_calls.cjs");
/** One model/tool loop. Transports perform exactly one inference request. */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = Error('AI_GENERATION_ABORTED');
        error.name = 'AbortError';
        throw error;
    }
}
function abortable(value, signal) {
    throwIfAborted(signal);
    if (!signal)
        return Promise.resolve(value);
    return new Promise((resolve, reject) => {
        const abort = () => { try {
            throwIfAborted(signal);
        }
        catch (e) {
            reject(e);
        } };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
function parseArguments(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
        return raw;
    if (!String(raw || '').trim())
        return {};
    // Match AIChat's tolerant first-object parser, including braces in quoted strings.
    const text = String(raw).trim();
    let depth = 0, quoted = false, escaped = false;
    if (text[0] !== '{')
        throw Error('Tool arguments must be a JSON object');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (c === '\\')
                escaped = true;
            else if (c === '"')
                quoted = false;
        }
        else if (c === '"')
            quoted = true;
        else if (c === '{')
            depth++;
        else if (c === '}' && --depth === 0)
            return JSON.parse(text.slice(0, i + 1));
    }
    throw Error('Incomplete tool arguments; execution skipped');
}
function responseText(response) {
    return typeof response === 'string' ? response : response?.choices?.[0]?.message?.content ?? response?.result ?? response?.content ?? '';
}
async function runCompletion(options, { request, execute, emit = () => { } }) {
    const messages = options.messages || [], signal = options.abortController?.signal;
    const receipts = new Map();
    const limit = Math.max(1, Math.min(128, options.maxIterations || 10));
    for (let iteration = 0; iteration < limit; iteration++) {
        throwIfAborted(signal);
        const announced = new Map();
        const finalSummary = options.reserveFinalResponse && iteration === limit - 1;
        const response = await abortable(request({ ...options, ...(finalSummary ? { tools: [] } : {}), messages, onToolCall: call => {
                // Keep the mutable SDK snapshot until the response has completed.
                const key = call.id || `index:${call.index ?? announced.size}`;
                announced.set(key, call);
            } }), signal);
        throwIfAborted(signal);
        const rawCalls = response?.choices?.[0]?.message?.tool_calls || response?.tool_calls;
        for (const call of rawCalls || [])
            announced.set(call.id || `index:${call.index ?? announced.size}`, call);
        let calls = [...announced.values()].map((call, i) => ({ ...call, id: call.id || `call-${iteration}-${i}`, type: call.type || 'function' }));
        let content = responseText(response);
        // Native calls are authoritative. Text recovery runs only after the
        // transport completes; partial/cancelled requests never reach execution.
        const reason = response?.choices?.[0]?.finish_reason ?? response?.finish_reason ?? response?.stop_reason;
        const incomplete = response?.truncated || response?.error
            || ['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'error', 'cancelled', 'aborted'].includes(reason)
            || ['incomplete', 'failed', 'cancelled'].includes(response?.status);
        const recovered = !calls.length && !incomplete
            ? (0, text_tool_calls_cjs_1.recoverTextToolCalls)(content, finalSummary ? [] : options.tools, iteration) : null;
        if (recovered) {
            calls = recovered.calls;
            content = recovered.content;
            options.onMessage?.(content, { result: content, tool_calls: calls, replaceContent: true });
            for (const call of calls)
                options.onToolCallChunk?.(call);
        }
        await emit({ type: 'message', content, iteration, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } });
        if (!calls.length)
            return response;
        if (finalSummary)
            throw Error('Observer final response requested an unavailable tool');
        messages.push({ role: 'assistant', content, tool_calls: calls });
        // Complete the entire section before appending tool results (browser steering boundary).
        const results = [];
        for (const call of calls) {
            throwIfAborted(signal);
            const name = call.function?.name || '';
            let result;
            try {
                if (!(options.tools || []).some(t => t.function?.name === name))
                    throw Error(`Unavailable tool: ${name}`);
                if (recovered?.errors.has(call.id))
                    throw Error(recovered.errors.get(call.id));
                const args = parseArguments(call.function?.arguments);
                const signature = JSON.stringify([name, args]);
                const prior = receipts.get(call.id);
                if (prior && prior.signature !== signature)
                    throw Error('Tool call ID reused with different arguments');
                if (prior)
                    result = await prior.result;
                else {
                    emit({ type: 'tool', status: 'running', id: call.id, name });
                    const pending = Promise.resolve().then(() => execute(call, args, options));
                    receipts.set(call.id, { signature, result: pending });
                    result = await abortable(pending, signal);
                }
            }
            catch (error) {
                throwIfAborted(signal);
                if (error?.isRestartAgentSignal)
                    throw error;
                result = { error: error.message || 'Tool execution failed' };
            }
            throwIfAborted(signal);
            options.onToolResult?.({ name, toolCallId: call.id, result });
            emit({ type: 'tool', status: 'done', id: call.id, name });
            results.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result ?? null) });
        }
        for (const result of results) {
            messages.push(result);
            await emit({ type: 'tool-result', message: result, iteration });
        }
        if (options._session?._restartSignal)
            return content;
    }
    throw Error('Maximum model/tool iterations reached');
}
