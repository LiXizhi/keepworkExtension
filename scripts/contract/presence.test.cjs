const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness.cjs');

let rust, node;

before(async () => {
  rust = await h.startRust();
  node = await h.startNode();
});

after(async () => {
  await rust?.stop();
  await node?.stop();
});

async function both(fn) {
  const rustResult = await fn(rust);
  if (node) {
    const nodeResult = await fn(node);
    assert.deepEqual(rustResult, nodeResult, 'Rust behavior must match Node');
  }
  return rustResult;
}

async function createMcpSession(engine) {
  const res = await fetch(`${engine.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'presence-test', version: '1' },
      },
    }),
  });
  return res.headers.get('mcp-session-id');
}

test('presence POST endpoint enforces origin, session, method and body contract', async () => {
  const result = await both(async (engine) => {
    const sessionId = await createMcpSession(engine);
    const validHeaders = {
      Origin: 'https://keepwork.com',
      'Mcp-Session-Id': sessionId,
      'Content-Type': 'application/json',
    };
    const validBody = JSON.stringify({
      url: 'https://keepwork.com/chat?token=secret123&layout=thin',
      token: 'jwt-fixture-token',
    });

    // 1. Success case
    const okRes = await fetch(`${engine.base}/aichat/presence`, {
      method: 'POST',
      headers: validHeaders,
      body: validBody,
    });
    const okJson = await okRes.json();

    // 2. Disallowed Origin
    const badOriginRes = await fetch(`${engine.base}/aichat/presence`, {
      method: 'POST',
      headers: { ...validHeaders, Origin: 'https://evil.example' },
      body: validBody,
    });

    // 3. Missing/dead session
    const deadSessionRes = await fetch(`${engine.base}/aichat/presence`, {
      method: 'POST',
      headers: { ...validHeaders, 'Mcp-Session-Id': 'nonexistent-session' },
      body: validBody,
    });

    // 4. Method not allowed
    const getRes = await fetch(`${engine.base}/aichat/presence`, {
      method: 'GET',
      headers: validHeaders,
    });

    // 5. Invalid body
    const badBodyRes = await fetch(`${engine.base}/aichat/presence`, {
      method: 'POST',
      headers: validHeaders,
      body: '{}',
    });

    return {
      okStatus: okRes.status,
      okRemembered: okJson.remembered,
      badOriginStatus: badOriginRes.status,
      deadSessionStatus: deadSessionRes.status,
      getMethodStatus: getRes.status,
      badBodyStatus: badBodyRes.status,
    };
  });

  assert.deepEqual(result, {
    okStatus: 200,
    okRemembered: true,
    badOriginStatus: 403,
    deadSessionStatus: 401,
    getMethodStatus: 405,
    badBodyStatus: 400,
  });
});

test('presence SSE stream yields initial ready event and event-stream content-type', async () => {
  const result = await both(async (engine) => {
    const sessionId = await createMcpSession(engine);
    const controller = new AbortController();
    const streamRes = await fetch(`${engine.base}/aichat/presence?stream=1`, {
      method: 'POST',
      headers: {
        Origin: 'https://keepwork.com',
        'Mcp-Session-Id': sessionId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://keepwork.com/chat?layout=thin',
        token: 'jwt-fixture-token',
      }),
      signal: controller.signal,
    });

    const contentType = streamRes.headers.get('content-type');
    const reader = streamRes.body.getReader();
    const firstChunk = await reader.read();
    await reader.cancel();
    controller.abort();

    const decoded = new TextDecoder().decode(firstChunk.value);
    return {
      status: streamRes.status,
      contentType: contentType ? contentType.split(';')[0].trim() : null,
      readyEvent: decoded,
    };
  });

  assert.deepEqual(result, {
    status: 200,
    contentType: 'text/event-stream',
    readyEvent: 'event: ready\ndata: {}\n\n',
  });
});

test('keepwork/presence MCP JSON-RPC method succeeds on valid origin and live session', async () => {
  const result = await both(async (engine) => {
    const sessionId = await createMcpSession(engine);

    // Call keepwork/presence
    const res = await fetch(`${engine.base}/mcp`, {
      method: 'POST',
      headers: {
        Origin: 'https://keepwork.com',
        'Mcp-Session-Id': sessionId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'keepwork/presence',
        params: {
          url: 'https://keepwork.com/chat',
          token: 'mcp-fixture-token',
        },
      }),
    });
    const data = await res.json();
    return {
      status: res.status,
      result: data.result,
      id: data.id,
    };
  });

  assert.deepEqual(result, {
    status: 200,
    result: { remembered: true },
    id: 42,
  });
});
