const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ts = require('typescript');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('authenticated Streamable HTTP and real stdio return MCP images through one hub', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-transports-'));
    const oldHome = os.homedir, oldLoader = require.extensions['.ts'];
    let server;
    try {
        os.homedir = () => home;
        require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText, filename);
        const { startHttpServer } = require('../src/mcp/http.ts');
        const hub = require('../src/core/paracraftClients.ts');
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        server = await startHttpServer({ port, root: home, requireAuth: true });
        const deniedLaunch=await fetch(`http://127.0.0.1:${port}/paracraft/launch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:987654})});
        assert.equal(deniedLaunch.status,401);
        const clientId = 'transport-image';
        await hub.registerClient({ clientId, kpProjectId: 987654, worldEntered: true });
        const idleId = 'transport-idle-desktop';
        await hub.registerClient({ clientId: idleId, worldEntered: false });
        const identity = { clientId, worldPath: 'test/', sessionId: 4 };
        const bootstrap = `const fs=require('node:fs'),os=require('node:os'),ts=require('typescript');
os.homedir=()=>${JSON.stringify(home)};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
require(${JSON.stringify(path.resolve(__dirname, '../src/mcp/stdio.ts'))}).startStdioServer({port:${port},root:${JSON.stringify(home)}});`;
        for (const transport of [
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }),
            new StdioClientTransport({ command: process.execPath, args: ['-e', bootstrap], cwd: path.resolve(__dirname, '..'), stderr: 'pipe' }),
        ]) {
            const client = new Client({ name: 'creation-transport-test', version: '1' });
            try {
                await client.connect(transport);
                const local=await client.callTool({name:'paracraft_cli',arguments:{action:'launch',params:{waitSeconds:0}}});
                const startup=JSON.parse(local.content[0].text);
                assert.ok(!local.isError);assert.equal(startup.target,'client');assert.equal(startup.clientId,idleId);
                assert.equal(startup.state,'ready');assert.equal(startup.reused,true);
                const creation=client.callTool({name:'paracraft_cli',arguments:{action:'run_command',clientId:idleId,
                    params:{world:{operation:'create',name:'雪山 村庄'}}}});
                const [worldJob]=await hub.pollJobs(idleId,5000);
                assert.equal(worldJob.request.action,'run_command');
                assert.deepEqual(worldJob.request.params.world,{operation:'create',name:'雪山 村庄'});
                hub.completeJob(idleId,worldJob.jobId,{ok:true,result:{ok:true,status:'created',worldPath:'local/雪山 村庄/'}});
                assert.ok(!(await creation).isError);
                const launched=await client.callTool({name:'paracraft_cli',arguments:{action:'launch',params:{projectId:987654,waitSeconds:0}}});
                const launch=JSON.parse(launched.content[0].text);
                assert.ok(!launched.isError);assert.equal(launch.state,'ready');assert.equal(launch.clientId,clientId);assert.equal(launch.reused,true);
                const checked=await client.callTool({name:'paracraft_cli',arguments:{action:'launch_status',params:{launchId:launch.launchId}}});
                assert.equal(JSON.parse(checked.content[0].text).clientId,clientId);
                const pending = client.callTool({ name: 'paracraft_cli', arguments: { action: 'camera_capture', clientId, params: { expectedIdentity: identity, nearPet: true } } });
                const [job] = await hub.pollJobs(clientId, 5000);
                assert.equal(job.request.action, 'camera_capture');
                assert.deepEqual(job.request.params.expectedIdentity, identity);
                hub.completeJob(clientId, job.jobId, { ok: true, result: { ok: true, base64: 'AQID', mimeType: 'image/jpeg', sessionId: 4 } });
                const result = await pending;
                assert.ok(!result.isError);
                assert.equal(result.content[1].type, 'image');
                assert.equal(result.content[1].data, 'AQID');
                assert.ok(!result.content[0].text.includes('AQID'));
            } finally { await client.close(); }
        }
        hub.unregisterClient(clientId);
        hub.unregisterClient(idleId);
    } finally {
        if (server) await server.close();
        os.homedir = oldHome; require.extensions['.ts'] = oldLoader;
        fs.rmSync(home, { recursive: true, force: true });
    }
});
