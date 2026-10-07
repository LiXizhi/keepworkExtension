const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file);
const { AGENT_CLI, AGENT_BACKENDS } = require('../src/core/agentCliBackends.ts');
const catalog = require('../.github/skills/agent-cli-maintenance/config/providers.json');
const { audit, validate } = require('../.github/skills/agent-cli-maintenance/scripts/maintain.cjs');
const { render, installReference } = require('./sync-agent-cli-skills.cjs');

test('one development Skill covers every provider through references and two OS recipes matching the native launch contract', () => {
    validate();
    assert.deepEqual(catalog.providers.map(p => p.id), [...AGENT_BACKENDS]);
    for (const p of catalog.providers) {
        assert.deepEqual(p.commands, AGENT_CLI[p.id].commands);
        assert.deepEqual(p.args, AGENT_CLI[p.id].args);
        assert.equal(p.protocol, AGENT_CLI[p.id].protocol);
        assert.equal(p.npm, AGENT_CLI[p.id].npm);
        assert.equal(fs.readFileSync(`.github/skills/agent-cli-maintenance/references/providers/${p.id}.md`, 'utf8'), render(p));
        assert.ok(!fs.existsSync(`.github/skills/agent-cli-${p.id}/SKILL.md`));
        assert.equal(fs.readFileSync(`skills/agent-cli-verify/references/providers/${p.id}.md`, 'utf8'), installReference(p));
    }
    assert.throws(() => validate({ providers: catalog.providers.slice(1) }), /coverage/);
});
test('offline maintenance preserves all providers as untested and never claims acceptance', async () => {
    const result = await audit({ fetchImpl: () => { throw new Error('offline must not fetch'); } });
    assert.equal(result.results.length, AGENT_BACKENDS.length);
    assert.equal(result.allProvidersVerified, false);
    assert.ok(result.results.every(r => r.execution.state === 'not_tested' && r.runtime.state === 'not_tested'));
});

test('maintenance capabilities pass the actual agent HTTP ownership validation', async t => {
    const http = require('node:http');
    const { handleAgentHttp } = require('../src/mcp/agentHttp.ts');
    const requested = [];
    const manager = { async status(backend, scope) { requested.push({ backend, scope }); return { available: true, models: [{ id: 'native' }] }; } };
    const server = http.createServer((req, res) => handleAgentHttp(req, res, new URL(req.url, 'http://localhost'), manager));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const result = await audit({ backends: ['copilot'], baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.results[0].runtime.state, 'models_available');
    assert.equal(requested.length, 1); assert.equal(requested[0].backend, 'copilot');
    assert.ok(requested[0].scope.owner);
});
test('targeted maintenance detects doc/release drift and authentication without calling another CLI or exposing credentials', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push(url);
        if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ name: '@github/copilot', version: '2.0.0', engines: { node: '>=22' } }));
        if (url.includes('/agents/backends')) {
            assert.equal(new URL(url).searchParams.get('backend'), 'copilot');
            assert.ok(options.headers['X-Agent-Owner']);
            return new Response(JSON.stringify({ copilot: { available: true, models: [], modelsError: 'Authentication required' } }));
        }
        return new Response('<p>Current official installation instructions with meaningful updated content.</p>');
    };
    const result = await audit({ backends: ['copilot'], online: true, baseUrl: 'http://127.0.0.1:8089', fetchImpl,
        previous: { results: [{ backend: 'copilot', docs: { digest: 'old' }, release: { version: '1.0.0' } }] } });
    const row = result.results[0];
    assert.deepEqual(row.changes, ['official-document-changed', 'stable-release-changed']);
    assert.equal(row.runtime.state, 'needs_auth'); assert.equal(result.allProvidersVerified, false);
    assert.equal(calls.length, 3); assert.ok(!JSON.stringify(result).includes('Authorization'));
});
test('failed network checks remain failed and shared CodeBuddy release metadata is fetched once', async () => {
    let releases = 0;
    const result = await audit({ backends: ['workbuddy', 'codebuddy'], online: true, fetchImpl: async url => {
        if (url.includes('registry.npmjs.org')) { releases++; return new Response(JSON.stringify({ name: '@tencent-ai/codebuddy-code', version: '1.0.0' })); }
        return new Response('unavailable', { status: 503 });
    } });
    assert.equal(releases, 1); assert.ok(result.results.every(row => row.docs.state === 'fetch_failed'));
    assert.equal(result.allProvidersVerified, false);
});
test('fixture reports, expired real reports and other OS reports cannot become real execution evidence', async () => {
    for (const acceptance of [
        { mode: 'probe-only' },
        { mode: 'real', finishedAt: '2020-01-01' },
        { mode: 'real', finishedAt: new Date().toISOString(), environment: { platform: 'other', arch: process.arch } },
    ]) {
        const result = await audit({ acceptance });
        assert.equal(result.summary.realExecutionPassed, 0); assert.equal(result.allProvidersVerified, false);
    }
    await assert.rejects(audit({ baseUrl: 'https://example.com' }), /loopback/);
    await assert.rejects(audit({ backends: ['unknown'] }), /Unsupported/);
});

test('Cursor installer version/digest changes are detected without executing the downloaded script', async () => {
    const result = await audit({ backends: ['cursor'], online: true, previous: { results: [{ backend: 'cursor', installers: { windows: { digest: 'old' } } }] }, fetchImpl: async url =>
        new Response(url.includes('/install') ? "$version = '2026.10.08-abc'\n# official installer body" : '<p>Official Cursor CLI installation instructions for the current release.</p>') });
    assert.equal(result.results[0].release.version, '2026.10.08-abc');
    assert.ok(result.results[0].changes.includes('windows-installer-changed'));
    assert.equal(result.summary.realExecutionPassed, 0);
});

test('complete current native evidence can pass all-provider verification; a single doc failure still prevents it', async () => {
    const now = '2026-10-07T01:00:00.000Z';
    const acceptance = { mode: 'real', finishedAt: now, environment: { platform: process.platform, arch: process.arch }, results: catalog.providers.map(p => ({ backend: p.id, status: 'passed', checks: ['provider-routing', 'native-tools-two-roots', 'unicode-output', 'multi-turn-continuation', 'snapshot-reconnect'] })) };
    let failDocs = false;
    const fetchImpl = async url => {
        if (url.includes('/agents/backends')) {
            const id = new URL(url).searchParams.get('backend');
            return new Response(JSON.stringify({ [id]: { available: true, authenticated: true, models: [{ id: 'native-model' }] } }));
        }
        if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ name: decodeURIComponent(url.split('/')[3]), version: '1.0.0' }));
        if (url.includes('/install.ps1') || url.includes('/install_v2.') || url === 'https://cursor.com/install' || url.includes('install?win32') || url.endsWith('/install.sh')) return new Response("$version = '1.0.0'\n# real installer content fixture");
        return new Response('<p>Official provider installation instructions with enough meaningful content.</p>', { status: failDocs ? 503 : 200 });
    };
    const result = await audit({ now, online: true, baseUrl: 'http://127.0.0.1:8089', acceptance, fetchImpl });
    assert.equal(result.allProvidersVerified, true); assert.equal(result.summary.realExecutionPassed, catalog.providers.length);
    failDocs = true;
    assert.equal((await audit({ now, online: true, baseUrl: 'http://127.0.0.1:8089', acceptance, fetchImpl })).allProvidersVerified, false);
});
