// Explicit opt-in: node scripts/paracraft-creation-native.cjs <engine-port> <world-path>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { registerCreationTools } = require('../src/mcp/paracraftTools.ts');
const hub = require('../src/core/paracraftClients.ts');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
async function main() {
    const port = Number(process.argv[2]), expectedPath = process.argv[3];
    assert.ok(port && expectedPath, 'Explicit engine port and disposable-world path required');
    const discovery = await (await fetch(`http://127.0.0.1:${port}/ajax/paracraft_cli?action=get_creation_capabilities`)).json();
    const identity = discovery.result.identity, clientId = identity.clientId;
    assert.equal(identity.worldPath, expectedPath, 'Wrong world; refusing tests');
    await hub.registerClient({ clientId, nplPort: port, worldPath: expectedPath });
    const server = new McpServer({ name: 'native-creation-acceptance', version: '1' });
    registerCreationTools(server, { port: 8089 });
    const client = new Client({ name: 'native-acceptance', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const call = async (action, args = {}) => {
        const r = await client.callTool({ name: 'paracraft_cli', arguments: { action, clientId, params: args } });
        assert.ok(!r.isError, r.content[0]?.text); return r;
    };
    try {
        await call('get_creation_capabilities');
        const doc = await call('read_official_wiki', { path: 'creation.md' });
        assert.match(doc.content[0].text, /createScene/);
        const code = `local result={}
for _,name in ipairs({"pavilion","character"}) do
 local s=createScene({name=name,resume=true})
 local count,stale=0,0
 for _,group in pairs(s:inspect().groups) do for _,member in ipairs(group.members) do
  count=count+1;if member.stale then stale=stale+1 end
 end end
 result[name]={members=count,stale=stale,artifacts=s.artifacts}
 if name=="character" then result.eye=s:toWorld({14,10,14});result.lookat=s:toWorld({7,3,7});result.movie=s:position({1,0,10}) end
end
return result`;
        const started = JSON.parse((await call('run_code', { expectedIdentity: identity, requestId: `native-${Date.now()}`, code })).content[0].text).result;
        let status;
        for (let i = 0; i < 100; i++) {
            status = JSON.parse((await call('code_job', { expectedIdentity: identity, jobId: started.jobId })).content[0].text).result;
            if (status.state !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(status.state, 'completed', status.error);
        assert.equal(status.result.pavilion.stale, 0);
        assert.equal(status.result.character.stale, 0);
        assert.ok(status.result.character.members >= 10);
        const before = (await hub.dispatchAction(clientId, 'get_scene_info', {})).body.result;
        for (const timeSeconds of [0, 1.5]) {
            const image = await call('camera_capture', { expectedIdentity: identity, eye: status.result.eye, lookat: status.result.lookat, moviePosition: status.result.movie, timeSeconds });
            assert.equal(image.content[1].type, 'image');
            assert.equal(JSON.parse(image.content[0].text).sessionId, identity.sessionId);
        }
        const screen = await call('screenshot', { expectedIdentity: identity });
        assert.equal(screen.content[1].type, 'image');
        const after = (await hub.dispatchAction(clientId, 'get_scene_info', {})).body.result;
        assert.deepEqual(after.player, before.player, 'Capture moved the player');
        assert.deepEqual(after.camera, before.camera, 'Capture moved the main camera');
        console.log('PASS native MCP: bundled docs, resumed groups, no stale members, idle/wave captures, screenshot/session metadata');
    } finally { hub.unregisterClient(clientId); await client.close(); await server.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
