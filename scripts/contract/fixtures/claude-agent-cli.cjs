#!/usr/bin/env node
// Private Claude stream-json fixture: no provider, credentials, tools or network.
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1)
  || (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const thread = option('--session-id') || option('--resume');
function log(value) {
  if (process.env.KEEPWORK_AGENT_FIXTURE_LOG) fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({ pid: process.pid, thread, ...value }) + '\n');
}
log({ type: 'launch', args, cwd: process.cwd() });
if (args.includes('--version')) { console.log('Claude fixture 1.0'); process.exit(0); }
if (args.includes('auth') && args.includes('status')) {
  const auth = process.env.KEEPWORK_CLAUDE_FIXTURE_AUTH || 'in';
  if (auth === 'unknown') { console.error('fixture auth status unavailable'); process.exit(2); }
  const loggedIn = auth === 'in';
  console.log(JSON.stringify({ loggedIn, email: loggedIn ? 'claude@example.invalid' : null,
    authMethod: 'oauth_token', accessToken: 'SECRET_CLAUDE_AUTH_TOKEN' }));
  process.exit(loggedIn ? 0 : 1);
}
const models = [
  { value: 'fixture-claude', displayName: 'Claude fixture', isDefault: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'fast', displayName: 'Fast fixture', supportsEffort: false },
];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const response = (request, result = {}) => send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: result } });
let sequence = 0, active = false, timer;
const approvals = new Map();
function finish(text = '中文😀 Claude fixture answer', error = false) {
  clearTimeout(timer); active = false;
  send({ type: 'assistant', message: { id: 'assistant-' + sequence, content: [{ type: 'text', text }] } });
  send({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, result: text, session_id: thread });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line); log({ type: 'message', message });
  if (message.type === 'control_request') {
    const subtype = message.request?.subtype;
    if (subtype === 'initialize') {
      response(message, { models });
      send({ type: 'system', subtype: 'init', session_id: thread });
    } else if (subtype === 'interrupt') {
      response(message);
      if (active) finish('Interrupted');
    } else response(message);
    return;
  }
  if (message.type === 'control_response') {
    const native = message.response;
    if (!approvals.delete(native?.request_id)) return;
    const outcome = native.response || {};
    return finish('permission:' + JSON.stringify(outcome), native.subtype === 'error' || outcome.behavior === 'deny');
  }
  if (message.type !== 'user') return;
  sequence++; active = true;
  const content = message.message?.content;
  const text = typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (text.includes('FIXTURE_EXIT')) return process.exit(17);
  if (text.includes('FIXTURE_SLOW')) return;
  if (text.includes('FIXTURE_FLOOD')) {
    for (let index = 0; index < 25; index++) send({ type: 'assistant', message: {
      id: 'flood-' + index, content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    } });
    return;
  }
  if (text.includes('FIXTURE_PERMISSION') || text.includes('FIXTURE_READ_PERMISSION') || text.includes('FIXTURE_QUESTION')) {
    const question = text.includes('FIXTURE_QUESTION');
    const requestId = 'permission-' + sequence;
    approvals.set(requestId, true);
    return send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool',
      tool_name: question ? 'AskUserQuestion' : text.includes('FIXTURE_READ_PERMISSION') ? 'Read' : 'Bash',
      input: question ? { questions: [{ question: 'Choose a color?', header: 'Color', options: [{ label: 'blue', description: 'Blue' }, { label: 'red', description: 'Red' }], multiSelect: false }] }
        : { command: 'write fixture.txt', file_path: 'fixture.txt', apiToken: 'SECRET_CLAUDE_TOOL_TOKEN' },
    } });
  }
  if (text.includes('FIXTURE_STREAM')) {
    const id = 'assistant-' + sequence;
    send({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    // Native finals may contain only the text block even when the partial stream
    // used index zero for thinking. Final index zero must reconcile text index one.
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture analysis' } } });
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '中文😀 Claude fixture answer' } } });
  }
  timer = setTimeout(() => finish(), 30);
}).on('close', () => { clearTimeout(timer); process.exit(0); });
