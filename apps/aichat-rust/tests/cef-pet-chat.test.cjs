const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../windows/cef-host/pet_bridge.js'), 'utf8');
function install() {
  let dispatch;
  const calls = [], events = new Map();
  const window = {
    __keepworkPetTransport(kind, payload) {
      if (kind === 'register') dispatch = payload;
      else calls.push({ kind, payload });
      return true;
    },
    addEventListener(type, listener) { events.set(type, listener); },
  };
  vm.runInNewContext(script, { window });
  return { window, bridge: window.aichatDesktop, calls, dispatch: (...args) => dispatch(...args),
    dispose: () => events.get('pagehide')() };
}
const value = (extra = {}) => ({ version: 1, context: 'alice-chat-1', ready: true, target: 'chat', ...extra });
test('CEF pet projection requires document connection and a real command subscriber; exposes only the text subset', async () => {
  const pet = install();
  assert.equal(pet.window.__keepworkPetTransport, undefined);
  assert.equal(Object.isFrozen(pet.bridge), true);
  assert.deepEqual(Object.keys(pet.bridge).sort(), ['capabilities', 'onPetCommand', 'petResult', 'publishPetState', 'version']);
  assert.deepEqual(JSON.parse(JSON.stringify(pet.bridge.capabilities)), { floatingPet: true, petTextChatVersion: 1 });
  await pet.bridge.publishPetState(value({ pet: { imageData: 'large private image' }, voice: { secret: 'omit' }, files: 'omit' }));
  assert.deepEqual(pet.calls, []);
  pet.dispatch('connect', 'challenge');
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 0);
  const off = pet.bridge.onPetCommand(() => {});
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 1);
  const state = JSON.parse(pet.calls.at(-1).payload);
  for (const key of ['pet', 'voice', 'files']) assert.equal(key in state, false);
  off(); await pet.bridge.publishPetState(value({ draft: 'local draft' }));
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 1);
});
test('CEF pet projection bounds text, rejects non-text commands and removes listeners on navigation', async () => {
  const pet = install(), commands = [];
  pet.bridge.onPetCommand(command => commands.push(command));
  pet.dispatch('connect', 'challenge');
  await pet.bridge.publishPetState(value({ draft: 'x'.repeat(40000), reply: { text: 'r'.repeat(9000) },
    messages: Array.from({ length: 12 }, () => ({ role: 'assistant', content: 'm'.repeat(5000), attachment: 'omit' })) }));
  const state = JSON.parse(pet.calls.at(-1).payload);
  assert.equal(state.draft.length, 32000); assert.equal(state.reply.length, 8000);
  assert.equal(state.messages.length, 8); assert.equal(state.messages[0].content.length, 4000);
  assert.equal(state.messages[0].attachment, undefined);
  const command = { version: 1, context: 'alice-chat-1', requestId: 'request-1', action: 'input', text: 'hello' };
  pet.dispatch('command', JSON.stringify(command));
  pet.dispatch('command', JSON.stringify({ ...command, action: 'run_terminal' }));
  pet.dispatch('command', '{bad json');
  assert.equal(commands.length, 1); assert.equal(Object.isFrozen(commands[0]), true);
  await pet.bridge.petResult({ requestId: 'request-1', ok: true, data: { key: 'omit' } });
  assert.deepEqual(JSON.parse(pet.calls.at(-1).payload), { requestId: 'request-1', ok: true, error: '' });
  pet.dispose(); const count = pet.calls.length;
  pet.dispatch('command', JSON.stringify(command));
  await pet.bridge.petResult({ requestId: 'request-1', ok: true });
  await assert.rejects(pet.bridge.publishPetState(value()));
  assert.equal(commands.length, 1); assert.equal(pet.calls.length, count);
});
test('CEF pet dispatcher rechecks its latest published draft before consuming a confirmed input for send', async () => {
  const pet = install(), delivered = [];
  pet.bridge.onPetCommand(command => delivered.push(command.action));
  pet.dispatch('connect', 'challenge');
  const command = (action, requestId, text) => pet.dispatch('command', JSON.stringify({
    version: 1, context: 'alice-chat-1', action, requestId, text,
  }));
  await pet.bridge.publishPetState(value({ draft: 'A' }));
  command('input', 'input-a', 'A');
  await pet.bridge.petResult({ requestId: 'input-a', ok: true });
  await pet.bridge.publishPetState(value({ draft: 'B' }));
  command('send', 'send-a');
  assert.deepEqual(delivered, ['input'], 'a changed known draft cannot be sent as the previously confirmed message');
  assert.equal(JSON.parse(pet.calls.at(-1).payload).ok, false);
  command('input', 'input-b', 'B');
  await pet.bridge.petResult({ requestId: 'input-b', ok: true });
  command('send', 'send-b'); command('send', 'duplicate-send-b');
  assert.deepEqual(delivered, ['input', 'input', 'send'], 'confirmed input is consumed exactly once');
});
// Optional integration against the actual independently shipped web controller.
// This is a service fixture, never evidence of a logged-in cloud conversation.
test('CEF adapter interoperates with the existing AIChat controller acceptance/error/context contract', {
  skip: !process.env.AICHAT_WEB_PET_CONTROLLER,
}, async () => {
  const source = fs.readFileSync(process.env.AICHAT_WEB_PET_CONTROLLER, 'utf8').replaceAll('export function ', 'function ');
  const pet = install();
  const scope = { crypto: require('node:crypto').webcrypto };
  vm.createContext(scope); vm.runInContext(source + '\nthis.createController = createDesktopPetController;', scope);
  let owner = 'alice', draft = '', busy = false, sent = 0;
  const controller = scope.createController(pet.bridge, {
    read: () => ({ owner, ready: true, target: 'chat', draft, busy, messages: [] }),
    input: text => { draft = text; },
    send: () => { sent++; busy = true; return Promise.resolve({ ok: false, error: 'fixture offline' }); },
    stop: () => { busy = false; },
  });
  pet.dispatch('connect', 'challenge'); await controller.refresh();
  const state = () => JSON.parse(pet.calls.filter(c => c.kind === 'state').at(-1).payload);
  const context = state().context;
  const command = async (action, requestId, extra = {}) => {
    pet.dispatch('command', JSON.stringify({ version: 1, context, action, requestId, ...extra }));
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  };
  await command('input', 'i1', { text: 'fixture hello' });
  assert.equal(draft, 'fixture hello');
  await command('send', 's1'); assert.equal(sent, 1);
  assert.equal(JSON.parse(pet.calls.filter(c => c.kind === 'result').at(-1).payload).ok, true, 'acceptance is not reply success');
  assert.equal(state().error, 'fixture offline');
  await command('send', 's1'); assert.equal(sent, 1, 'duplicate is not resent');
  owner = 'bob'; await controller.refresh(); assert.notEqual(state().context, context);
  await command('input', 'i2', { text: 'stale account draft' });
  assert.equal(draft, 'fixture hello'); controller.dispose();
});
