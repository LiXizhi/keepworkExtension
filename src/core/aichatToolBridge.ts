import * as http from 'node:http';
import { AICHAT_TOOL_PROXY_SOURCE } from './aichatToolProxy';
import { randomUUID } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { AichatNativeTools } from './aichatNativeTools';

export type WebTool = { name: string; description: string; inputSchema: any; execution?: string };
type Pending = { resolve: (value: any) => void; timer: NodeJS.Timeout; pageId: string; generation: string };
type Binding = { owner: string; conversationId: string; pageId: string; generation: string; instructions: string; revision: string; tools: WebTool[]; stream?: http.ServerResponse; pending: Map<string, Pending>; capability: string; backend?: (name: string, args: any) => Promise<any>; backendTools?: WebTool[] };
const errorResult = (error: string) => ({ isError: true, content: [{ type: 'text', text: error }] });
const schemas = new AjvJsonSchemaValidator();
export function validateToolArguments(schema: any, value: any): void {
    const result = schemas.getValidator(schema)(value);
    if (!result.valid) throw new Error(`Invalid tool arguments: ${result.errorMessage}`);
}
function validateResult(value: any) {
    if (!value || !Array.isArray(value.content) || value.content.length > 64) throw new Error('Invalid MCP result');
    for (const part of value.content) {
        if (part.type === 'text' && typeof part.text === 'string') continue;
        if (part.type === 'image' && /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType) && typeof part.data === 'string' && part.data.length <= 8_000_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) continue;
        throw new Error('Unsupported or oversized MCP content');
    }
    if (JSON.stringify(value).length > 12_000_000) throw new Error('Tool result too large');
}

/** Routes only to an explicitly bound page. Never uses latestAichatClient. */
export class AichatToolBridge {
    private policy = (_owner: string, _id: string, _name: string, _execution: string, _args?: any) => true;
    setPolicy(policy: typeof this.policy) { this.policy = policy; }
    private nativeConnection?: () => { url: string; token: string };
    private native = new Map<string, AichatNativeTools>();
    configureNative(connection: () => { url: string; token: string }) { this.nativeConnection = connection; }
    private nativeFor(owner: string, id: string) {
        if (!this.nativeConnection) return null;
        const key = this.key(owner, id); let tools = this.native.get(key);
        if (!tools) { tools = new AichatNativeTools(this.nativeConnection); this.native.set(key, tools); }
        return tools;
    }
    private bindings = new Map<string, Binding>();
    private server?: http.Server;
    private starting?: Promise<string>;
    constructor(private timeoutMs = 120000) {}
    private key(owner: string, id: string) { return `${owner}:${id}`; }
    register(owner: string, conversationId: string, input: any) {
        if (!/^[\w-]{1,160}$/.test(conversationId) || !/^[\w-]{1,160}$/.test(input.pageId || '') || !/^[\w-]{1,160}$/.test(input.generation || '')) throw new Error('Invalid page binding');
        if (typeof input.instructions !== 'string' || input.instructions.length > 180000 || typeof input.revision !== 'string') throw new Error('Invalid context');
        if (!Array.isArray(input.tools) || input.tools.length > 200) throw new Error('Invalid tools');
        const tools: WebTool[] = input.tools.map((t: any) => {
            if (!/^[\w.:-]{1,160}$/.test(t.name) || typeof t.description !== 'string' || t.description.length > 16000 || !t.inputSchema || typeof t.inputSchema !== 'object') throw new Error('Invalid tool definition');
            schemas.getValidator(t.inputSchema);
            return { name: t.name, description: t.description, inputSchema: t.inputSchema, execution: 'web' };
        });
        if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('Duplicate tool name');
        const key = this.key(owner, conversationId), old = this.bindings.get(key);
        if (old?.stream && !old.stream.destroyed && (old.pageId !== input.pageId || old.generation !== input.generation)) throw new Error('Conversation tools are owned by another live page; close that page first');
        const binding: Binding = old || { owner, conversationId, pending: new Map(), capability: randomUUID(), ...input, tools };
        if (old && (old.pageId !== input.pageId || old.generation !== input.generation)) this.disconnect(old);
        Object.assign(binding, { pageId: input.pageId, generation: input.generation, instructions: input.instructions, revision: input.revision, tools });
        this.bindings.set(key, binding);
        return { version: 1, revision: binding.revision };
    }
    snapshot(owner: string, id: string) {
        const binding = this.bindings.get(this.key(owner, id));
        return binding ? { version: 1, revision: binding.revision, pageId: binding.pageId, generation: binding.generation, online: !!binding.stream && !binding.stream.destroyed, capabilities: this.list(owner, id).map(({ name, execution, online }) => ({ name, execution, online })) } : { version: 1, online: false, reconnectRequired: true };
    }
    has(owner: string, id: string) { return this.bindings.has(this.key(owner, id)); }
    context(owner: string, id: string) { const b = this.get(owner, id); return { instructions: b.instructions, revision: b.revision }; }
    setBackend(owner: string, id: string, tools: WebTool[], execute: Binding['backend']) { const b = this.get(owner, id); b.backendTools = tools; b.backend = execute; }
    private get(owner: string, id: string) { const b = this.bindings.get(this.key(owner, id)); if (!b) throw new Error('Reconnect AIChat to restore tool context'); return b; }
    attach(owner: string, id: string, pageId: string, generation: string, res: http.ServerResponse) {
        const b = this.get(owner, id);
        if (b.pageId !== pageId || b.generation !== generation) throw new Error('Stale page binding');
        if (b.stream && b.stream !== res) throw new Error('Tool stream already connected');
        b.stream = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.write('event: ready\ndata: {}\n\n');
        const timer = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 20000); timer.unref();
        res.on('close', () => { clearInterval(timer); if (b.stream === res) this.disconnect(b); });
    }
    private disconnect(b: Binding) {
        const stream = b.stream; b.stream = undefined; stream?.end();
        for (const p of b.pending.values()) { clearTimeout(p.timer); p.resolve(errorResult('web_result_unknown: page disconnected after dispatch; do not repeat a mutation without checking its result')); }
        b.pending.clear();
    }
    result(owner: string, id: string, input: any) {
        const b = this.get(owner, id), p = b.pending.get(input.callId);
        if (!p || p.pageId !== input.pageId || p.generation !== input.generation) throw new Error('Expired tool call');
        validateResult(input.result);
        b.pending.delete(input.callId); clearTimeout(p.timer); p.resolve(input.result);
        return { ok: true };
    }
    async invoke(owner: string, id: string, name: string, args: any, signal?: AbortSignal) {
        const b = this.get(owner, id);
        const backend = b.backendTools?.find(t => t.name === name);
        const definition = backend || b.tools.find(t => t.name === name);
        if (!this.policy(owner, id, name, backend ? 'backend' : definition ? 'web' : 'native', args)) return errorResult('Tool is unavailable in the current agent mode');
        if (!definition) {
            const native = this.nativeFor(owner, id);
            try { const tools = await native?.list(); if (tools?.some(t => t.name === name)) return await native!.call(name, args); } catch { return errorResult('Keepwork native MCP tool unavailable'); }
            return errorResult('Tool not registered for this conversation');
        }
        try { validateToolArguments(definition.inputSchema, args); } catch (e) { return errorResult((e as Error).message); }
        if (backend) { try { return await b.backend!(name, args); } catch (e) { return errorResult((e as Error).message); } }
        if (!b.stream || b.stream.destroyed) return errorResult('web_offline: reopen the original AIChat conversation and tool');
        if (b.pending.size >= 16) return errorResult('Too many pending webpage tool calls');
        const callId = randomUUID();
        return new Promise(resolve => {
            const timer = setTimeout(() => { const pending = b.pending.get(callId); b.pending.delete(callId); pending?.resolve(errorResult('web_result_unknown: tool timed out after dispatch; do not automatically retry')); }, this.timeoutMs);
            const onAbort = () => {
                if (!b.pending.delete(callId)) return;
                clearTimeout(timer);
                b.stream?.write(`event: cancel\ndata: ${JSON.stringify({ callId, pageId: b.pageId, generation: b.generation })}\n\n`);
                resolve(errorResult('web_result_unknown: caller disconnected after dispatch; verify any mutation before retrying'));
            };
            if (signal?.aborted) { clearTimeout(timer); resolve(errorResult('Tool call cancelled before dispatch')); return; }
            signal?.addEventListener('abort', onAbort, { once: true });
            b.pending.set(callId, { resolve: value => { signal?.removeEventListener('abort', onAbort); resolve(value); }, timer, pageId: b.pageId, generation: b.generation });
            if (!b.stream!.write(`event: tool\ndata: ${JSON.stringify({ callId, pageId: b.pageId, generation: b.generation, conversationId: id, name, arguments: args })}\n\n`)) this.disconnect(b);
        });
    }
    list(owner: string, id: string) { const b = this.get(owner, id); return [...(b.backendTools || []).filter(t => this.policy(owner, id, t.name, 'backend')).map(t => ({ ...t, online: true })), ...b.tools.filter(t => !b.backendTools?.some(x => x.name === t.name) && this.policy(owner, id, t.name, 'web')).map(t => ({ ...t, online: !!b.stream && !b.stream.destroyed }))]; }
    async descriptor(owner: string, id: string) {
        const b = this.get(owner, id), endpoint = await this.listen();
        return { name: 'keepwork_aichat', command: process.execPath, args: ['-e', AICHAT_TOOL_PROXY_SOURCE, endpoint], env: [{ name: 'KEEPWORK_AICHAT_CAPABILITY', value: b.capability }, { name: 'ELECTRON_RUN_AS_NODE', value: '1' }] };
    }
    private listen(): Promise<string> {
        if (this.starting) return this.starting;
        this.starting = new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                const b = [...this.bindings.values()].find(b => req.headers.authorization === `Bearer ${b.capability}`);
                if (!b || req.method !== 'POST' || req.headers.origin) { res.writeHead(403); res.end(); return; }
                try {
                    const chunks: Buffer[] = []; let size = 0;
                    for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) throw new Error('Request too large'); chunks.push(chunk); }
                    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const controller = new AbortController();
                    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
                    let result: any;
                    if (message.method === 'tools/list') result = { tools: [
                        { name: 'aichat_list_tools', description: 'Discover the bound AIChat conversation tools, parameter schemas, execution location and online state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
                        { name: 'aichat_call_tool', description: 'Execute one discovered AIChat tool. Web tools require the original page online. Never retry an unknown mutation result.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false } },
                    ] };
                    else if (message.method === 'tools/call' && message.params?.name === 'aichat_list_tools') {
                        const native = await this.nativeFor(b.owner, b.conversationId)?.list().catch(() => []);
                        const names = new Set(this.list(b.owner, b.conversationId).map(t => t.name));
                        result = { content: [{ type: 'text', text: JSON.stringify({ revision: b.revision, tools: [...this.list(b.owner, b.conversationId), ...(native || []).filter(t => !names.has(t.name) && this.policy(b.owner, b.conversationId, t.name, 'native'))] }) }] };
                    }
                    else if (message.method === 'tools/call' && message.params?.name === 'aichat_call_tool') result = await this.invoke(b.owner, b.conversationId, message.params.arguments?.name, message.params.arguments?.arguments, controller.signal);
                    else result = errorResult('Unknown tool');
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
                } catch { res.writeHead(400); res.end(); }
            });
            this.server.on('error', reject);
            this.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(this.server!.address() as import('node:net').AddressInfo).port}/`));
        });
        return this.starting;
    }
    cancel(owner: string, id: string) {
        const b = this.bindings.get(this.key(owner, id)); if (!b) return;
        for (const [callId, pending] of b.pending) {
            b.stream?.write(`event: cancel\ndata: ${JSON.stringify({ callId, pageId: b.pageId, generation: b.generation })}\n\n`);
            clearTimeout(pending.timer); pending.resolve(errorResult('web_result_unknown: CLI cancelled after dispatch; verify any mutation before retrying'));
        }
        b.pending.clear();
    }
    revoke(owner: string) { for (const [key, b] of this.bindings) if (b.owner === owner) { this.disconnect(b); this.bindings.delete(key); this.native.get(key)?.close(); this.native.delete(key); } }
    close() { for (const b of this.bindings.values()) this.disconnect(b); for (const native of this.native.values()) native.close(); this.native.clear(); this.bindings.clear(); this.server?.closeAllConnections(); this.server?.close(); }
}
