#!/usr/bin/env node
/** Deterministic native ACP peer. Never contacts a provider or reads real accounts. */
const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function log(event, data = {}) {
  if (process.env.KEEPWORK_AGENT_FIXTURE_LOG) {
    fs.appendFileSync(process.env.KEEPWORK_AGENT_FIXTURE_LOG, JSON.stringify({ event, pid: process.pid, ...data }) + '\n');
  }
}
log('start', { args: process.argv.slice(2) });
if (process.argv.includes('--version')) {
  process.stdout.write('agent-cli-fixture 1.0.0\n');
  process.exit(0);
}

const sessions = new Map();
const prompts = new Map();
const permissions = new Map();
const proxyChildren = new Set();
async function invokeContextTool(descriptor) {
  if (!descriptor) throw new Error('Context MCP descriptor missing');
  const extra = Array.isArray(descriptor.env)
    ? Object.fromEntries(descriptor.env.map((entry) => [entry.name, entry.value])) : descriptor.env || {};
  const proxy = spawn(descriptor.command, descriptor.args || [], {
    env: { ...process.env, ...extra }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  proxyChildren.add(proxy);
  const pending = new Map(); let sequence = 0;
  const lines = readline.createInterface({ input: proxy.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Context proxy timeout: ' + method)); }, 6000);
    pending.set(id, { resolve, reject, timer });
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ACP fixture', version: '1' } });
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await call('tools/list');
    if (!listed.tools?.some((tool) => tool.name === 'aichat_call_tool')) throw new Error('AIChat tool wrapper missing');
    return await call('tools/call', {
      name: 'aichat_call_tool', arguments: { name: 'fixture_echo', arguments: { text: 'bridge test' } },
    });
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    proxy.stdin.end(); proxy.kill(); proxyChildren.delete(proxy); lines.close();
  }
}
function send(value) {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  // Exercise UTF-8 decoding across pipe chunks as well as JSON line buffering.
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  if (split > 0) {
    process.stdout.write(bytes.subarray(0, split));
    process.stdout.write(bytes.subarray(split));
  } else process.stdout.write(bytes);
}
const reply = (id, result) => send({ id, result });
const metadata = (sessionId) => ({
  sessionId,
  models: {
    currentModelId: sessions.get(sessionId)?.model || 'fixture-model',
    availableModels: [
      { modelId: 'fixture-model', name: 'Fixture model' },
      { modelId: 'fixture-other', name: 'Other fixture model' },
      { modelId: 'fixture-delayed', name: 'Delayed configuration fixture model' },
    ],
  },
  modes: {
    currentModeId: sessions.get(sessionId)?.mode || 'default',
    availableModes: ['default', 'plan'].map((id) => ({ id, name: id })),
  },
});
function update(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } });
}
function text(sessionId, value) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
}
function finish(sessionId, stopReason = 'end_turn') {
  const prompt = prompts.get(sessionId);
  if (!prompt) return;
  clearTimeout(prompt.timer);
  prompts.delete(sessionId);
  reply(prompt.id, { stopReason });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log('message', message);
  const { id, method, params = {} } = message;
  if (!method && permissions.has(id)) {
    const sessionId = permissions.get(id);
    permissions.delete(id);
    const accepted = message.result?.outcome?.outcome === 'selected'
      && message.result.outcome.optionId === 'allow';
    text(sessionId, accepted ? 'permission:allowed' : 'permission:denied');
    return finish(sessionId);
  }
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: 1,
      agentInfo: { name: 'contract-fixture', version: '1.0.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      authMethods: [],
    });
  }
  if (method === 'session/new') {
    const sessionId = 'fixture-' + randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, model: 'fixture-model', mode: 'default', mcpServers: params.mcpServers });
    return reply(id, metadata(sessionId));
  }
  if (method === 'session/load') {
    sessions.set(params.sessionId, { cwd: params.cwd, model: 'fixture-model', mode: 'default', mcpServers: params.mcpServers });
    const replayFile = process.env.KEEPWORK_AGENT_FIXTURE_LOG && process.env.KEEPWORK_AGENT_FIXTURE_LOG + '.load-replay.json';
    const replay = replayFile && fs.existsSync(replayFile) && JSON.parse(fs.readFileSync(replayFile, 'utf8'))[params.sessionId];
    if (replay) {
      if (replay.metadata) {
        update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: [{
          id: 'restored-model-choice', category: 'model', type: 'select', currentValue: 'fixture-model',
          options: [{ value: 'fixture-model', name: 'Fixture model' }, { value: 'restored-model', name: 'Restored model' }],
        }] });
        update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
      }
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'HISTORY_USER' } });
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'HISTORY_THOUGHT' } });
      text(params.sessionId, 'HISTORY_GREETING');
      update(params.sessionId, {
        sessionUpdate: 'tool_call', toolCallId: 'history-tool', title: 'HISTORY_TOOL', kind: 'read',
        status: 'completed', rawOutput: { text: 'HISTORY_OUTPUT' },
      });
      if (replay.permission) send({
        id: 'history-permission-' + params.sessionId, method: 'session/request_permission',
        params: { sessionId: params.sessionId, toolCall: { toolCallId: 'history-permission', title: 'HISTORY_PERMISSION', kind: 'edit' },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject once' }] },
      });
      if (replay.peerSessionId) text(replay.peerSessionId, 'LIVE_DURING_RESTORE');
      // History precedes the load reply, as ACP peers do. Keep the load open
      // briefly so queued notifications and permission requests are exercised.
      return setTimeout(() => replay.fail
        ? send({ id, error: { code: -32603, message: 'Fixture history load failed' } })
        : reply(id, replay.metadata ? { sessionId: params.sessionId } : metadata(params.sessionId)), 60);
    }
    return reply(id, metadata(params.sessionId));
  }
  if (method === 'session/set_model') {
    if (!['fixture-model', 'fixture-other', 'fixture-delayed'].includes(params.modelId)) {
      return send({ id, error: { code: -32602, message: 'Unknown fixture model' } });
    }
    if (sessions.has(params.sessionId)) sessions.get(params.sessionId).model = params.modelId;
    if (params.modelId === 'fixture-delayed') return setTimeout(() => reply(id, {}), 300);
    return reply(id, {});
  }
  if (method === 'session/set_mode') {
    if (sessions.has(params.sessionId)) sessions.get(params.sessionId).mode = params.modeId;
    return reply(id, {});
  }
  if (method === 'session/prompt') {
    const value = (params.prompt || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (value.includes('FIXTURE_EXIT')) return process.exit(17);
    if (value.includes('FIXTURE_REJECT')) {
      return send({ id, error: { code: -32603, message: 'Fixture rejected prompt' } });
    }
    prompts.set(params.sessionId, { id });
    if (value.includes('FIXTURE_CONTEXT_TOOL')) {
      const descriptor = sessions.get(params.sessionId)?.mcpServers?.find((server) => server.name === 'keepwork_aichat');
      void invokeContextTool(descriptor).then((result) => {
        text(params.sessionId, JSON.stringify(result)); finish(params.sessionId);
      }, (error) => {
        text(params.sessionId, 'context-error:' + error.message); finish(params.sessionId);
      });
      return;
    }
    if (value.includes('FIXTURE_PERMISSION')) {
      const permissionId = 'permission-' + randomUUID();
      permissions.set(permissionId, params.sessionId);
      return send({
        id: permissionId,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'fixture-write', title: 'Write fixture file', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject once' },
          ],
        },
      });
    }
    text(params.sessionId, '中文 fixture ');
    if (value.includes('FIXTURE_SLOW')) return;
    prompts.get(params.sessionId).timer = setTimeout(() => {
      text(params.sessionId, 'answer');
      update(params.sessionId, {
        sessionUpdate: 'tool_call', toolCallId: 'fixture-read', title: 'Read fixture',
        kind: 'read', status: 'completed', rawInput: { path: 'fixture.txt' }, rawOutput: { text: 'fixture output' },
      });
      finish(params.sessionId);
    }, 60);
    return;
  }
  if (method === 'session/cancel') return finish(params.sessionId, 'cancelled');
  if (id !== undefined && method) send({ id, error: { code: -32601, message: 'Fixture method not supported: ' + method } });
}).on('close', () => {
  log('stdin-closed');
  for (const prompt of prompts.values()) clearTimeout(prompt.timer);
  for (const proxy of proxyChildren) proxy.kill();
  process.exit(0);
});
