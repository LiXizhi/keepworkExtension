// Model providers that capture process.cwd() at startup, even when ACP supplies cwd.
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sessions = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params: p } = JSON.parse(line);
    let result = {};
    if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (method === 'session/new' || method === 'session/load') {
        const sessionId = p.sessionId || randomUUID();
        sessions.set(sessionId, p.cwd);
        result = { sessionId, models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] } };
    }
    if (method === 'session/prompt') {
        const markerFile = path.join(process.cwd(), 'workspace-marker.txt');
        send({ method: 'session/update', params: { sessionId: p.sessionId, update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({
                cwd: process.cwd(), sessionCwd: sessions.get(p.sessionId), pid: process.pid,
                marker: fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : null,
            }) },
        } } });
        result = { stopReason: 'end_turn' };
    }
    send({ id, result });
});
