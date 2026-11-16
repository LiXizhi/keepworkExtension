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
  vm.runInNewContext(script, { window, setTimeout, clearTimeout });
  return { window, bridge: window.aichatDesktop, calls, dispatch: (...args) => dispatch(...args),
    dispose: () => events.get('pagehide')() };
}
const value = (extra = {}) => ({ version: 1, context: 'alice-chat-1', ready: true, target: 'chat', ...extra });
test('CEF pet projection requires document connection and a real command subscriber; bounds optional media support', async () => {
  const pet = install();
  assert.equal(pet.window.__keepworkPetTransport, undefined);
  assert.equal(Object.isFrozen(pet.bridge), true);
  assert.deepEqual(Object.keys(pet.bridge).sort(), ['capabilities', 'onPetAudio', 'onPetCommand', 'petAudio', 'petResult', 'pickFolder', 'publishPetState', 'returnToPetAfterApproval', 'revealPetApproval', 'version']);
  assert.deepEqual(JSON.parse(JSON.stringify(pet.bridge.capabilities)), {
    floatingPet: true, petTextChatVersion: 1, petMediaChatVersion: 1,
    petDictationAudioVersion: 1, petVoiceAudioVersion: 1, nativeFolderPickerVersion: 1, petApprovalRevealVersion: 1, petApprovalReturnVersion: 1,
  });
  await pet.bridge.publishPetState(value({ pet: { imageData: 'large private image' }, voice: { secret: 'omit' }, files: 'omit' }));
  assert.deepEqual(pet.calls, []);
  pet.dispatch('connect', 'challenge');
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 0);
  const off = pet.bridge.onPetCommand(() => {});
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 1);
  const state = JSON.parse(pet.calls.at(-1).payload);
  for (const key of ['pet', 'files']) assert.equal(key in state, false);
  assert.equal(state.voice?.secret, undefined);
  off(); await pet.bridge.publishPetState(value({ draft: 'local draft' }));
  assert.equal(pet.calls.filter(c => c.kind === 'state').length, 1);
});
test('CEF confirmation reveal waits for its own document-bound presentation result without sending a decision', async () => {
  const pet = install();
  const waiting = pet.bridge.revealPetApproval();
  assert.deepEqual(pet.calls, []);
  pet.dispatch('connect', 'challenge');
  const first = pet.calls.at(-1);
  assert.equal(first.kind, 'reveal-approval');
  assert.match(first.payload, /^[0-9]+$/);
  pet.dispatch('approval-shown', 'stale');
  pet.dispatch('approval-inactive', first.payload);
  assert.equal(await waiting, false);
  const active = pet.bridge.revealPetApproval({ returnToPet: true });
  const second = pet.calls.at(-1);
  assert.notEqual(second.payload, first.payload);
  pet.dispatch('approval-inactive', first.payload);
  pet.dispatch('approval-shown', second.payload);
  assert.equal(await active, true);
  const restoring = pet.bridge.returnToPetAfterApproval();
  pet.dispatch('approval-shown', pet.calls.at(-1).payload);
  assert.equal(await restoring, true);
  assert.deepEqual(pet.calls.map(call => call.kind),
    ['connect', 'reveal-approval', 'reveal-approval-for-return', 'return-after-approval']);
  const interrupted = pet.bridge.revealPetApproval();
  pet.dispose();
  await assert.rejects(interrupted);
  await assert.rejects(pet.bridge.revealPetApproval());
});
test('CEF pet projection bounds text, rejects unrelated commands and removes listeners on navigation', async () => {
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
test('CEF projects the current session without assuming a missing target is a persona', async () => {
  const pet = install();
  pet.bridge.onPetCommand(() => {}); pet.dispatch('connect', 'challenge');
  for (const [target, expected] of [['session', 'chat'], ['chat', 'chat'], [undefined, 'chat'], ['persona', 'persona']]) {
    await pet.bridge.publishPetState(value({ target, context: 'page-context', title: 'Selected' }));
    const state = JSON.parse(pet.calls.at(-1).payload);
    assert.equal(state.target, expected);
    assert.equal(state.context, 'page-context');
    assert.equal(state.title, 'Selected');
  }
});
test('CEF media projection carries only bounded status and capability fields, never recording data or credentials', async () => {
  const pet = install();
  pet.bridge.onPetCommand(() => {}); pet.dispatch('connect', 'challenge');
  await pet.bridge.publishPetState(value({
    canDictate: true, canCall: true, dictating: true,
    voice: { active: true, muted: true, state: 's'.repeat(100), token: 'private', audio: [12, 34] },
    audio: [12, 34], credentials: 'private',
  }));
  const state = JSON.parse(pet.calls.at(-1).payload);
  assert.equal(state.canDictate, true); assert.equal(state.canCall, true); assert.equal(state.dictating, true);
  assert.deepEqual(state.voice, { active: true, muted: true, state: 's'.repeat(40) });
  assert.equal(state.audio, undefined); assert.equal(state.credentials, undefined);
});
test('CEF optional media fields preserve old text and dictation defaults without inventing call support', async () => {
  const pet = install();
  pet.bridge.onPetCommand(() => {}); pet.dispatch('connect', 'challenge');
  await pet.bridge.publishPetState(value({ draft: 'legacy draft' }));
  let state = JSON.parse(pet.calls.at(-1).payload);
  assert.equal(state.draft, 'legacy draft'); assert.equal(state.ready, true);
  assert.equal(state.canDictate, true); assert.equal(state.canCall, false);
  assert.equal(state.petDictationAudioVersion, 0); assert.equal(state.petVoiceAudioVersion, 0);
  assert.deepEqual(state.voice, { active: false, muted: false, state: '' });
  await pet.bridge.publishPetState(value({ canDictate: false, canCall: 'true',
    petDictationAudioVersion: 2, petVoiceAudioVersion: '1', voice: { active: 'true', muted: 1 } }));
  state = JSON.parse(pet.calls.at(-1).payload);
  assert.equal(state.canDictate, false); assert.equal(state.canCall, false);
  assert.equal(state.petDictationAudioVersion, 0); assert.equal(state.petVoiceAudioVersion, 0);
  assert.equal(state.voice.active, false); assert.equal(state.voice.muted, false);
});
test('CEF media commands preserve the existing context and request contract and do not require a preceding text input', async () => {
  const pet = install(), received = [];
  pet.bridge.onPetCommand(command => received.push(command)); pet.dispatch('connect', 'challenge');
  await pet.bridge.publishPetState(value({ canDictate: true, canCall: true }));
  for (const action of ['dictation', 'call', 'mute']) {
    const command = { version: 1, context: 'alice-chat-1', action, requestId: `media-${action}` };
    pet.dispatch('command', JSON.stringify(command));
    assert.equal(received.at(-1).action, action);
    assert.equal(received.at(-1).context, command.context);
    assert.equal(received.at(-1).requestId, command.requestId);
    assert.equal(Object.isFrozen(received.at(-1)), true);
    await pet.bridge.petResult({ requestId: command.requestId, ok: true, data: { private: true } });
    assert.deepEqual(JSON.parse(pet.calls.at(-1).payload), { requestId: command.requestId, ok: true, error: '' });
  }
  assert.deepEqual(received.map(command => command.action), ['dictation', 'call', 'mute']);
  pet.dispose();
  pet.dispatch('command', JSON.stringify({ version: 1, context: 'alice-chat-1', action: 'call', requestId: 'late-call' }));
  assert.equal(received.length, 3, 'navigation cannot replay an old call or dictation request');
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
  const { pathToFileURL } = require('node:url');
  const { createDesktopPetController } = await import(pathToFileURL(process.env.AICHAT_WEB_PET_CONTROLLER).href);
  const pet = install();
  let owner = 'alice', draft = '', busy = false, sent = 0;
  const controller = createDesktopPetController(pet.bridge, {
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
