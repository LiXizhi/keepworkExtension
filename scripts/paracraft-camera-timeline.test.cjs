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

test('camera history stays separate, bounded and scoped to the client project', async () => {
    const clientId = 'camera-timeline-test';
    await hub.registerClient({ clientId, kpProjectId: 1 });
    async function capture(action, base64, ok = true) {
        const response = hub.dispatchAction(clientId, action, { fresh: true });
        const [job] = await hub.pollJobs(clientId, 500);
        assert.ok(job);
        hub.completeJob(clientId, job.jobId, { ok, result: { ok, base64, mimeType: 'image/jpeg', width: 400, height: 300 } });
        await response;
    }
    try {
        await capture('screenshot', 'screen');
        for (let i = 0; i < 8; i++) await capture('camera_capture', `camera${i}`);
        await capture('camera_capture', 'failed', false);
        const timeline = hub.getTimeline(clientId);
        assert.equal(timeline.screenshots.length, 1);
        assert.equal(timeline.screenshots[0].dataUrl, 'data:image/jpeg;base64,screen');
        assert.equal(hub.getCachedScreenshot(clientId).base64, 'screen');
        assert.equal(timeline.cameraShots.length, 6);
        assert.equal(timeline.cameraShots[0].dataUrl, 'data:image/jpeg;base64,camera7');
        assert.equal(timeline.cameraShots[5].dataUrl, 'data:image/jpeg;base64,camera2');
        await capture('screenshot', 'screen2');
        assert.equal(hub.getTimeline(clientId).cameraShots[0].dataUrl, 'data:image/jpeg;base64,camera7');
        await hub.registerClient({ clientId, kpProjectId: 2 });
        assert.deepEqual(hub.getTimeline(clientId).cameraShots, []);
        assert.deepEqual(hub.getTimeline(clientId).screenshots, []);
    } finally {
        hub.unregisterClient(clientId);
    }
});
