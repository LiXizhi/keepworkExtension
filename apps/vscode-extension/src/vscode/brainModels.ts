import * as vscode from 'vscode';
import { convertMessages } from './modelBridge';

/** Per-webview Copilot requests; never publishes an HTTP endpoint or credentials. */
export function createBrainModels() {
    const pending = new Map<string, vscode.CancellationTokenSource>();
    let epoch = 0;
    const reset = () => { epoch++; for (const token of pending.values()) { token.cancel(); token.dispose(); } pending.clear(); };
    return {
        reset,
        cancel(id: string) { pending.get(id)?.cancel(); },
        async request(id: string, method: string, args: any, emit: (part: any) => void) {
            if (pending.has(id) || pending.size >= 4) throw new Error('VS Code Copilot is busy.');
            if (!['models', 'chat'].includes(method)) throw new Error('Unsupported model operation.');
            if (JSON.stringify(args || {}).length > 8_000_000) throw new Error('Model request is too large.');
            if (!vscode.lm?.selectChatModels) throw new Error('This editor does not support the VS Code Language Model API.');
            const token = new vscode.CancellationTokenSource(), ticket = epoch;
            pending.set(id, token);
            const check = () => { if (ticket !== epoch || token.token.isCancellationRequested) throw new Error('Copilot request cancelled.'); };
            const timeout = setTimeout(() => token.cancel(), 10 * 60 * 1000);
            try {
                // Called only by the user's model-picker or chat action, allowing
                // VS Code to obtain Copilot consent through its native UI.
                const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                check();
                if (method === 'models') return models.map(model => ({ id: model.id, name: model.name, maxInputTokens: model.maxInputTokens }));
                const model = args?.model ? models.find(model => model.id === args.model) : models[0];
                if (!model) throw new Error('Copilot model unavailable. Sign in to GitHub Copilot in VS Code and choose an available model.');
                let messages;
                try { messages = convertMessages(args.messages); }
                catch { throw new Error('Unsupported model input. VS Code Copilot currently supports text and tool calls in AIChat; remove image/audio attachments.'); }
                if (!Array.isArray(args.tools || []) || (args.tools || []).length > 256) throw new Error('Invalid tools.');
                const tools = (args.tools || []).map((tool: any) => {
                    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') throw new Error('Invalid tool.');
                    return { name: tool.function.name, description: tool.function.description || '', inputSchema: tool.function.parameters || { type: 'object', properties: {} } };
                });
                const response = await model.sendRequest(messages, {
                    justification: 'Use GitHub Copilot for your AIChat conversation in VS Code.',
                    ...(tools.length ? { tools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {}),
                }, token.token);
                check();
                let size = 0;
                for await (const part of response.stream) {
                    check();
                    const value = part instanceof vscode.LanguageModelTextPart ? { text: part.value }
                        : part instanceof vscode.LanguageModelToolCallPart ? { toolCall: { id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } } }
                        : null;
                    // VS Code deliberately allows unknown stream parts (for example
                    // supplemental provider data). Forward supported text/tool calls;
                    // ignore other parts, while iterator errors still reach the catch.
                    if (!value) continue;
                    size += JSON.stringify(value).length;
                    if (size > 8_000_000) throw new Error('Copilot response exceeded the size limit.');
                    emit(value);
                }
                check();
                return { model: model.id };
            } catch (error) {
                if (token.token.isCancellationRequested || ticket !== epoch) throw new Error('Copilot request cancelled.');
                // Provider error bodies may contain secrets. Return actionable status only.
                if (error instanceof vscode.LanguageModelError) throw new Error(`Copilot access failed (${error.code}). Check GitHub sign-in, model access, consent and quota in VS Code.`);
                if (error instanceof Error && /^(Copilot model unavailable|Invalid |Unsupported |This editor|Model request|Copilot response)/.test(error.message)) throw error;
                throw new Error('VS Code Copilot request failed. Check Copilot sign-in and access, then retry.');
            } finally {
                clearTimeout(timeout);
                if (pending.get(id) === token) pending.delete(id);
                token.dispose();
            }
        },
    };
}
