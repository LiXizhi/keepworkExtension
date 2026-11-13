"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completionMetadata = completionMetadata;
exports.throwIfAborted = throwIfAborted;
exports.abortable = abortable;
exports.parseArguments = parseArguments;
exports.responseText = responseText;
exports.runCompletion = runCompletion;
const text_tool_calls_cjs_1 = require("./text_tool_calls.cjs");
const unfinished = new Set(['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'error', 'cancelled', 'aborted', 'incomplete', 'failed']);
function completionMetadata(metadata) {
    const result = {};
    for (const source of [metadata, metadata?.choices?.[0], metadata?.raw, metadata?.raw?.choices?.[0]]) {
        for (const key of ['finish_reason', 'stop_reason', 'truncated', 'status', 'error']) {
            const value = source?.[key];
            if (value == null)
                continue;
            if (!(key in result) || unfinished.has(value) || (['truncated', 'error'].includes(key) && value))
                result[key] = value;
        }
    }
    return result;
}
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
function emptyNativePlaceholder(call) {
    if (!call || typeof call !== 'object' || Array.isArray(call))
        return false;
    if (Object.keys(call).some(key => !['id', 'index', 'type', 'function'].includes(key)))
        return false;
    if (call.id != null && String(call.id).trim())
        return false;
    if (call.type != null && call.type !== 'function')
        return false;
    const fn = call.function;
    if (fn == null)
        return true;
    if (typeof fn !== 'object' || Array.isArray(fn) || Object.keys(fn).some(key => !['name', 'arguments'].includes(key)))
        return false;
    return [fn.name, fn.arguments].every(value => value == null || (typeof value === 'string' && !value.trim()));
}
function finalizedNativeCalls(snapshots, iteration) {
    const calls = [], ids = new Map(), indexes = new Map(), seen = new WeakSet();
    for (const snapshot of snapshots) {
        if (snapshot && typeof snapshot === 'object') {
            if (seen.has(snapshot))
                continue;
            seen.add(snapshot);
        }
        if (emptyNativePlaceholder(snapshot))
            continue;
        const call = snapshot && typeof snapshot === 'object' ? snapshot : { function: { name: '' } };
        let position = call.id ? ids.get(call.id) : undefined;
        if (position === undefined && call.index !== undefined) {
            const candidate = indexes.get(call.index), prior = calls[candidate];
            if (prior && (!call.id || !prior.id || call.id === prior.id))
                position = candidate;
        }
        if (position === undefined) {
            position = calls.length;
            calls.push(call);
        }
        else {
            const prior = calls[position];
            // Keep identity, but do not fill missing final arguments/name from
            // an earlier snapshot and accidentally execute stale semantics.
            calls[position] = { ...call, id: call.id || prior.id };
        }
        if (calls[position].id)
            ids.set(calls[position].id, position);
        if (call.index !== undefined)
            indexes.set(call.index, position);
    }
    return calls.map((call, i) => ({ ...call, id: call.id || `call-${iteration}-${i}`, type: call.type || 'function' }));
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
                const key = call?.id || `index:${call?.index ?? announced.size}`;
                announced.set(key, call);
            } }), signal);
        throwIfAborted(signal);
        const rawCalls = [response?.choices?.[0]?.message?.tool_calls, response?.tool_calls].filter(Array.isArray).flat();
        let calls = finalizedNativeCalls([...announced.values(), ...rawCalls], iteration);
        let content = responseText(response);
        // Native calls are authoritative. Text recovery runs only after the
        // transport completes; partial/cancelled requests never reach execution.
        const reasons = [response?.choices?.[0]?.finish_reason, response?.finish_reason, response?.stop_reason];
        const incomplete = response?.truncated || response?.error
            || reasons.some(reason => ['length', 'max_tokens', 'max_output_tokens', 'content_filter', 'error', 'cancelled', 'aborted'].includes(reason))
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
