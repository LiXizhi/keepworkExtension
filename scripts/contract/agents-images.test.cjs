const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

// Real loopback HTTP and native child stdio with isolated profiles. Provider
// fixtures verify transport contracts, without using real accounts or models.
const owner = 'image-contract-owner-'.padEnd(40, 'a');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const image = 'data:image/png;base64,' + png;
let directory, root, log, daemon;
function environment(logFile = log) {
  const missing = path.join(directory, 'absent-cli');
  const env = { KEEPWORK_MCP_ROOT: root, KEEPWORK_AGENT_FIXTURE_LOG: logFile };
  for (const backend of ['CODEX', 'WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CLAUDE', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) {
    env['KEEPWORK_' + backend + '_PATH'] = missing;
  }
  env.KEEPWORK_DEEPSEEK_PATH = path.join(__dirname, 'fixtures', 'image-agent-cli.cjs');
  env.KEEPWORK_CODEX_PATH = path.join(__dirname, 'fixtures', 'codex-agent-cli.cjs');
  env.KEEPWORK_CLAUDE_PATH = path.join(__dirname, 'fixtures', 'claude-agent-cli.cjs');
  return env;
}
function rows(file = log) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function promptRows(file = log) {
  return rows(file).filter((row) => row.method === 'session/prompt' || row.method === 'turn/start' || row.type === 'message' && row.message.type === 'user');
}
async function request(route, body, options = {}) {
  const peer = options.daemon || daemon;
  const response = await fetch(peer.base + '/agents' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: peer.base, 'x-agent-owner': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
async function create(backend, name, peer = daemon) {
  const result = await request('/sessions', { backend, conversationId: name, roots: [root] }, { daemon: peer });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function completed(session, peer = daemon) {
  const deadline = Date.now() + 5000;
  let result;
  do {
    result = await request('/sessions/' + session.id, undefined, { daemon: peer });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.body.status === 'completed') return result.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('Image session did not complete: ' + JSON.stringify(result.body));
}
function persistedText(peer = daemon) {
  return fs.readdirSync(peer.home, { recursive: true }).map((relative) => path.join(peer.home, relative))
    .filter((file) => fs.statSync(file).isFile() && file.endsWith('.json'))
    .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
before(async () => {
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-agent-images-')));
  root = path.join(directory, 'workspace'); fs.mkdirSync(root); log = path.join(directory, 'native.log');
  daemon = await h.startRust({ env: environment() });
});
after(async () => {
  await daemon?.stop();
  if (directory) await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('Rust advertises the existing clipboard image turn contract', async () => {
  const health = await (await fetch(daemon.base + '/health')).json();
  assert.equal(health.agentImageTurnApi, 'v1');
});

for (const backend of ['deepseek', 'codex', 'claude']) test(backend + ' sends raster parts once and stores only image placeholders', async () => {
  const session = await create(backend, 'images-' + backend);
  const count = promptRows().length;
  const input = { requestId: 'image-' + backend, text: 'Describe this picture', images: [image] };
  const result = await request(`/sessions/${session.id}/image-turns`, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const view = await completed(session);
  const dispatched = promptRows().slice(count);
  assert.equal(dispatched.length, 1);
  const part = backend === 'deepseek' ? dispatched[0].params.prompt[1]
    : backend === 'codex' ? dispatched[0].params.input[1] : dispatched[0].message.message.content[1];
  assert.deepEqual(part, backend === 'codex' ? { type: 'image', url: image }
    : backend === 'claude' ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
      : { type: 'image', mimeType: 'image/png', data: png });
  assert.ok(view.items.some((item) => item.type === 'userMessage' && item.content.some((part) => part.type === 'image')));
  assert.ok(!JSON.stringify(result.body).includes(png));
  assert.ok(!JSON.stringify(view).includes(png));
  assert.ok(!persistedText().includes(png), 'MCP registries and ACP sidecars must not retain inline image data');
  const repeated = await request(`/sessions/${session.id}/image-turns`, input);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(promptRows().length, count + 1, 'retrying a known request ID must not replay an image prompt');
  const text = await request(`/sessions/${session.id}/turns`, { requestId: 'plain-' + backend, text: 'Plain legacy follow-up' });
  assert.equal(text.status, 200, JSON.stringify(text.body));
  await completed(session);
});

test('legacy turns accept optional images and preserve four raster MIME types', async () => {
  const session = await create('deepseek', 'legacy-image-turn');
  const mimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const images = mimes.map((mime) => `data:${mime};base64,${png}`);
  const count = promptRows().length;
  const result = await request(`/sessions/${session.id}/turns`, { requestId: 'legacy-images', text: 'Four images', images });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const view = await completed(session);
  assert.deepEqual(promptRows().slice(count)[0].params.prompt.slice(1), mimes.map((mime) => ({ type: 'image', mimeType: mime, data: png })));
  assert.equal(view.items.filter((item) => item.type === 'userMessage').flatMap((item) => item.content).filter((part) => part.type === 'image').length, 4);
});

test('image validation rejects unsafe URLs, wrong shapes and aggregate oversize before native dispatch', async () => {
  const session = await create('deepseek', 'invalid-images');
  const oversized = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString('base64');
  const invalid = [undefined, null, [], 'not-an-array', [image, image, image, image, image],
    ['file:///private/image.png'], ['https://example.invalid/image.png'],
    ['data:image/svg+xml;base64,PHN2Zy8+'], ['data:image/png;base64,a==='],
    ['data:image/png;base64,!!!!'], ['data:image/png;base64,'], [1], [oversized, oversized]];
  const count = promptRows().length;
  for (let i = 0; i < invalid.length; i++) {
    const result = await request(`/sessions/${session.id}/image-turns`, {
      requestId: 'invalid-image-' + i, text: 'Do not send', ...(invalid[i] === undefined ? {} : { images: invalid[i] }),
    });
    assert.equal(result.status, 400, 'invalid image case ' + i + ': ' + JSON.stringify(result.body));
    assert.equal(result.body.acceptanceUnknown, false);
  }
  assert.equal(promptRows().length, count, 'invalid input must not reach native stdin');
  const view = await request('/sessions/' + session.id);
  assert.deepEqual(view.body.items, [], 'invalid images must not add a user message');
  assert.equal(view.body.lastSubmission, null, 'validation must precede submission claims');
  assert.equal((await request(`/sessions/${session.id}/turns`, { requestId: 'plain-after-invalid', text: 'Still available' })).status, 200);
  await completed(session);
});

for (const capability of ['false', 'missing']) test('ACP image capability ' + capability + ' fails at the image boundary and preserves text chat', async () => {
  const isolatedLog = path.join(directory, 'capability-' + capability + '.log');
  const peer = await h.startRust({ env: { ...environment(isolatedLog), KEEPWORK_AGENT_IMAGE_FIXTURE_CAPABILITY: capability } });
  try {
    const session = await create('deepseek', 'image-capability-' + capability, peer);
    const result = await request(`/sessions/${session.id}/image-turns`, { requestId: 'unsupported-image', text: 'Describe it', images: [image] }, { daemon: peer });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.code, 'UNSUPPORTED_FEATURE');
    assert.equal(result.body.acceptanceUnknown, false);
    assert.equal(promptRows(isolatedLog).length, 0);
    const view = await request('/sessions/' + session.id, undefined, { daemon: peer });
    assert.deepEqual(view.body.items, []);
    assert.equal((await request(`/sessions/${session.id}/turns`, { requestId: 'still-text', text: 'Ordinary text still works' }, { daemon: peer })).status, 200);
    await completed(session, peer);
    assert.equal(promptRows(isolatedLog).length, 1);
  } finally { await peer.stop(); }
});

test('the dedicated image route accepts a 2 MiB raster while the legacy body limit stays bounded', async () => {
  const session = await create('deepseek', 'image-body-limit');
  const large = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024, 2).toString('base64');
  const input = { requestId: 'large-image', text: 'Large image fixture', images: [large] };
  const rejected = await request(`/sessions/${session.id}/turns`, input);
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(rejected.body.error, /too large/i);
  assert.equal((await request(`/sessions/${session.id}/image-turns`, input)).status, 200);
  await completed(session);
  const huge = await request(`/sessions/${session.id}/image-turns`, { requestId: 'huge-body', text: 'x'.repeat(7_000_000) });
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /too large/i);
});

test('image-turn routes preserve Origin and owner confinement', async () => {
  const session = await create('deepseek', 'image-owner');
  const input = { requestId: 'owner-image', text: 'Image', images: [image] };
  const count = promptRows().length;
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'x-agent-owner': 'b'.repeat(40) }, { origin: '' }]) {
    const result = await request(`/sessions/${session.id}/image-turns`, input, { headers });
    assert.notEqual(result.status, 200);
    assert.ok(!JSON.stringify(result.body).includes(png));
  }
  assert.equal(promptRows().length, count);
});

test('Codex image echoes stay redacted in live and reconnected event streams', async () => {
  const session = await create('codex', 'image-event-stream');
  const input = { requestId: 'image-stream', text: 'Read the picture', images: [image] };
  const response = await fetch(`${daemon.base}/agents/sessions/${session.id}/events?cursor=${session.cursor}`, {
    headers: { origin: daemon.base, 'x-agent-owner': owner }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let output = '', pending = '';
  const collecting = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value).toString('utf8');
      output += chunk; pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.session?.status === 'completed' && record.session.lastSubmission?.requestId === input.requestId) return;
      }
    }
  })();
  try {
    const result = await request(`/sessions/${session.id}/image-turns`, input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await collecting;
  } finally { await reader.cancel(); await collecting.catch(() => {}); }
  assert.ok(output.length > 0);
  assert.ok(!output.includes(png), 'live snapshots must not expose native image echoes');
  const view = await completed(session);
  const replay = await fetch(`${daemon.base}/agents/sessions/${session.id}/events?cursor=${view.cursor}`, {
    headers: { origin: daemon.base, 'x-agent-owner': owner }, signal: AbortSignal.timeout(5000),
  });
  const replayReader = replay.body.getReader();
  try {
    const first = await replayReader.read();
    assert.ok(!Buffer.from(first.value).toString('utf8').includes(png), 'reconnecting must preserve redaction');
  } finally { await replayReader.cancel(); }
});
