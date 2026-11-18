const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { createPetModelPublisher } = await import('../src/petModel.js');
  const nodes = { chatModelSelect: { value: 'keepwork-pro' } };
  const listeners = new Map();
  const timers = new Set();
  const sent = [];
  let fail = false;
  const env = {
    document: { getElementById: id => nodes[id] },
    setInterval: cb => { timers.add(cb); return cb; },
    clearInterval: cb => timers.delete(cb),
    addEventListener: (name, cb) => listeners.set(name, cb),
    removeEventListener: (name, cb) => { if (listeners.get(name) === cb) listeners.delete(name); },
  };
  const publisher = createPetModelPublisher(async state => {
    if (fail) { fail = false; throw new Error('temporary IPC failure'); }
    sent.push(state); return true;
  }, env);
  return { publisher, nodes, listeners, timers, sent, failNext: () => { fail = true; },
    tick: async () => { for (const cb of timers) cb(); await new Promise(setImmediate); } };
}

test('model-only selection and restored conversations publish current model without changing saved state', async () => {
  const f = await fixture();
  const original = { context: 'chat:A', target: 'session', draft: 'keep me', pet: { name: 'My pet' } };
  await f.publisher.publish(original);
  assert.equal(f.sent.at(-1).modelId, 'keepwork-pro');
  assert.equal(original.modelId, undefined);
  f.nodes.chatModelSelect.value = 'claude-sonnet-4-5';
  await f.tick();
  assert.deepEqual(f.sent.at(-1), { ...original, modelId: 'claude-sonnet-4-5' });
  await f.tick(); assert.equal(f.sent.length, 2, 'unchanged model does not flood snapshots');
  f.nodes.chatModelSelect.value = 'gpt-5';
  await f.publisher.publish({ context: 'chat:B', draft: 'other' });
  await f.tick();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent.at(-1).context, 'chat:B');
  f.nodes.chatModelSelect.value = 'keepwork';
  await f.tick(); assert.equal(f.sent.at(-1).modelId, 'keepwork');
  f.publisher.dispose();
});

test('external harness uses its own model and never the stale Keepwork selector', async () => {
  const f = await fixture();
  f.nodes.chatHarnessSelect = { value: 'claude' };
  f.nodes.chatHarnessModel = { value: 'claude-opus-4' };
  await f.publisher.publish({ context: 'external' });
  assert.equal(f.sent.at(-1).modelId, 'claude-opus-4');
  delete f.nodes.chatHarnessModel;
  await f.tick(); assert.equal(f.sent.at(-1).modelId, '');
  f.nodes.chatHarnessSelect.value = 'keepwork';
  await f.tick(); assert.equal(f.sent.at(-1).modelId, 'keepwork-pro');
  f.publisher.dispose();
});

test('explicit producer model wins; invalid IDs and missing controls fail to user fallback', async () => {
  const f = await fixture();
  await f.publisher.publish({ modelId: 'kimi-k2' });
  f.nodes.chatModelSelect.value = 'gpt-5';
  await f.tick(); assert.equal(f.sent.length, 1);
  for (const modelId of ['', 'x'.repeat(129), 'gpt\n5', { id: 'gpt-5' }]) {
    await f.publisher.publish({ modelId }); assert.equal(f.sent.at(-1).modelId, '');
  }
  delete f.nodes.chatModelSelect;
  f.nodes.modelSelect = { value: 'glm-5' };
  await f.publisher.publish({}); assert.equal(f.sent.at(-1).modelId, 'glm-5');
  delete f.nodes.modelSelect;
  await f.tick(); assert.equal(f.sent.at(-1).modelId, '');
  f.publisher.dispose();
});

test('persona model is independent from ordinary chat and hidden main-window layout', async () => {
  const f = await fixture();
  const control = { title: '选择模型：Claude Sonnet (claude-sonnet-4-5)' };
  const page = { hidden: false, querySelector: () => control };
  f.nodes.personaPage = page;
  await f.publisher.publish({ target: 'persona', context: 'persona:A' });
  assert.equal(f.sent.at(-1).modelId, 'claude-sonnet-4-5');
  control.title = '选择模型：keepwork-pro';
  await f.tick(); assert.equal(f.sent.at(-1).modelId, 'keepwork-pro');
  control.title = '选择模型';
  await f.tick(); assert.equal(f.sent.at(-1).modelId, '');
  control.title = '选择模型：gpt-5'; page.hidden = true;
  await f.tick(); assert.equal(f.sent.at(-1).modelId, '');
  page.hidden = false;
  await f.tick(); assert.equal(f.sent.at(-1).modelId, 'gpt-5');
  f.publisher.dispose();
});

test('failed delivery retries and navigation destroys retained state and watchers', async () => {
  const f = await fixture();
  f.failNext(); await assert.rejects(f.publisher.publish({ context: 'owner' }));
  await f.tick(); assert.equal(f.sent.length, 1);
  f.listeners.get('pagehide')();
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(await f.publisher.publish({ context: 'stale' }), false);
  await f.tick(); assert.equal(f.sent.length, 1);
});
