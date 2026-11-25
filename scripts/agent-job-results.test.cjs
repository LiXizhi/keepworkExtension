const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => {
    const {outputText} = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    });
    mod._compile(outputText, filename);
};
const {AgentJobCycle} = require('../src/core/agentJobs.ts');

function researchCycle(t, {maxSteps = 8, loseFirstReadResponse = false} = {}) {
    const job = {id: 'job-r', kind: 'research_lead', subject_module: 'leads', subject_id: 'lead-r'};
    const state = {url: 'http://localhost', token: 'fixture', enabled: true, learning: [],
        expiresAt: new Date(Date.now() + 3600000).toISOString()};
    const notifications = [];
    const cycle = new AgentJobCycle(state, job, () => {}, message => notifications.push(message));
    const signal = new AbortController().signal;
    const receipts = [];
    let steps = 0;

    // CRM charges tagged reads as they arrive. finish_job adds usage.steps as a delta,
    // defaulting to one step. Only the top-level fields array reaches lead enrichment.
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'http://localhost/api/v1/ai-tool');
        const {command, args, meta} = JSON.parse(options.body);
        assert.equal(meta?.jobId ?? args.id, job.id);
        const reply = result => Response.json({ok: true, result});
        if (command === 'crm_request' || command === 'search_knowledge') {
            steps++;
            if (loseFirstReadResponse && steps === 1) throw new TypeError('fixture response lost after charging');
            return reply(command === 'crm_request' ? {id: job.subject_id} : {rows: []});
        }
        if (command === 'report_job_step') {
            steps += args.steps ?? 1;
            return reply({stepsUsed: steps, maxSteps, exceeded: steps > maxSteps});
        }
        assert.equal(command, 'finish_job');
        const {result} = args;
        if (Array.isArray(result.fields) && (!result.fields.length || result.fields.some(
            row => !row || !row.field || !row.value || !/^https?:\/\//.test(row.evidence_url),
        ))) return Response.json({ok: false, error: 'Invalid research fields'}, {status: 400});
        receipts.push(result);
        steps += result.usage?.steps || 1;
        return reply({recordId: job.id, status: steps > maxSteps ? '人工待办' : '已完成'});
    });
    return {
        cycle,
        notifications,
        receipts,
        steps: () => steps,
        tool: (name, input) => cycle.tool(name, input, signal),
        finish: result => cycle.tool('job_result', {
            content: '调查摘要', evidence: ['/agent-jobs/job-r'], ...(result === undefined ? {} : {result}),
        }, signal),
    };
}

test('research results forward sourced lead fields and preserve runtime-owned receipt metadata', async t => {
    const crm = researchCycle(t);
    const fields = [{field: 'industry', value: '教育培训', evidence_url: 'https://example.test/company'}];
    await crm.finish({fields, note: '公开资料', summary: 'model override', usage: {steps: 900},
        job_kind: 'model-kind', evidence: ['/other'], nodes: {output: {summary: 'model override'}}});
    const [result] = crm.receipts;
    assert.deepEqual(result.fields, fields);
    assert.equal(result.details.note, '公开资料');
    assert.equal(result.summary, '调查摘要');
    assert.deepEqual(result.evidence, ['/agent-jobs/job-r']);
    assert.equal(result.job_kind, 'research_lead');
    assert.notEqual(result.nodes?.output?.summary, 'model override');
    assert.equal(crm.steps(), 1);
});

test('a summary-only research result still completes without enrichment fields', async t => {
    const crm = researchCycle(t);
    const receipt = await crm.finish();
    assert.equal(receipt.status, '已完成');
    assert.equal(crm.receipts[0].summary, '调查摘要');
    assert.equal(Object.hasOwn(crm.receipts[0], 'fields'), false);
});

for (const [description, fields] of [
    ['wrong shape', {field: 'industry'}],
    ['empty list', []],
    ['missing evidence', [{field: 'industry', value: '教育培训'}]],
]) {
    test('invalid research fields cannot silently complete: ' + description, async t => {
        const crm = researchCycle(t);
        await assert.rejects(crm.finish({fields}));
        assert.equal(crm.receipts.length, 0);
        assert.equal(crm.cycle.finishedJob, false);
    });
}

for (const learn of [false, true]) {
    const expectedSteps = learn ? 6 : 5;
    test('four remote reads plus ' + (learn ? 'local learning and ' : '') + 'completion charge ' + expectedSteps + ' steps', async t => {
        const crm = researchCycle(t, {maxSteps: expectedSteps});
        const recordReads = learn ? 3 : 4;
        for (let i = 0; i < recordReads; i++) {
            await crm.tool('job_read', {method: 'GET', path: '/leads/lead-r'});
        }
        if (learn) await crm.tool('job_knowledge', {query: '教育'});
        assert.equal(crm.steps(), 4);
        if (learn) await crm.tool('job_learn', {
            observation: '已有检索记录', nextAction: '核查公开资料', evidence: ['/leads/lead-r'],
        });
        const receipt = await crm.finish();
        assert.equal(crm.steps(), expectedSteps);
        assert.equal(receipt.status, '已完成');
        assert.equal(crm.receipts[0].learning.length, learn ? 1 : 0);
    });
}

test('a lost read response incurs only the step already charged by CRM', async t => {
    const crm = researchCycle(t, {maxSteps: 2, loseFirstReadResponse: true});
    await assert.rejects(crm.tool('job_read', {method: 'GET', path: '/leads/lead-r'}), /response lost/);
    assert.equal(crm.steps(), 1);
    const receipt = await crm.finish();
    assert.equal(crm.steps(), 2);
    assert.equal(receipt.status, '已完成');
});

test('an actual budget overrun notifies the owner of the CRM human-review status', async t => {
    const crm = researchCycle(t, {maxSteps: 1});
    await crm.tool('job_read', {method: 'GET', path: '/leads/lead-r'});
    const receipt = await crm.finish();
    assert.equal(crm.steps(), 2);
    assert.equal(receipt.status, '人工待办');
    assert.match(crm.notifications.at(-1), /人工待办/);
    assert.doesNotMatch(crm.notifications.at(-1), /已完成/);
});
