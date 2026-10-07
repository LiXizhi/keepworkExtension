const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../config/providers.json');
const supported = require('../../../../skills/agent-cli-verify/references/backends.json');

function loopback(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A loopback daemon origin without credentials is required');
    return url.origin;
}
function validate(data = catalog) {
    const ids = data.providers.map(p => p.id);
    if (ids.length !== new Set(ids).size || [...ids].sort().join() !== [...supported].sort().join()) throw new Error('Provider maintenance coverage differs from supported backends');
    for (const p of data.providers) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.reviewedAt) || !p.commands?.length || !Array.isArray(p.args)) throw new Error('Incomplete provider contract: ' + p.id);
        for (const value of [p.source, p.windows?.url, p.macos?.url].filter(Boolean)) {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid official source: ' + p.id);
        }
        for (const os of ['windows', 'macos']) if (!p[os]?.evidence || (!p[os].command && !p[os].url)) throw new Error('Missing OS recipe: ' + p.id);
    }
}
async function boundedText(response, max = 1024 * 1024) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.length; if (length > max) throw new Error('Response exceeds maintenance limit');
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); }
}
function publicDigest(text) {
    // Treat documents as source data; ignore scripts/styles and volatile whitespace.
    const normalized = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (normalized.length < 40) throw new Error('Official page content was not readable');
    return crypto.createHash('sha256').update(normalized).digest('hex');
}
function runtimeState(info) {
    if (!info.available) return 'unavailable';
    if (info.authenticated === false || /auth|login|sign.in/i.test(info.modelsError || '')) return 'needs_auth';
    if (info.modelsError) return 'capability_error';
    return info.models?.length ? 'models_available' : 'protocol_only';
}
async function audit({ backends, online = false, baseUrl, previous, acceptance, fetchImpl = fetch, data = catalog, now = new Date().toISOString() } = {}) {
    validate(data);
    const selected = backends || supported;
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !supported.includes(id))) throw new Error('Unsupported backend selection');
    const base = baseUrl ? loopback(baseUrl) : undefined;
    const owner = crypto.randomUUID();
    const releaseTasks = new Map(), installerTasks = new Map();
    const report = { version: 1, mode: 'read-only-maintenance', checkedAt: now, scope: selected, allProvidersVerified: false, results: [] };
    const acceptanceTime = Date.parse(acceptance?.finishedAt);
    const age = Date.parse(now) - acceptanceTime;
    const acceptanceCurrent = acceptance?.mode === 'real' && acceptance?.environment?.platform === process.platform
        && acceptance?.environment?.arch === process.arch && age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
    const get = async (url, options = {}) => boundedText(await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12000), redirect: 'follow' }));
    for (const id of selected) {
        const p = data.providers.find(item => item.id === id), old = previous?.results?.find(item => item.backend === id);
        const row = { backend: id, recipes: { windows: p.windows.evidence, macos: p.macos.evidence }, docs: { state: 'not_checked', source: p.source }, installers: {}, release: { state: 'not_checked' }, runtime: { state: 'not_tested' }, execution: { state: 'not_tested' }, changes: [] };
        report.results.push(row);
        if (online) {
            try {
                const digest = publicDigest(await get(p.source)); row.docs = { ...row.docs, state: 'fetched_review_needed', digest };
                if (old?.docs?.digest && old.docs.digest !== digest) row.changes.push('official-document-changed');
            } catch (error) { row.docs.state = 'fetch_failed'; row.docs.reason = error.message; }
            if (p.npm) {
                try {
                    if (!releaseTasks.has(p.npm)) releaseTasks.set(p.npm, get('https://registry.npmjs.org/' + encodeURIComponent(p.npm) + '/latest').then(JSON.parse));
                    const latest = await releaseTasks.get(p.npm);
                    if (latest.name !== p.npm || typeof latest.version !== 'string') throw new Error('Unexpected registry metadata');
                    row.release = { state: 'latest_available', package: p.npm, version: latest.version, engines: latest.engines || {} };
                    if (old?.release?.version && old.release.version !== latest.version) row.changes.push('stable-release-changed');
                } catch (error) { row.release = { state: 'fetch_failed', reason: error.message }; }
            } else row.release.state = 'check-official-channel';
            for (const os of ['windows', 'macos']) {
                const recipe = p[os]; if (!recipe.url) continue;
                try {
                    if (!installerTasks.has(recipe.url)) installerTasks.set(recipe.url, get(recipe.url));
                    const text = await installerTasks.get(recipe.url);
                    if (!text.trim() || /<!doctype\s+html|<html\b/i.test(text)) throw new Error('Installer endpoint returned a web page');
                    const digest = crypto.createHash('sha256').update(text).digest('hex');
                    const version = text.match(/\$version\s*=\s*['"]([^'"]+)['"]/i)?.[1];
                    row.installers[os] = { state: 'fetched_review_needed', source: recipe.url, digest, ...(version ? { version } : {}) };
                    if (old?.installers?.[os]?.digest && old.installers[os].digest !== digest) row.changes.push(os + '-installer-changed');
                    if (!p.npm && version) row.release = { state: 'installer_version_available', source: recipe.url, version };
                } catch (error) { row.installers[os] = { state: 'fetch_failed', source: recipe.url, reason: error.message }; }
            }
        }
        if (base) {
            try {
                const query = new URLSearchParams({ backend: id, conversationId: 'maintenance-' + id });
                const statuses = JSON.parse(await get(base + '/agents/backends?' + query, { headers: { Origin: 'http://localhost:3000', 'X-Agent-Owner': owner, ...(process.env.KEEPWORK_MCP_TOKEN ? { Authorization: 'Bearer ' + process.env.KEEPWORK_MCP_TOKEN } : {}) } }));
                const info = statuses[id]; if (!info) throw new Error('Backend absent from daemon');
                row.runtime = { state: runtimeState(info), ...(info.cli ? { cli: info.cli } : {}), authenticated: info.authenticated ?? null, models: (info.models || []).map(m => ({ id: m.id, supportedReasoningEfforts: m.supportedReasoningEfforts || [] })), ...(info.error || info.modelsError ? { reason: info.error || info.modelsError } : {}) };
            } catch (error) { row.runtime = { state: 'check_failed', reason: error.message }; }
        }
        const native = acceptanceCurrent ? acceptance.results?.find(item => item.backend === id) : undefined;
        const required = ['provider-routing', 'native-tools-two-roots', 'unicode-output', 'multi-turn-continuation', 'snapshot-reconnect'];
        if (native?.status === 'passed' && required.every(check => native.checks?.includes(check))) {
            row.execution = { state: 'passed', checkedAt: acceptance.finishedAt };
        }
    }
    report.allProvidersVerified = new Set(selected).size === supported.length && report.results.every(row =>
        row.runtime.state === 'models_available' && row.execution.state === 'passed' && row.changes.length === 0
        && row.docs.state === 'fetched_review_needed' && ['latest_available', 'check-official-channel', 'installer_version_available'].includes(row.release.state)
        && Object.values(row.installers).every(item => item.state === 'fetched_review_needed'));
    report.summary = { providers: report.results.length, modelsAvailable: report.results.filter(r => r.runtime.state === 'models_available').length, realExecutionPassed: report.results.filter(r => r.execution.state === 'passed').length, changed: report.results.filter(r => r.changes.length).length };
    return report;
}
module.exports = { audit, validate, loopback, publicDigest, runtimeState };
if (require.main === module) {
    const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const output = path.resolve(option('--report') || 'out/agent-cli-maintenance/report.json');
    const previous = option('--previous') ? JSON.parse(fs.readFileSync(option('--previous'), 'utf8')) : undefined;
    const acceptance = option('--acceptance') ? JSON.parse(fs.readFileSync(option('--acceptance'), 'utf8')) : undefined;
    audit({ online: args.includes('--online'), baseUrl: option('--url'), previous, acceptance, ...(option('--backend') ? { backends: [option('--backend')] } : {}) }).then(report => {
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        for (const row of report.results) console.log(`${row.backend}: docs=${row.docs.state}, release=${row.release.state}, runtime=${row.runtime.state}, execution=${row.execution.state}`);
        console.log('Report: ' + output);
        if (args.includes('--strict') && !report.allProvidersVerified) process.exitCode = 1;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
