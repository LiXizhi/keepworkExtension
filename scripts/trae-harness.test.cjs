const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file);
const { TraeHarness } = require('../src/core/traeHarness.ts');
const { AGENT_CLI, AGENT_BACKENDS } = require('../src/core/agentCliBackends.ts');
const fixture = path.join(__dirname, 'fixtures/fake-trae.cjs');
function setup(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trae harness 中文 ')));
    const log = path.join(dir, 'launches.jsonl'), directory = path.join(dir, 'cache');
    const adapters = [];
    const make = () => { const adapter = new TraeHarness(directory, process.execPath, [fixture, '--log=' + log]); adapters.push(adapter); return adapter; };
    const adapter = make();
    t.after(async () => { adapters.forEach(value => value.close()); await new Promise(resolve => setTimeout(resolve, 100)); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const rows = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { adapter, dir, directory, make, rows };
}
async function turn(adapter, threadId, text, extra = {}) {
    let listener, timeout;
    const completed = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Trae fixture did not finish')), 5000);
        listener = message => { if (message.method === 'turn/completed' && message.params.threadId === threadId) resolve(message.params.turn); };
        adapter.on('notification', listener);
    });
    try { await adapter.call('turn/start', { threadId, input: [{ type: 'text', text }], ...extra }); return await completed; }
    finally { clearTimeout(timeout); adapter.off('notification', listener); }
}
const messages = thread => thread.turns.flatMap(turn => turn.items || []).filter(item => item.type === 'agentMessage');
test('the stable trae backend selects open-source trae-cli without inventing ACP or native model discovery', async t => {
    const { adapter, rows } = setup(t);
    assert.ok(AGENT_BACKENDS.includes('trae'));
    assert.equal(AGENT_CLI.trae.name, 'Trae Agent');
    assert.deepEqual(AGENT_CLI.trae.commands, ['trae-cli']);
    assert.notEqual(AGENT_CLI.trae.protocol, 'acp');
    assert.equal(AGENT_CLI.trae.installUrl, 'https://github.com/bytedance/trae-agent');
    const account = await adapter.call('account/read');
    assert.equal(account.authUnknown, true);
    assert.equal(account.account ?? null, null);
    assert.deepEqual((await adapter.call('model/list')).data, []);
    assert.equal(rows().length, 0, 'status must not execute a task or attempt login');
});
test('Trae uses file arguments for literal Unicode prompts and projects only completed native trajectory output', async t => {
    const { adapter, dir, directory, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    const prompt = 'FIXTURE_INSPECT 中文😀 $(touch forbidden) & literal';
    assert.equal((await turn(adapter, thread.id, prompt)).status, 'completed');
    const [launch] = rows();
    assert.equal(launch.prompt, prompt);
    assert.equal(launch.args[launch.args.indexOf('--working-dir') + 1], dir);
    assert.equal(launch.args[launch.args.indexOf('--console-type') + 1], 'simple');
    assert.ok(!launch.args.includes(prompt));
    assert.ok(!launch.args.includes('--acp'));
    assert.ok(path.isAbsolute(launch.file)); assert.ok(path.isAbsolute(launch.trajectory));
    if (process.platform !== 'win32') assert.equal(launch.promptMode, 0o600);
    const saved = (await adapter.call('thread/read', { threadId: thread.id })).thread;
    assert.equal(saved.driver, 'trae-agent-v1');
    assert.ok(saved.turns[0].items.some(item => item.type === 'mcpToolCall' && item.result === 'read result'));
    const contents = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
    for (const secret of ['RAW_STDOUT_PRIVATE_TOKEN', 'RAW_STDERR_PRIVATE_TOKEN', 'RAW_LLM_PRIVATE_TOKEN']) assert.ok(!contents.includes(secret));
    assert.ok(!fs.existsSync(path.join(dir, 'forbidden')));
});
test('two native runs are explicitly independent; restart restores history without replaying either task', async t => {
    const { adapter, dir, make, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    await turn(adapter, thread.id, 'first unique task'); await turn(adapter, thread.id, 'second unique task');
    assert.deepEqual(rows().map(row => row.prompt), ['first unique task', 'second unique task']);
    assert.notEqual(rows()[0].pid, rows()[1].pid);
    const saved = (await adapter.call('thread/read', { threadId: thread.id })).thread;
    assert.ok(messages(saved).some(item => /independent|独立|one-shot|fresh/i.test(item.text)));
    adapter.close(); const restored = make();
    await restored.call('thread/resume', { threadId: thread.id });
    const reread = (await restored.call('thread/read', { threadId: thread.id })).thread;
    assert.deepEqual(reread.turns, saved.turns);
    assert.equal(rows().length, 2);
    assert.equal((await turn(restored, thread.id, 'third fresh task')).status, 'completed');
    assert.equal(rows().length, 3);
});
test('unsupported context, permissions, images and reasoning are rejected before native work starts', async t => {
    const { adapter, dir, rows } = setup(t);
    await assert.rejects(adapter.call('thread/start', { cwd: dir, mcpServers: [{ name: 'keepwork_aichat', command: 'node' }] }), /MCP|unsupported/i);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    for (const mode of ['ask', 'plan']) await assert.rejects(adapter.call('thread/mode/set', { threadId: thread.id, mode }), /unsupported|mode|read.only|Ask|Plan/i);
    await assert.rejects(adapter.call('thread/mode/set', { threadId: thread.id, mode: 'craft', effort: 'high' }), /effort|reasoning|unsupported/i);
    await assert.rejects(adapter.call('turn/start', { threadId: thread.id, input: [{ type: 'image', url: 'data:image/png;base64,eA==' }] }), /image|text|unsupported/i);
    await assert.rejects(adapter.call('thread/list', {}), /unsupported|history|list/i);
    await assert.rejects(adapter.call('thread/native/read', { threadId: thread.id }), /unsupported|history|native/i);
    assert.equal(rows().length, 0);
    assert.equal((await turn(adapter, thread.id, 'ordinary task still works')).status, 'completed');
});
for (const scenario of ['CRASH', 'NONZERO', 'FAILED', 'INCOMPLETE', 'MISSING', 'MALFORMED']) test(`Trae ${scenario.toLowerCase()} never becomes successful from console output or process exit alone`, async t => {
    const { adapter, dir, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    assert.equal((await turn(adapter, thread.id, 'FIXTURE_' + scenario)).status, 'failed');
    assert.equal(rows().length, 1);
    const saved = (await adapter.call('thread/read', { threadId: thread.id })).thread;
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_TOKEN'));
});
test('native interruption stops the run and does not replay it when reading history', async t => {
    const { adapter, dir, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    const completion = turn(adapter, thread.id, 'FIXTURE_WAIT');
    const deadline = Date.now() + 3000;
    while (!rows().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(rows().length, 1);
    await adapter.call('turn/interrupt', { threadId: thread.id });
    assert.equal((await completion).status, 'interrupted');
    await adapter.call('thread/read', { threadId: thread.id });
    assert.equal(rows().length, 1);
});
test('interruption cannot report completion or allow another task while the old native process ignores termination', { skip: process.platform === 'win32' }, async t => {
    const { adapter, dir, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    let finished = false;
    const completion = turn(adapter, thread.id, 'FIXTURE_IGNORE_TERM').then(value => { finished = true; return value; });
    const deadline = Date.now() + 3000;
    while (!rows().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(rows().length, 1);
    const pid = rows()[0].pid;
    await adapter.call('turn/interrupt', { threadId: thread.id });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, 'a live native process must retain the busy turn until it exits');
    assert.doesNotThrow(() => process.kill(pid, 0));
    await assert.rejects(adapter.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'must not overlap' }] }), /already running|busy/i);
    assert.equal((await completion).status, 'interrupted');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(rows().length, 1);
});
test('interruption kills a tool descendant holding native output open after the parent exits', { skip: process.platform === 'win32' }, async t => {
    const { adapter, dir, rows } = setup(t);
    const { thread } = await adapter.call('thread/start', { cwd: dir });
    let finished = false;
    const completion = turn(adapter, thread.id, 'FIXTURE_DESCENDANT').then(value => { finished = true; return value; });
    const deadline = Date.now() + 3000;
    while (!rows().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(rows().length, 1);
    const { pid, descendantPid } = rows()[0];
    assert.ok(Number.isSafeInteger(descendantPid));
    await adapter.call('turn/interrupt', { threadId: thread.id });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the parent must have exited before forced cleanup');
    assert.doesNotThrow(() => process.kill(descendantPid, 0), 'the tool descendant is still alive and owns the output pipe');
    assert.equal(finished, false, 'parent exit alone must not release the busy turn');
    await assert.rejects(adapter.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'must not overlap tool' }] }), /already running|busy/i);
    assert.equal((await completion).status, 'interrupted');
    const reaped = Date.now() + 1000;
    let descendantAlive = true;
    while (descendantAlive && Date.now() < reaped) {
        try { process.kill(descendantPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
        catch (error) { if (error.code !== 'ESRCH') throw error; descendantAlive = false; }
    }
    assert.equal(descendantAlive, false, 'completion requires terminating the entire owned process group');
    assert.equal(rows().length, 1);
});
test('legacy ACP Trae transcripts remain readable without being submitted to trae-cli', async t => {
    const { adapter, dir, directory, rows } = setup(t);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'legacy-trae.json'), JSON.stringify({ id: 'legacy-trae', cwd: dir, turns: [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'preserved old reply' }] }] }));
    assert.equal(messages((await adapter.call('thread/read', { threadId: 'legacy-trae' })).thread)[0].text, 'preserved old reply');
    await adapter.call('thread/resume', { threadId: 'legacy-trae' });
    await assert.rejects(adapter.call('turn/start', { threadId: 'legacy-trae', input: [{ type: 'text', text: 'must not replay' }] }), /legacy|new.*chat|new.*session|read.only/i);
    assert.equal(rows().length, 0);
});
