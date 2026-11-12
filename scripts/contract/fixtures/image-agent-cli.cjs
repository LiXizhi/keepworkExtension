#!/usr/bin/env node
// Private ACP raster fixture; no accounts, tools, inference or external network.
const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => send({ id, result });
const metadata = (sessionId) => ({ sessionId, models: {
  currentModelId: 'fixture-image-model',
  availableModels: [{ modelId: 'fixture-image-model', name: 'Image fixture' }],
} });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({ ...message, pid: process.pid }) + '\n');
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    const image = process.env.KEEPWORK_AGENT_IMAGE_FIXTURE_CAPABILITY;
    return reply(id, { protocolVersion: 1, agentInfo: { name: 'image-fixture', version: '1' },
      agentCapabilities: { loadSession: true, ...(image === 'missing' ? {} : { promptCapabilities: { image: image !== 'false' } }) }, authMethods: [] });
  }
  if (method === 'session/new') return reply(id, metadata(randomUUID()));
  if (method === 'session/load') return reply(id, metadata(params.sessionId));
  if (method === 'session/set_mode' || method === 'session/set_model') return reply(id, {});
  if (method === 'session/prompt') {
    for (const content of params.prompt || []) {
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
        sessionUpdate: 'user_message_chunk', content,
      } } });
    }
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Image fixture answer' },
    } } });
    return reply(id, { stopReason: 'end_turn' });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported image fixture method: ' + method } });
}).on('close', () => process.exit(0));
