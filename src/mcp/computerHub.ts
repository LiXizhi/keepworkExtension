import * as http from 'node:http';
import { readInstance, readToken } from '../core/config';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/** Stdio shares the singleton daemon's desktop lock and pet, without an RPC deadline. */
export function createComputerHub(port: number, clientName: () => string, connection?: () => { url: string; token: string }) {
    let session = '', initialized: Promise<void> | undefined, sequence = 0;
    let base = '';
    const controllers = new Set<AbortController>();
    function request(method: string, body: unknown, signal?: AbortSignal): Promise<any> {
        const token = connection ? connection().token : readToken();
        // Node fetch has a default header deadline. Native HTTP has none while
        // the person is deciding, and still propagates explicit cancellation.
        return new Promise((resolve,reject) => {
            const req = http.request(base + '/mcp', { method, signal, headers: {
                Accept:'application/json, text/event-stream', 'Content-Type':'application/json',
                'MCP-Protocol-Version':'2025-03-26', ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(session ? {'Mcp-Session-Id':session} : {}),
            } }, response => {
                if (!response.statusCode || response.statusCode >= 300) { response.resume(); reject(Error(`Keepwork desktop hub unavailable (${response.statusCode}); reconnect before trying again`)); return; }
                const sid=response.headers['mcp-session-id']; if (typeof sid === 'string') session=sid;
                let text='', size=0;
                response.setEncoding('utf8');
                response.on('error',reject);
                response.on('data',chunk => { size+=Buffer.byteLength(chunk); if(size>6*1024*1024){req.destroy(Error('Oversized desktop result'));return;}text+=chunk; });
                response.on('end',()=>{try{if(!text){resolve(undefined);return;}const value=JSON.parse(text);if(value.error)throw Error(value.error.message||'Desktop hub failed');resolve(value.result);}catch(error){reject(error);}});
            });
            req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
        });
    }
    return {
        async call(args: unknown, signal: AbortSignal): Promise<CallToolResult> {
            const controller = new AbortController(); controllers.add(controller);
            const cancel = () => controller.abort(); signal.addEventListener('abort',cancel,{once:true}); if(signal.aborted) cancel();
            try {
                if (!initialized) initialized = (async () => {
                    const instance = readInstance(); let hubPort = port;
                    if (instance) { try { process.kill(instance.pid,0); hubPort=instance.port; } catch {} }
                    base = connection ? new URL(connection().url).origin : `http://127.0.0.1:${hubPort}`;
                    await request('POST',{jsonrpc:'2.0',id:++sequence,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:clientName(),version:'1.0.0'}}},controller.signal);
                    await request('POST',{jsonrpc:'2.0',method:'notifications/initialized'},controller.signal);
                })();
                await initialized;
                return await request('POST',{jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name:'computer_use',arguments:args}},controller.signal);
            } finally { signal.removeEventListener('abort',cancel); controllers.delete(controller); }
        },
        close() { for (const controller of controllers) controller.abort(); if (session) void request('DELETE',undefined,AbortSignal.timeout(2000)).catch(()=>{}); },
    };
}
