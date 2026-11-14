#!/usr/bin/env node
// Deterministic peer for the public trae-cli run/file/trajectory contract.
// No real account, provider requests, or user workspace changes are involved.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const log = args.find(arg => arg.startsWith('--log='))?.slice(6) || process.env.KEEPWORK_TRAE_FIXTURE_LOG;
if (!args.includes('run') || !args.includes('--file') || !args.includes('--working-dir') || !args.includes('--trajectory-file') || option('--console-type') !== 'simple' || args.includes('--acp') || args.includes('serve')) process.exit(91);
const file = option('--file'), trajectory = option('--trajectory-file');
const prompt = fs.readFileSync(file, 'utf8');
if (prompt.includes('FIXTURE_IGNORE_TERM')) process.on('SIGTERM', () => {});
const record = { event: 'run', pid: process.pid, args, cwd: process.cwd(), prompt, file, trajectory, promptMode: fs.statSync(file).mode & 0o777 };
if (log && !prompt.includes('FIXTURE_DESCENDANT')) fs.appendFileSync(log, JSON.stringify(record) + '\n');
// Terminal rendering is neither a protocol nor safe diagnostic output.
process.stdout.write('RAW_STDOUT_PRIVATE_TOKEN\n');
process.stderr.write('RAW_STDERR_PRIVATE_TOKEN\n');
if (prompt.includes('FIXTURE_DESCENDANT')) {
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    descendant.once('message', () => {
        record.descendantPid = descendant.pid;
        if (log) fs.appendFileSync(log, JSON.stringify(record) + '\n');
    });
    setInterval(() => {}, 1000);
    return;
}
if (prompt.includes('FIXTURE_WAIT') || prompt.includes('FIXTURE_IGNORE_TERM')) { setInterval(() => {}, 1000); return; }
if (prompt.includes('FIXTURE_CRASH')) process.exit(17);
if (prompt.includes('FIXTURE_MISSING')) process.exit(0);
if (prompt.includes('FIXTURE_MALFORMED')) { fs.writeFileSync(trajectory, '{"success":'); process.exit(0); }
const inspect = prompt.includes('FIXTURE_INSPECT');
const result = inspect ? JSON.stringify(record) : '中文😀';
const data = {
    task: prompt,
    start_time: new Date().toISOString(),
    end_time: prompt.includes('FIXTURE_INCOMPLETE') ? '' : new Date().toISOString(),
    provider: 'fixture-provider', model: 'fixture-native-model',
    success: !prompt.includes('FIXTURE_FAILED'), final_result: result,
    llm_interactions: [{ input_messages: [{ role: 'system', content: 'RAW_LLM_PRIVATE_TOKEN' }] }],
    agent_steps: [{ step_number: 1, state: 'COMPLETED',
        llm_response: { content: 'Native analysis', model: 'fixture-native-model' },
        tool_calls: [{ call_id: 'read-1', name: 'read_file', arguments: { path: 'fixture.txt' } }],
        tool_results: [{ call_id: 'read-1', success: true, result: 'read result', error: null }],
    }],
};
fs.mkdirSync(path.dirname(trajectory), { recursive: true });
setTimeout(() => { fs.writeFileSync(trajectory, JSON.stringify(data)); process.exit(prompt.includes('FIXTURE_NONZERO') ? 3 : 0); }, 25);
