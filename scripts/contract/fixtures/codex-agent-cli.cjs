#!/usr/bin/env node
// Private App Server fixture: no provider, credentials, filesystem tools or network.
const readline = require('node:readline');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const threads = new Map(), active = new Map(), approvals = new Map();
const nativeCursor = 'fixture-page:2/+?';
const nativeRoot = process.env.KEEPWORK_MCP_ROOT || process.cwd();
const nativeState = process.env.KEEPWORK_AGENT_FIXTURE_LOG && process.env.KEEPWORK_AGENT_FIXTURE_LOG + '.native-state.json';
function readNativeState() { return nativeState && fs.existsSync(nativeState) ? JSON.parse(fs.readFileSync(nativeState, 'utf8')) : {}; }
function nativeThread(id) {
  const state = readNativeState();
  const thread = state.threads?.[id] || threads.get(id);
  return id === 'native-fixture-active' && state.busy === false ? { ...thread, status: { type: 'idle' } } : thread;
}
function saveNativeThread(threadId) {
  if (!nativeState || !threadId.startsWith('native-fixture-')) return;
  const state = readNativeState();
  state.threads = { ...state.threads, [threadId]: threads.get(threadId) };
  fs.writeFileSync(nativeState, JSON.stringify(state));
}
for (const [id, fields] of [
  ['native-fixture-one', { name: 'Terminal fixture task', updatedAt: 123, status: { type: 'idle' }, futureMetadata: { version: 2 } }],
  ['native-fixture-optional', {}],
  ['native-fixture-active', { preview: 'Busy editor fixture', status: { type: 'active' } }],
  ['native-fixture-two', { preview: 'Second page fixture', updatedAt: 456 }],
]) {
  threads.set(id, { id, cwd: nativeRoot, ...fields, turns: id === 'native-fixture-optional' ? [] : [{
    id: 'original-' + id, status: 'completed', items: [
      { id: id + '-user', type: 'userMessage', content: [{ type: 'text', text: 'Original native CLI question' }] },
      { id: id + '-answer', type: 'agentMessage', text: 'Original native CLI answer', futureItemField: true },
    ],
  }] });
}
function log(value) {
  if (process.env.KEEPWORK_AGENT_FIXTURE_LOG) fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify(value) + '\n');
}
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function reply(id, result) { send({ id, result }); }
function notice(method, params) { send({ method, params }); }
function complete(threadId, status = 'completed') {
  const turn = active.get(threadId);
  if (!turn) return;
  active.delete(threadId); clearTimeout(turn.timer);
  turn.record.status = status;
  if (threads.has(threadId)) threads.get(threadId).status = { type: 'idle' };
  saveNativeThread(threadId);
  notice('turn/completed', { threadId, turn: { id: turn.id, status } });
}
function answer(threadId, text) {
  const item = { id: randomUUID(), type: 'agentMessage', text: '' };
  notice('item/started', { threadId, item });
  notice('item/agentMessage/delta', { threadId, itemId: item.id, delta: text });
  active.get(threadId)?.record.items.push({ ...item, text });
  notice('item/completed', { threadId, item: { ...item, text } });
  complete(threadId);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line), { method, params = {}, id } = message;
  log({ pid: process.pid, method, params, id });
  if (!method && approvals.has(id)) {
    const threadId = approvals.get(id); approvals.delete(id);
    answer(threadId, message.result?.decision === 'accept' ? 'codex:allowed' : 'codex:denied');
    return;
  }
  if (method === 'initialize') return reply(id, { userAgent: 'keepwork-codex-contract/1' });
  if (method === 'initialized') return;
  if (method === 'account/read') return reply(id, { account: { type: 'chatgpt', email: 'fixture@example.invalid' }, requiresOpenaiAuth: true });
  if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-codex', displayName: 'Codex fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Native fixture effort' }], defaultReasoningEffort: 'high' }] });
  if (method === 'config/read') return reply(id, { config: { sandbox_mode: 'read-only', approval_policy: 'on-request' } });
  if (method === 'collaborationMode/list') return reply(id, { data: [{ mode: 'default', model: 'fixture-codex' }, { mode: 'plan', model: 'fixture-codex' }] });
  if (method === 'thread/list') {
    if (params.cursor && params.cursor !== nativeCursor) return send({ id, error: { code: -32602, message: 'Invalid fixture cursor' } });
    const ids = params.cursor ? ['native-fixture-two'] : ['native-fixture-one', 'native-fixture-optional', 'native-fixture-active'];
    return reply(id, { data: ids.map((key) => { const { turns, ...thread } = nativeThread(key); return thread; }), nextCursor: params.cursor ? null : nativeCursor, futureResponseField: true });
  }
  if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: params.cwd, turns: [] }; threads.set(thread.id, thread);
    return reply(id, { thread });
  }
  if (method === 'thread/read' && params.threadId?.startsWith('legacy-history-')) {
    if (params.includeTurns !== true) return send({ id, error: { code: -32602, message: 'Legacy history requires includeTurns' } });
    if (params.threadId === 'legacy-history-failure') return send({ id, error: { code: -32603, message: 'Native fixture history unavailable' } });
    if (params.threadId === 'legacy-history-unsupported') return send({ id, error: { code: -32601, message: 'Native fixture thread/read unsupported' } });
    if (params.threadId === 'legacy-history-invalid') return reply(id, { thread: { id: params.threadId, turns: [{ items: 'malformed history' }] } });
    return reply(id, { thread: { id: params.threadId, cwd: process.cwd(), ...(params.threadId === 'legacy-history-native-busy' ? { status: { type: 'active' } } : {}), turns: [{
      id: 'legacy-native-turn', status: 'completed', items: [
        { id: 'legacy-user', type: 'userMessage', content: [{ type: 'text', text: 'Legacy question' }] },
        { id: 'legacy-answer', type: 'agentMessage', text: 'Legacy Codex restored answer' },
      ],
    }] } });
  }
  if (method === 'thread/read' && params.threadId?.startsWith('native-fixture-')) {
    if (params.includeTurns !== true) return send({ id, error: { code: -32602, message: 'Native history requires includeTurns' } });
    if (params.threadId === 'native-fixture-failure') return send({ id, error: { code: -32603, message: 'Native fixture history unavailable' } });
    if (params.threadId === 'native-fixture-invalid') return reply(id, { thread: { id: params.threadId, cwd: nativeRoot, turns: [{ items: 'malformed history' }] } });
    if (params.threadId === 'native-fixture-mismatch') return reply(id, { thread: { id: 'another-native-thread', cwd: nativeRoot, turns: [] } });
    if (params.threadId === 'native-fixture-missing-root') return reply(id, { thread: { id: params.threadId, cwd: nativeRoot + '/missing-native-root', turns: [] } });
    if (!threads.has(params.threadId)) return send({ id, error: { code: -32602, message: 'Native fixture thread unavailable' } });
    return reply(id, { thread: nativeThread(params.threadId), futureResponseField: true });
  }
  if (method === 'thread/resume' && params.threadId?.startsWith('native-fixture-')) threads.set(params.threadId, nativeThread(params.threadId));
  if (method === 'thread/resume' || method === 'thread/read') return reply(id, { thread: threads.get(params.threadId) || { id: params.threadId, turns: [] } });
  if (method === 'turn/start') {
    const text = (params.input || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (text.includes('FIXTURE_REJECT')) return send({ id, error: { code: -32602, message: 'Fixture policy rejected this prompt' } });
    if (text.includes('FIXTURE_EXIT')) return process.exit(17);
    const turnId = randomUUID();
    const record = { id: turnId, status: 'inProgress', items: [] };
    const thread = threads.get(params.threadId);
    if (thread) { thread.turns.push(record); thread.status = { type: 'active' }; }
    const turn = { id: turnId, timer: null, record }; active.set(params.threadId, turn);
    saveNativeThread(params.threadId);
    reply(id, { turn: { id: turn.id, status: 'inProgress' } });
    setImmediate(() => {
      notice('turn/started', { threadId: params.threadId, turn: { id: turn.id } });
      const userItem = { id: randomUUID(), type: 'userMessage', content: params.input };
      record.items.push(userItem);
      saveNativeThread(params.threadId);
      notice('item/completed', { threadId: params.threadId, item: userItem });
      if (text.includes('FIXTURE_PERMISSION') || text.includes('FIXTURE_UNOFFERED_PERMISSION')) {
        const requestId = randomUUID(); approvals.set(requestId, params.threadId);
        return send({ id: requestId, method: 'item/commandExecution/requestApproval', params: {
          threadId: params.threadId, turnId: turn.id, command: 'write fixture file',
          ...(text.includes('FIXTURE_UNOFFERED_PERMISSION') ? { availableDecisions: ['decline'] } : {}),
        } });
      }
      if (text.includes('FIXTURE_SLOW')) return;
      turn.timer = setTimeout(() => answer(params.threadId, '中文 codex fixture answer'), 40);
    });
    return;
  }
  if (method === 'turn/interrupt') { complete(params.threadId, 'interrupted'); return reply(id, {}); }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Fixture method unsupported: ' + method } });
}).on('close', () => { for (const turn of active.values()) clearTimeout(turn.timer); process.exit(0); });
