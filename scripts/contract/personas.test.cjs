const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

let rust;
const owner = 'a'.repeat(32);

before(async () => {
  rust = await h.startRust();
});

after(async () => {
  await rust?.stop();
});

function headers(extra = {}) {
  return {
    origin: `http://127.0.0.1:${rust.port}`,
    'x-agent-owner': owner,
    ...extra,
  };
}

async function persona(method, route, body) {
  const response = await fetch(`${rust.base}/agents/personas${route}`, {
    method,
    headers: headers(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: response.status, json, headers: response.headers };
}

test('personas api lists, runs without login, and persists', async () => {
  const health = await (await fetch(`${rust.base}/health`)).json();
  assert.equal(health.personasApi, 'personas-v1');
  assert.equal(health.messagingApi, 'messaging-v1');
  assert.equal(health.agentSessionApi, undefined);

  const missingOrigin = await fetch(`${rust.base}/agents/personas`, {
    headers: { 'x-agent-owner': owner },
  });
  assert.equal(missingOrigin.status, 403);

  const missingOwner = await fetch(`${rust.base}/agents/personas`, {
    headers: { origin: `http://127.0.0.1:${rust.port}` },
  });
  assert.equal(missingOwner.status, 400);
  assert.equal((await missingOwner.json()).error, 'Agent owner key required');

  const created = await persona('POST', '', {
    id: 'default-persona',
    name: '我的分身',
    avatar: '🧠',
    prompt: '你是我的长期分身。',
    executor: 'auto',
    model: '',
    pinned: true,
    order: 0,
    root: '',
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.name, '我的分身');
  assert.equal(created.json.owner, undefined);
  assert.equal(created.json.wechatStatus, '未绑定');

  const listed = await persona('GET', '');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.agents.length, 1);
  assert.equal(listed.json.agents[0].id, 'default-persona');

  const badMode = await persona('POST', '/default-persona/messages', {
    requestId: 'm-bad',
    text: 'hello',
    contextMode: 'nope',
  });
  assert.equal(badMode.status, 422);
  assert.equal(badMode.json.code, 'UNSUPPORTED_FEATURE');

  const queued = await persona('POST', '/default-persona/messages', {
    requestId: 'm1',
    text: 'hello',
    contextMode: 'conversation',
    ownerComposer: true,
  });
  assert.equal(queued.status, 200);
  assert.equal(queued.json.job.state, 'queued');

  let detail;
  const deadline = Date.now() + 2000;
  do {
    detail = await persona('GET', '/default-persona');
    if (detail.json.job?.state === 'needs-login') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(detail.json.job.state, 'needs-login');
  assert.equal(detail.json.messages.length, 1);

  const again = await persona('POST', '/default-persona/messages', {
    requestId: 'm1',
    text: 'hello again',
    contextMode: 'conversation',
  });
  assert.equal(again.status, 200);
  detail = await persona('GET', '/default-persona');
  assert.equal(detail.json.messages.filter((message) => message.role === 'user').length, 1);

  const cleared = await persona('POST', '/default-persona/clear', {});
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.messages.length, 0);

  const scheduled = await persona('POST', '/default-persona/schedules', {
    id: 'morning',
    title: '晨间',
    prompt: '总结今天',
    time: '09:30',
    timezone: 'Asia/Shanghai',
    enabled: true,
  });
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.json.schedules.length, 1);
  assert.equal(scheduled.json.schedules[0].time, '09:30');

  const external = await persona('POST', '/default-persona/schedules', {
    id: 'out',
    prompt: 'hi',
    time: '09:30',
    timezone: 'UTC',
    enabled: true,
    target: { binding: 'x', conversation: 'y' },
  });
  assert.equal(external.status, 400);

  const admin = await (await fetch(`${rust.base}/admin/personas`)).json();
  assert.equal(admin.personas.some((row) => row.name === '我的分身'), true);
  assert.equal(admin.stats.total >= 1, true);

  const html = await (await fetch(`${rust.base}/dashboard`)).text();
  assert.match(html, /分身/);
  assert.match(html, /id="view-chat"/);

  const events = await fetch(`${rust.base}/agents/personas/events`, { headers: headers() });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /event: changed/);
  await reader.cancel();

  const dir = path.join(rust.home, '.keepwork-mcp', 'personas-v1');
  const files = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(saved.name, '我的分身');
  assert.equal(saved.id, 'default-persona');
});
