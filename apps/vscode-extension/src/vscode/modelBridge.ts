import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { clearModelBridge, writeModelBridge } from '../../../../src/core/vscodeModels';

// Separate from the terminal bridge: this credential only permits model access.
const MAX_BODY = 8_000_000;
function json(res: http.ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const data of req) {
        size += data.length;
        if (size > MAX_BODY) throw new Error('Request too large');
        chunks.push(Buffer.from(data));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function models() {
    if (!vscode.lm?.selectChatModels || !vscode.LanguageModelToolCallPart) return [];
    return (await vscode.lm.selectChatModels({})).filter(m => m.vendor.toLowerCase() !== 'copilot');
}
function textParts(content: any): vscode.LanguageModelTextPart[] {
    if (content == null) return [];
    if (typeof content === 'string') return [new vscode.LanguageModelTextPart(content)];
    if (!Array.isArray(content) || content.some(p => p.type !== 'text' || typeof p.text !== 'string'))
        throw new Error('This VS Code model bridge supports text and tool calls only');
    return content.map(p => new vscode.LanguageModelTextPart(p.text));
}
export function convertMessages(messages: any[]): vscode.LanguageModelChatMessage[] {
    if (!Array.isArray(messages) || messages.length > 10000) throw new Error('Invalid messages');
    return messages.map(m => {
        if (m.role === 'tool') {
            if (typeof m.tool_call_id !== 'string') throw new Error('Missing tool call ID');
            return vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(m.tool_call_id, textParts(m.content))]);
        }
        if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant([
            ...textParts(m.content), ...(m.tool_calls || []).map((call: any) => {
                if (call.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string') throw new Error('Invalid tool call');
                return new vscode.LanguageModelToolCallPart(call.id, call.function.name, JSON.parse(call.function.arguments));
            }),
        ]);
        // The stable VS Code API has no system role. Preserve instructions explicitly
        // as a leading user message, as recommended for consumers of that API.
        if (m.role === 'system' || m.role === 'developer') return vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(`[${m.role} instructions]\n`), ...textParts(m.content),
        ]);
        if (m.role !== 'user') throw new Error('Unsupported message role');
        return vscode.LanguageModelChatMessage.User(textParts(m.content));
    });
}
export async function complete(req: http.IncomingMessage, res: http.ServerResponse, input: any) {
    const model = (await models()).find(m => m.id === input.model);
    if (!model) { json(res, 404, { error: { message: 'VS Code custom model unavailable; reopen its provider and reconnect.' } }); return; }
    const messages = convertMessages(input.messages);
    let tools = (input.tools || []).map((t: any) => {
        if (t.type !== 'function' || typeof t.function?.name !== 'string') throw new Error('Unsupported tool definition');
        return { name: t.function.name, description: t.function.description || '', inputSchema: t.function.parameters || { type: 'object', properties: {} } };
    });
    const choice = input.tool_choice;
    if (choice === 'none') tools = [];
    else if (choice?.type === 'function') tools = tools.filter((t: any) => t.name === choice.function?.name);
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    res.on('close', cancel);
    const timer = setTimeout(cancel, 10 * 60 * 1000);
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    let index = 0, text = '', outputSize = 0; const calls: any[] = [];
    const chunk = (delta: any, finish_reason: string | null = null) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    try {
        const response = await model.sendRequest(messages, {
            justification: 'Use your selected custom model for the AIChat Copilot CLI task.', tools,
            toolMode: choice === 'required' || choice?.type === 'function' ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
        }, cancellation.token);
        if (input.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); chunk({ role: 'assistant' }); }
        for await (const part of response.stream) {
            if (cancellation.token.isCancellationRequested) throw new Error('Cancelled');
            outputSize += part instanceof vscode.LanguageModelTextPart ? part.value.length : JSON.stringify(part).length;
            if (outputSize > MAX_BODY) { cancel(); throw new Error('Model output limit exceeded'); }
            if (part instanceof vscode.LanguageModelTextPart) {
                if (!input.stream) text += part.value;
                if (input.stream) chunk({ content: part.value });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const call = { id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } };
                calls.push(call);
                if (input.stream) chunk({ tool_calls: [{ index: index++, ...call }] });
            } else throw new Error('Unsupported model response part');
        }
        if (input.stream) { chunk({}, calls.length ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n'); }
        else json(res, 200, { id, object: 'chat.completion', created, model: input.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
    } finally { clearTimeout(timer); res.off('close', cancel); cancellation.dispose(); }
}
export function startModelBridge() {
    const token = randomBytes(24).toString('hex');
    let active = 0;
    const server = http.createServer(async (req, res) => {
        // No browser access, CORS or redirects. The daemon/CLI must authenticate.
        if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: { message: 'Unauthorized' } }); return; }
        try {
            if (req.url === '/models' && req.method === 'GET') {
                json(res, 200, { models: (await models()).map(m => ({ id: m.id, name: m.name, vendor: m.vendor, maxInputTokens: m.maxInputTokens })) }); return;
            }
            if (req.url === '/v1/chat/completions' && req.method === 'POST') {
                if (active >= 4) { json(res, 429, { error: { message: 'VS Code model bridge is busy' } }); return; }
                active++;
                try { await complete(req, res, await body(req)); } finally { active--; }
                return;
            }
            json(res, 404, { error: { message: 'Not found' } });
        } catch {
            // Provider errors may contain endpoints/credentials; do not reflect them.
            if (res.headersSent) res.destroy();
            else if (!res.destroyed) json(res, 503, { error: { message: 'VS Code model request failed. Check provider access/consent in VS Code; the request was not replayed.' } });
        }
    });
    server.requestTimeout = 60000;
    server.on('error', () => { clearModelBridge(token); });
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') writeModelBridge({ port: address.port, pid: process.pid, token });
    });
    return { dispose() { clearModelBridge(token); server.closeAllConnections(); server.close(); } };
}
