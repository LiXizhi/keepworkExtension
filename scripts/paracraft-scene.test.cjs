const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/core/paracraftClients.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const hub = mod.exports;

test('scene actions preserve parameters, pages and errors through poll transport', async () => {
    const clientId = 'scene-test';
    await hub.registerClient({ clientId, kpProjectId: 1 });
    try {
        for (const [action, params, result] of [
            ['world_files', { operation: 'read', path: '_codeblocks_/test_block(-1,2,-3)', expectedIdentity: { clientId, worldPath: 'world/', sessionId: 1 } }, { ok: true, content: 'print(1)' }],
            ['get_scene_info', { anchor: 'pet' }, { ok: true, chunks: [{ chunkX: -1, chunkZ: 0 }] }],
            ['query_scene', { chunkX: -1, chunkZ: 0, cursor: 'scene-1:201' }, { ok: true, lines: ['/setblock -16 3 0 (15 0 15) 2:0'], hasMore: false }],
            ['read_scene_object', { ref: { worldSession: 'old', kind: 'entity', id: '1' } }, { ok: false, error: 'stale object reference' }],
        ]) {
            const pending = hub.dispatchAction(clientId, action, params);
            const [job] = await hub.pollJobs(clientId, 500);
            assert.equal(job.request.action, action);
            assert.deepEqual(job.request.params, params);
            const reply = { v: 1, ok: result.ok, action, result };
            hub.completeJob(clientId, job.jobId, reply);
            assert.deepEqual((await pending).body, reply);
        }
        assert.equal((await hub.dispatchAction(clientId, 'http_request', {})).status, 400);
    } finally {
        hub.unregisterClient(clientId);
    }
});
