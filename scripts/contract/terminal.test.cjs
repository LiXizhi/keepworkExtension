const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness.cjs');

let rust;
let node;
const engines = [];

async function json(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function both(run) {
  const results = [];
  for (const engine of engines) {
    results.push(await run(engine));
  }
  if (results.length === 2) {
    assert.deepEqual(results[0], results[1], 'Rust must match the Node reference');
  }
  return results[0];
}

async function waitForOutput(base, id, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let text = '';
  while (Date.now() < deadline) {
    const body = await json(`${base}/terminal/sessions/${id}/output?cursor=${cursor}`);
    cursor = body.body.cursor;
    text += body.body.output;
    if (text.includes(needle)) return { text, cursor };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`terminal output never contained ${needle}: ${JSON.stringify(text.slice(-400))}`);
}

before(async () => {
  rust = await h.startRust();
  node = await h.startNode();
  engines.push(...[rust, node].filter(Boolean));
});

after(async () => {
  await rust?.stop();
  await node?.stop();
});

test('terminal cross-engine comparisons have a built Node reference', h.nodeReferenceTestOptions(), () => assert.ok(node));

test('create returns a session snapshot', async () => {
  const result = await both(async (engine) => {
    const created = await json(`${engine.base}/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 120, rows: 40 }),
    });
    const id = created.body.id;
    await fetch(`${engine.base}/terminal/sessions/${id}`, { method: 'DELETE' });
    return {
      status: created.status,
      ok: created.body.ok,
      hasId: typeof id === 'string' && id.length > 10,
      cols: created.body.cols,
      rows: created.body.rows,
      closed: created.body.closed,
      running: created.body.runningCommand,
    };
  });
  assert.deepEqual(result, {
    status: 201,
    ok: true,
    hasId: true,
    cols: 120,
    rows: 40,
    closed: false,
    running: true,
  });
});

test('input echoes, cursor replays and resize applies', async () => {
  const result = await both(async (engine) => {
    const created = await json(`${engine.base}/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const id = created.body.id;
    const write = await json(`${engine.base}/terminal/sessions/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'echo terminal-ok\r' }),
    });
    const output = await waitForOutput(engine.base, id, 'terminal-ok');
    const replay = await json(`${engine.base}/terminal/sessions/${id}/output?cursor=0`);
    const resize = await json(`${engine.base}/terminal/sessions/${id}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 90, rows: 30 }),
    });
    const closed = await json(`${engine.base}/terminal/sessions/${id}`, { method: 'DELETE' });
    return {
      write: [write.status, write.body.accepted],
      found: output.text.includes('terminal-ok'),
      reset: replay.body.reset,
      replayFromZero: replay.body.output.includes('terminal-ok'),
      resize: [resize.status, resize.body.cols, resize.body.rows],
      close: [closed.status, closed.body.ok],
    };
  });
  assert.deepEqual(result, {
    write: [202, true],
    found: true,
    reset: false,
    replayFromZero: true,
    resize: [200, 90, 30],
    close: [200, true],
  });
});

test('commands run through the PTY and honour the deny-list', async () => {
  const result = await both(async (engine) => {
    const created = await json(`${engine.base}/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const id = created.body.id;
    const denied = await json(`${engine.base}/terminal/sessions/${id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'shutdown now' }),
    });
    const allowed = await json(`${engine.base}/terminal/sessions/${id}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo from-command' }),
    });
    const output = await waitForOutput(engine.base, id, 'from-command');
    await fetch(`${engine.base}/terminal/sessions/${id}`, { method: 'DELETE' });
    return {
      denied: [denied.status, denied.body.ok],
      allowed: [allowed.status, allowed.body.accepted],
      ran: output.text.includes('from-command'),
    };
  });
  assert.deepEqual(result, {
    denied: [400, false],
    allowed: [202, true],
    ran: true,
  });
});

test('cursors count UTF-16 units for CJK, emoji and partial escapes', async () => {
  const result = await both(async (engine) => {
    const created = await json(`${engine.base}/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const id = created.body.id;
    await json(`${engine.base}/terminal/sessions/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'echo 你好😀\\033' }),
    });
    await waitForOutput(engine.base, id, '你好');
    const replay = await json(`${engine.base}/terminal/sessions/${id}/output?cursor=0`);
    await fetch(`${engine.base}/terminal/sessions/${id}`, { method: 'DELETE' });
    return {
      // A cursor is a `string.length` offset, so emoji must weigh two units.
      cursorMatchesLength: replay.body.cursor === replay.body.output.length,
      hasCjk: replay.body.output.includes('你好'),
      hasEmoji: replay.body.output.includes('😀'),
    };
  });
  assert.deepEqual(result, {
    cursorMatchesLength: true,
    hasCjk: true,
    hasEmoji: true,
  });
});

test('a foreign owner cannot read another session', async () => {
  const result = await both(async (engine) => {
    const created = await fetch(`${engine.base}/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://keepwork.com' },
      body: '{}',
    }).then((response) => response.json());
    const id = created.id;
    const foreign = await json(`${engine.base}/terminal/sessions/${id}/output?cursor=0`, {
      headers: { origin: 'http://localhost:3001' },
    });
    await fetch(`${engine.base}/terminal/sessions/${id}`, {
      method: 'DELETE',
      headers: { origin: 'https://keepwork.com' },
    });
    return [foreign.status, foreign.body.ok, foreign.body.error];
  });
  assert.deepEqual(result, [404, false, 'terminal session not found']);
});

test('closed sessions answer 404 and unknown ids too', async () => {
  const result = await both(async (engine) => {
    const missing = await json(`${engine.base}/terminal/sessions/nope/output?cursor=0`);
    return [missing.status, missing.body.error];
  });
  assert.deepEqual(result, [404, 'terminal session not found']);
});
