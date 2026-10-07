

/** Private stdio adapter. Only a revocable session capability crosses into the CLI. */
export const AICHAT_TOOL_PROXY_SOURCE = String.raw`
(async () => {
    const readline = require('node:readline');
    const endpoint = process.argv[1];
    const capability = process.env.KEEPWORK_AICHAT_CAPABILITY;
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !capability) throw new Error('Invalid AIChat tool bridge');
    const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
    const active = new Map();
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        if (line.length > 2_000_000) { lines.close(); break; }
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'notifications/cancelled') { active.get(message.params?.requestId)?.abort(); continue; }
        if (message.id === undefined) continue;
        void (async () => {
            const controller = new AbortController(); active.set(message.id, controller);
            try {
                let result;
                if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'keepwork-aichat', version: '1.0.0' } };
                else if (message.method === 'ping') result = {};
                else if (['tools/list', 'tools/call'].includes(message.method)) {
                    const progressToken = message.params?._meta?.progressToken;
                    if (message.method === 'tools/call' && progressToken !== undefined) write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, message: 'Running the bound Keepwork tool; any webpage confirmation must be completed in the original AIChat page.' } });
                    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: message.method, params: message.params }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125000)]) });
                    if (!response.ok) throw new Error('AIChat bridge disconnected; reconnect the original conversation');
                    result = await response.json();
                } else { write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported method' } }); return; }
                write({ jsonrpc: '2.0', id: message.id, result });
            } catch { write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'AIChat bridge unavailable; operation was not retried' } }); } finally { active.delete(message.id); }
        })();
    }
    for (const controller of active.values()) controller.abort();
})().catch(() => { process.exitCode = 1; });
`;
