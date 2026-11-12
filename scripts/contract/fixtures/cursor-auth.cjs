#!/usr/bin/env node
// Isolated Cursor-like ACP peer: native login is read once at process startup.
// Only test-owned marker files are read. No real credentials or provider calls.
const fs = require('node:fs');
const readline = require('node:readline');

const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const signedIn = read(process.env.KEEPWORK_CURSOR_AUTH_FIXTURE_STATE) === 'signed-in';
const sessions = new Map();
let sequence = 0;
function log(value) {
  fs.appendFileSync(process.env.KEEPWORK_CURSOR_AUTH_FIXTURE_LOG,
    JSON.stringify({ pid: process.pid, ...value }) + '\n');
}
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
const reply = (id, result) => send({ id, result });
const reject = (id, message) => send({ id, error: { code: -32000, message } });
log({ event: 'start', signedIn, args: process.argv.slice(2) });

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  log({ event: 'message', ...message });
  if (method === 'initialize') return reply(id, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [{ id: 'cursor_login', name: 'Cursor login' }],
  });
  if (method === 'authenticate') return reject(id, 'Fixture forbids automatic browser authorization');
  if (method === 'session/new') {
    const failure = read(process.env.KEEPWORK_CURSOR_AUTH_FIXTURE_FAILURE);
    if (failure === 'network') return reject(id, 'Connection temporarily unavailable');
    if (failure === 'auth' || !signedIn) return reject(id, 'Authentication required');
    const sessionId = 'cursor-auth-' + ++sequence;
    sessions.set(sessionId, {});
    return reply(id, {
      sessionId,
      models: { currentModelId: 'fixture-cursor', availableModels: [{ modelId: 'fixture-cursor', name: 'Fixture Cursor model' }] },
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Agent' }] },
    });
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId);
    if (!session) return reject(id, 'Unknown fixture session');
    session.prompt = id;
    send({ method: 'session/update', params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture running' } },
    } });
    if (!params.prompt.some(item => item.text?.includes('HOLD'))) return reply(id, { stopReason: 'end_turn' });
    return;
  }
  if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId);
    if (session?.prompt !== undefined) reply(session.prompt, { stopReason: 'cancelled' });
    return;
  }
  if (method === 'session/set_mode' || method === 'session/load') return reply(id, {});
  if (id !== undefined) reject(id, 'Unsupported fixture method');
});
