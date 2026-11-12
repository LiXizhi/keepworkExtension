#!/usr/bin/env node
/** Prompt-free metadata and execution fixture; never reads provider credentials. */
const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const accountFlash = JSON.stringify(['deepseek-account', 'deepseek-flash']);
const accountPro = JSON.stringify(['deepseek-account', 'deepseek-pro']);
const apiFlash = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
const models = [accountFlash, accountPro, apiFlash];
const sessions = new Map();
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => send({ id, result });
function configOptions(sessionId) {
  return [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: sessions.get(sessionId), options: [
    { group: 'account', name: 'DeepSeek account', options: [
      { value: accountFlash, name: 'Flash' }, { value: accountPro, name: 'Pro' },
    ] },
    { group: 'api', name: 'Official API', options: [{ value: apiFlash, name: 'Flash' }] },
  ] }];
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({ ...message, fixture: 'deepseek-models', pid: process.pid }) + '\n');
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, {
    protocolVersion: 1, agentInfo: { name: 'deepseek-model-fixture', version: '1' },
    agentCapabilities: {}, authMethods: [],
  });
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, apiFlash);
    return reply(id, { sessionId, configOptions: configOptions(sessionId) });
  }
  if (method === 'session/set_config_option') {
    if (params.configId !== 'model' || !models.includes(params.value)) {
      return send({ id, error: { code: -32602, message: 'Unknown native model' } });
    }
    sessions.set(params.sessionId, params.value);
    return reply(id, { configOptions: configOptions(params.sessionId) });
  }
  if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture answer' },
    } } });
    return reply(id, { stopReason: 'end_turn' });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported fixture method: ' + method } });
}).on('close', () => process.exit(0));
