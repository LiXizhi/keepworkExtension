const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

let rust;

before(async () => {
  rust = await h.startRust();
});

after(async () => {
  await rust?.stop();
});

test('preflight answers 204 with the shared CORS header set', async () => {
  const response = await fetch(`${rust.base}/health`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  assert.equal(
    response.headers.get('access-control-allow-headers'),
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Agent-Owner, X-DashScope-Api-Key'
  );
  assert.equal(response.headers.get('access-control-expose-headers'), 'Mcp-Session-Id, MCP-Protocol-Version, Retry-After');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('allowed origins are echoed, unknown origins get no CORS grant', async () => {
  const allowed = await fetch(`${rust.base}/health`, { headers: { origin: 'https://keepwork.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://keepwork.com');
  assert.equal(allowed.headers.get('vary'), 'Origin');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

  const loopback = await fetch(`${rust.base}/health`, { headers: { origin: 'http://127.0.0.1:3001' } });
  assert.equal(loopback.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3001');
});

test('the MCP endpoint rejects untrusted origins before auth', async () => {
  const response = await fetch(`${rust.base}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'origin not allowed' });
});

test('require-auth guards /mcp and /admin but leaves /health open', async () => {
  const guarded = await h.startRust({ requireAuth: true });
  try {
    const token = fs.readFileSync(path.join(guarded.home, '.keepwork-mcp', 'token'), 'utf8').trim();
    assert.ok(token.length >= 32);

    assert.equal((await fetch(`${guarded.base}/health`)).status, 200);

    const denied = await fetch(`${guarded.base}/admin/status`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), {
      error: 'unauthorized',
      hint: 'Pass Authorization: Bearer <token> from ~/.keepwork-mcp/token',
    });

    const allowed = await fetch(`${guarded.base}/admin/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(allowed.status, 200);

    const noToken = await fetch(`${guarded.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }),
    });
    assert.equal(noToken.status, 401);

    const viaQuery = await fetch(`${guarded.base}/mcp?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }),
    });
    assert.equal(viaQuery.status, 200);
  } finally {
    await guarded.stop();
  }
});
