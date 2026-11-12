#!/usr/bin/env node
/** Isolated native agy peer: never contacts providers or reads real credentials. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
function log(event, data = {}) {
  if (process.env.KEEPWORK_ANTIGRAVITY_FIXTURE_LOG) {
    fs.appendFileSync(process.env.KEEPWORK_ANTIGRAVITY_FIXTURE_LOG,
      JSON.stringify({ event, pid: process.pid, ...data }) + '\n');
  }
}
log('start', { args });
if (args.includes('--version')) {
  console.log('antigravity-fixture 1.0.0');
  process.exit(0);
}
if (args.includes('models')) {
  if (fs.existsSync(process.env.KEEPWORK_ANTIGRAVITY_FIXTURE_LOG + '.models-fail')) {
    process.stderr.write('private-fixture-diagnostic\n');
    process.exit(3);
  }
  console.log('\x1b[32mnative-model\tNative model\x1b[0m\nfast-model\tFast model');
  process.exit(0);
}
if (!args.includes('--input-format') || !args.includes('--output-format')
  || args.includes('--acp') || args.includes('--dangerously-skip-permissions')) process.exit(2);
const nativeId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : randomUUID();
function send(value) {
  const bytes = Buffer.from(JSON.stringify({ ...value, futureOptionalField: { ignored: true } }) + '\n');
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  if (split > 0) {
    process.stdout.write(bytes.subarray(0, split));
    process.stdout.write(bytes.subarray(split));
  } else process.stdout.write(bytes);
}
send({ event: 'init', conversation_id: nativeId, init: { cwd: process.cwd() } });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.event !== 'user' || typeof message.message?.content !== 'string') process.exit(4);
  const content = message.message.content;
  log('prompt', { nativeId, content });
  if (content.includes('FIXTURE_CRASH')) process.exit(7);
  if (content.includes('FIXTURE_WAIT')) return;
  if (content.includes('FIXTURE_BAD_JSON')) { process.stdout.write('{\n'); return; }
  if (content.includes('FIXTURE_FLOOD')) { process.stdout.write('x'.repeat(8_000_001)); return; }
  if (content.includes('FIXTURE_BAD_ID')) {
    send({ event: 'result', result: { conversation_id: 'wrong-native-id', status: 'SUCCESS', response: 'must not be accepted' } });
    return;
  }
  const config = path.join(process.cwd(), '.agents', 'mcp_config.json');
  const text = content.includes('FIXTURE_INSPECT') ? JSON.stringify({
    pid: process.pid, args, nativeId, cwd: process.cwd(),
    mcp: fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : null,
    hasCapability: !!process.env.KEEPWORK_AICHAT_CAPABILITY,
  }) : '中文😀';
  if (!content.includes('FIXTURE_RESULT_ONLY')) {
    send({ event: 'step_update', step_update: { conversation_id: nativeId,
      step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: text } });
    send({ event: 'step_update', step_update: { conversation_id: nativeId,
      step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file',
      tool_info: { parameters: { path: 'fixture.txt' }, output: 'read result' } } });
  }
  const status = content.includes('FIXTURE_NATIVE_CANCELED') ? 'CANCELED'
    : content.includes('FIXTURE_NATIVE_INTERRUPTED') ? 'INTERRUPTED' : 'SUCCESS';
  send({ event: 'result', result: { conversation_id: nativeId, status, response: text,
    ...(content.includes('FIXTURE_DENIED') ? { denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }] } : {}) } });
});
