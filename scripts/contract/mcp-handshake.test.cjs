const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness.cjs');

let rust;

before(async () => {
  rust = await h.startRust();
});

after(async () => {
  await rust?.stop();
});

test('initialize returns the Node handshake with a session id', async () => {
  const { response, text, session } = await h.mcpInitialize(rust.base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.match(session, /^[0-9a-f-]{36}$/);
  const body = JSON.parse(text);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.deepEqual(body.result.capabilities, {
    tools: { listChanged: true },
    resources: { listChanged: true },
    experimental: { 'keepwork/events': { version: 1, presence: 'mcp-v1' } },
  });
  assert.deepEqual(body.result.serverInfo, { name: 'keepwork-mcp', version: '0.1.2' });
});

test('streamed-reply clients get an SSE frame for initialize', async () => {
  const { response, text } = await h.mcpInitialize(rust.base, { streamed: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  const frames = h.parseSse(text);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'message');
  assert.equal(frames[0].data.result.serverInfo.name, 'keepwork-mcp');
});

test('tools/list advertises mcp_status with the exact Node schema', async () => {
  const { session } = await h.mcpInitialize(rust.base);
  const { text } = await h.mcpRequest(rust.base, session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ['result', 'jsonrpc', 'id']);
  const status = body.result.tools.find((tool) => tool.name === 'mcp_status');
  assert.deepEqual(status, {
    name: 'mcp_status',
    description: 'Report Keepwork local MCP daemon status: workspace root, port, ripgrep availability.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    },
    execution: { taskSupport: 'forbidden' },
  });
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name),
    ['mcp_status', 'run_terminal', 'grep_files', 'web_search', 'fetch_url'],
  );
});

test('the mcp_status tool output matches Node line for line', async () => {
  const { session } = await h.mcpInitialize(rust.base);
  const { text } = await h.mcpRequest(rust.base, session, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'mcp_status', arguments: {} },
  });
  const body = JSON.parse(text);
  assert.equal(body.result.isError, false);
  const toolText = body.result.content[0].text;
  const lines = toolText.split('\n');
  assert.equal(lines[0], '# Keepwork local MCP');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '- name: keepwork-mcp 0.1.2');
  assert.equal(lines[3], `- port: ${rust.port}`);
  assert.equal(lines[4], `- pid: ${rust.health.pid}`);
  assert.match(lines[5], /^- hostname: /);
  assert.equal(lines[6], `- workspaceRoot: ${rust.health.workspaceRoot}`);
  assert.equal(lines[7], '- terminal: spawn');
  assert.match(lines[8], /^- startedAt: /);
  assert.match(lines[9], /^- ripgrep: (yes|no \(Node walker fallback\))$/);
  assert.equal(lines[10], '- requireAuth: no');
  assert.equal(lines[11], '');
  assert.equal(lines[12], 'Tools: run_terminal, grep_files, mcp_status, web_search, fetch_url');
});

test('the mcp_status schema is byte-identical to the Node daemon', async () => {
  const node = await h.startNode();
  if (!node) return;
  try {
    const rustInit = await h.mcpInitialize(rust.base);
    const nodeInit = await h.mcpInitialize(node.base);
    const rustList = JSON.parse((await h.mcpRequest(rust.base, rustInit.session, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).text);
    const nodeList = JSON.parse((await h.mcpRequest(node.base, nodeInit.session, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).text);
    const pick = (value) => value.result.tools.find((tool) => tool.name === 'mcp_status');
    assert.deepEqual(pick(rustList), pick(nodeList));
    // Documented divergence: the Rust build only lists what it implements.
    assert.equal(nodeList.result.tools.length, 13);
    assert.equal(rustList.result.tools.length, 5);
  } finally {
    await node.stop();
  }
});

test('unknown tools answer as a tool error, not a JSON-RPC error', async () => {
  const { session } = await h.mcpInitialize(rust.base);
  const { response, text } = await h.mcpRequest(rust.base, session, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, 'MCP error -32602: Tool nope not found');
});

test('notifications are accepted and a duplicate GET stream is rejected', async () => {
  const { session } = await h.mcpInitialize(rust.base);
  const initialized = await h.mcpRequest(rust.base, session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.response.status, 202);

  const controller = new AbortController();
  const stream = await fetch(`${rust.base}/mcp`, {
    headers: { accept: 'text/event-stream', 'mcp-session-id': session },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');

  const duplicate = await fetch(`${rust.base}/mcp`, {
    headers: { accept: 'text/event-stream', 'mcp-session-id': session },
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'MCP stream already open' });
  controller.abort();

  const deleted = await fetch(`${rust.base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': session } });
  assert.equal(deleted.status, 200);
});
