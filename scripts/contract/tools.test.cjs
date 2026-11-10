const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

let rust;
let node;
const engines = [];

const PORTABLE_TOOLS = ['mcp_status', 'run_terminal', 'grep_files', 'web_search', 'fetch_url'];

async function session(engine) {
  const init = await h.mcpInitialize(engine.base);
  assert.ok(init.session, 'initialize must return a session id');
  return init.session;
}

async function callTool(engine, tool, args) {
  const id = await session(engine);
  const { text } = await h.mcpRequest(engine.base, id, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  return JSON.parse(text).result;
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

before(async () => {
  rust = await h.startRust();
  node = await h.startNode();
  engines.push(...[rust, node].filter(Boolean));
  for (const engine of engines) {
    engine.work = path.join(engine.home, 'work');
    fs.mkdirSync(engine.work, { recursive: true });
    fs.writeFileSync(path.join(engine.work, 'seed.txt'), 'alpha needle omega');
  }
});

after(async () => {
  await rust?.stop();
  await node?.stop();
});

test('tools/list exposes the portable tools with Node-identical schemas', async () => {
  const result = await both(async (engine) => {
    const id = await session(engine);
    const { text } = await h.mcpRequest(engine.base, id, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = JSON.parse(text).result.tools;
    const portable = tools.filter((tool) => PORTABLE_TOOLS.includes(tool.name));
    return {
      names: portable.map((tool) => tool.name),
      schemas: Object.fromEntries(portable.map((tool) => [tool.name, tool.inputSchema])),
    };
  });
  assert.deepEqual(result.names, PORTABLE_TOOLS);
  assert.deepEqual(result.schemas.run_terminal.required, ['command']);
  assert.deepEqual(result.schemas.grep_files.required, ['pattern']);
});

test('mcp_status still reports the same header lines', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'mcp_status', {});
    const text = tool.content[0].text;
    return {
      isError: tool.isError,
      lines: text.split('\n').filter((line) => /^- (name|port|requireAuth|ripgrep|terminal):/.test(line)).length,
      hasRoot: text.includes('workspaceRoot:'),
    };
  });
  assert.deepEqual(result, { isError: false, lines: 5, hasRoot: true });
});

test('run_terminal executes and formats like Node', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'run_terminal', {
      command: 'echo tool-ok',
      cwd: engine.work,
    });
    const text = tool.content[0].text;
    return {
      isError: tool.isError,
      startsWithCwd: text.startsWith('cwd: '),
      hasVia: text.includes('via: spawn'),
      hasOutput: text.includes('tool-ok'),
      hasExitZero: text.includes('exit: 0'),
    };
  });
  assert.deepEqual(result, {
    isError: false,
    startsWithCwd: true,
    hasVia: true,
    hasOutput: true,
    hasExitZero: true,
  });
});

test('run_terminal reports failures as tool errors', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'run_terminal', { command: 'shutdown now' });
    return {
      isError: tool.isError,
      mentions: /deny-list/i.test(tool.content[0].text),
    };
  });
  assert.deepEqual(result, { isError: true, mentions: true });
});

test('grep_files finds matches with the same text shape', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'grep_files', {
      pattern: 'needle',
      path: engine.work,
    });
    const lines = tool.content[0].text.split('\n');
    const hit = lines.find((line) => line.includes('seed.txt'));
    return {
      isError: tool.isError,
      hitTail: hit ? hit.slice(hit.indexOf('seed.txt')) : null,
    };
  });
  assert.equal(result.isError, false);
  assert.equal(result.hitTail, 'seed.txt:1:alpha needle omega');
});

test('web_search rejects an empty query', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'web_search', { query: '' });
    return { isError: tool.isError, body: JSON.parse(tool.content[0].text) };
  });
  assert.deepEqual(result, {
    isError: true,
    body: { error: 'invalid', detail: 'query-required' },
  });
});

test('fetch_url blocks loopback targets', async () => {
  const result = await both(async (engine) => {
    const tool = await callTool(engine, 'fetch_url', { url: 'http://127.0.0.1:8089/health' });
    return { isError: tool.isError, body: JSON.parse(tool.content[0].text) };
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.body, { error: 'blocked', detail: 'private-ip' });
});

test('unknown tools answer with the SDK error text', async () => {
  // Node implements browser_session, so this can only be asserted on Rust.
  const tool = await callTool(rust, 'browser_session', { treeId: 'x', action: 'list' });
  assert.equal(tool.isError, true);
  assert.match(tool.content[0].text, /-32602/);
});
