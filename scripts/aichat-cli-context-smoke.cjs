// Explicit real-model verification. Uses an isolated temporary cwd and read-only fixture tools.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: 1, target: 7 } }).outputText, f);
const { AgentSessions, AGENT_BACKENDS } = require('../src/core/agentSessions.ts');
async function verify(backend) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-context-smoke-'));
    const file = path.join(directory, 'sessions.json'), owner = 'isolated-smoke-owner';
    let manager = new AgentSessions(file), calls = 0, nonce = crypto.randomUUID();
    const report = { backend, status: 'not_tested', calls: 0, rounds: 0, reconnected: false };
    const register = () => {
        manager.toolBridge.register(owner, 'smoke', { pageId: crypto.randomUUID(), generation: crypto.randomUUID(), instructions: 'Use keepwork_aichat MCP aichat_list_tools and aichat_call_tool. This is an isolated read-only tool verification. No filesystem writes or external messages. Call verification_value and report its returned value.', revision: 'smoke-v1', tools: [] });
        manager.toolBridge.setBackend(owner, 'smoke', [{ name: 'verification_value', description: 'Read the current verification value', execution: 'backend', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], async () => { calls++; return { content: [{ type: 'text', text: nonce }] }; });
    };
    const turn = async (session, text) => {
        const previous = calls;
        await manager.turn(session.id, owner, { requestId: crypto.randomUUID(), text });
        const deadline = Date.now() + 100000;
        while (Date.now() < deadline) {
            const snapshot = await manager.read(session.id, owner);
            if (snapshot.pending.length) {
                for (const pending of snapshot.pending) {
                    const title = pending.params?.toolCall?.title || pending.params?.command || '';
                    const serialized = JSON.stringify(pending.params || {});
                    if (/aichat_list_tools|aichat_call_tool|verification_value/.test(serialized) && !/run_terminal|commandExecution|shell/.test(serialized)) manager.respond(session.id, owner, { id: pending.id, decision: 'accept' });
                    else throw new Error('Interactive approval outside read-only fixture: ' + pending.method + ' ' + title);
                }
            }
            if (!['starting', 'running', 'waiting', 'uncertain'].includes(snapshot.status)) {
                if (snapshot.status !== 'completed') throw new Error('CLI turn ' + snapshot.status + ': ' + (snapshot.error || ''));
                if (calls <= previous) throw new Error('CLI did not call the scoped MCP tool');
                if (!snapshot.items.some(i => i.type === 'agentMessage' && i.text?.includes(nonce))) throw new Error('CLI answer did not contain the actual tool result');
                report.rounds++; return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('CLI turn timeout');
    };
    const watchdog = setTimeout(() => manager.close(), 250000);
    try {
        if (!manager.inventory()[backend].available) { report.status = 'not_installed'; return report; }
        register();
        const session = await manager.create(owner, { backend, conversationId: 'smoke', roots: [], cloudPrimary: true, contextVersion: 1 });
        await turn(session, 'Discover the keepwork_aichat tools, invoke verification_value through aichat_call_tool, and answer with its returned value.');
        nonce = crypto.randomUUID();
        await turn(session, 'Call verification_value again and report the newly returned value.');
        manager.close(); manager = new AgentSessions(file); register(); nonce = crypto.randomUUID();
        await turn(session, 'After reconnection, call verification_value once more and report its new value.');
        report.reconnected = true; report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.error = error.message.slice(0, 500); }
    finally { clearTimeout(watchdog); report.calls = calls; manager.close(); }
    return report;
}
async function main() {
    const selected = process.argv.slice(2).filter(value => AGENT_BACKENDS.includes(value));
    if (!selected.length) throw new Error('Specify backend IDs; this command makes real model calls');
    const results = await Promise.all(selected.map(async backend => { const result = await verify(backend); console.log(JSON.stringify(result)); return result; }));
    fs.mkdirSync('.test-runtime', { recursive: true });
    fs.writeFileSync('.test-runtime/aichat-context-smoke-' + selected.join('-') + '.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
