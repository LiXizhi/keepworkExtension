const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../windows/cef-host/pet_bridge.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };

function clock() {
  let now = 0, serial = 0;
  const pending = new Map();
  const add = (callback, delay, interval = 0) => { const id = ++serial; pending.set(id, { callback, due: now + delay, interval }); return id; };
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => add(callback, delay),
    setInterval: (callback, delay) => add(callback, delay, delay),
    clearTimeout: id => pending.delete(id), clearInterval: id => pending.delete(id),
    advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.due;
        if (timer.interval) timer.due += timer.interval; else pending.delete(id);
        timer.callback();
      }
      now = end;
    },
    pending: () => pending.size,
  };
}

async function fixture(t, options = {}) {
  let dispatch;
  const timer = clock(), subscriptions = new Map(), emitted = [], contexts = [], streams = [], requests = [];
  const stream = () => {
    const track = Object.assign(new EventTarget(), { stops: 0, stop() { this.stops++; } });
    const value = { track, getTracks: () => [track] }; streams.push(value); return value;
  };
  class AudioNode {
    disconnects = 0;
    connect() {}
    disconnect() { this.disconnects++; }
  }
  class AudioContext {
    sampleRate = options.sampleRate || 48000;
    state = 'suspended'; destination = {}; closes = 0;
    constructor() { contexts.push(this); }
    async resume() { if (options.resume) await options.resume(); this.state = 'running'; }
    async close() { this.closes++; this.state = 'closed'; }
    createMediaStreamSource() { return this.source = new AudioNode(); }
    createScriptProcessor() { return this.processor = new AudioNode(); }
    createGain() { return this.silent = Object.assign(new AudioNode(), { gain: { value: 1 } }); }
    pump(value = 0.5, length = 4800) { this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(length).fill(value) } }); }
  }
  const window = {
    __keepworkPetTransport(kind, payload) { if (kind === 'register') dispatch = payload; return true; },
    addEventListener(type, listener) { subscriptions.set(type, listener); },
  };
  vm.runInNewContext(script, { window, ...timer, AudioContext, navigator: { mediaDevices: {
    async getUserMedia(constraints) { requests.push(copy(constraints)); return options.getUserMedia ? options.getUserMedia() : stream(); },
  } } });
  const bridge = window.aichatDesktop;
  bridge.onPetCommand(() => {}); bridge.onPetAudio(event => emitted.push(copy(event)));
  dispatch('connect', 'challenge');
  await bridge.publishPetState({ version: 1, context: 'owner:chat', ready: true, canDictate: true, canCall: true,
    petDictationAudioVersion: 1, petVoiceAudioVersion: 1 });
  const dispose = () => subscriptions.get('pagehide')();
  t.after(dispose);
  return {
    bridge, emitted, contexts, streams, requests, timer, stream, dispose,
    intent(id = 'audio-1', action = 'dictation', context = 'owner:chat') {
      dispatch('command', JSON.stringify({ version: 1, context, requestId: `request-${id}`, action, petAudio: { version: 1, id } }));
    },
    command: (op, id = 'audio-1', seq) => bridge.petAudio(op, id, seq),
    audio: () => emitted.filter(event => event.type === 'audio'),
    errors: () => emitted.filter(event => event.type === 'error'),
  };
}

test('CEF microphone requires a current native click lease and separate activation before PCM delivery', async t => {
  const f = await fixture(t);
  await assert.rejects(f.command('start'), /失效/); assert.deepEqual(f.requests, []);
  f.intent();
  assert.deepEqual(copy(await f.command('start')), { sampleRate: 16000, channels: 1, format: 'pcm16' });
  assert.deepEqual(f.requests, [{ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
  assert.equal(f.contexts[0].silent.gain.value, 0);
  f.contexts[0].pump(); assert.deepEqual(f.audio(), []);
  await f.command('activate'); f.contexts[0].pump();
  assert.equal(f.audio().length, 1);
  assert.equal(f.audio()[0].seq, 1); assert.equal(f.audio()[0].samples.length, 1600);
  assert.equal(f.audio()[0].samples.every(sample => sample === 16383), true);
  await f.command('ack', 'audio-1', 1);
  await f.command('stop');
  assert.equal(f.streams[0].track.stops, 1); assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].processor.onaudioprocess, null);
  assert.equal(f.timer.pending(), 0); assert.deepEqual(f.errors(), []);
});

test('CEF permission denial emits a bounded error and a fresh click can retry', async t => {
  let deny = true;
  const f = await fixture(t, { getUserMedia: () => deny ? Promise.reject(Error('Permission denied')) : f.stream() });
  f.intent(); await assert.rejects(f.command('start'), /Permission denied/);
  assert.equal(f.errors().length, 1); assert.equal(f.timer.pending(), 0);
  deny = false; f.intent('retry'); await f.command('start', 'retry');
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].track.stops, 0);
});

test('CEF stopping during permission releases the late stream and never activates it', async t => {
  const permission = deferred();
  const f = await fixture(t, { getUserMedia: () => permission.promise });
  f.intent(); const starting = f.command('start'); await settle();
  await f.command('stop');
  const stream = f.stream(); permission.resolve(stream);
  assert.deepEqual(copy(await starting), { cancelled: true });
  assert.equal(stream.track.stops, 1); assert.deepEqual(f.contexts, []);
  assert.equal(f.timer.pending(), 0); assert.deepEqual(f.audio(), []);
});

for (const late of ['resolve', 'reject']) test(`CEF Stop cancels a pending audio resume immediately and ignores late ${late}`, async t => {
  const resumed = deferred(); let resumes = 0;
  const f = await fixture(t, { resume: () => resumes++ === 0 ? resumed.promise : Promise.resolve() });
  f.intent(); const starting = f.command('start'); let completed = false;
  starting.then(() => { completed = true; }); await settle();
  assert.equal(f.contexts.length, 1, 'test stops while AudioContext.resume is pending');
  await f.command('stop'); await settle();
  assert.equal(f.streams[0].track.stops, 1); assert.equal(f.contexts[0].closes, 1);
  assert.equal(completed, true, 'Stop resolves the cancelled start without waiting for a resume or timeout');
  assert.deepEqual(copy(await starting), { cancelled: true }); assert.equal(f.timer.pending(), 0);
  f.intent('replacement'); await f.command('start', 'replacement');
  if (late === 'resolve') resumed.resolve(); else resumed.reject(Error('Late resume failure'));
  await settle();
  assert.equal(f.streams[1].track.stops, 0, 'old completion cannot release the new click capture');
  assert.equal(f.contexts[1].closes, 0); assert.deepEqual(f.errors(), []); assert.deepEqual(f.audio(), []);
});

test('CEF bounded PCM transport checks acknowledgements and stops rather than silently dropping chunks', async t => {
  const f = await fixture(t); f.intent(); await f.command('start'); await f.command('activate');
  await assert.rejects(f.command('ack', 'audio-1', 1), /顺序/);
  for (let index = 0; index < 16; index++) f.contexts[0].pump();
  assert.equal(f.audio().length, 16);
  await assert.rejects(f.command('ack', 'audio-1', 2), /顺序/);
  f.contexts[0].pump();
  assert.equal(f.audio().length, 16); assert.match(f.errors()[0].message, /阻塞/);
  assert.equal(f.streams[0].track.stops, 1); assert.equal(f.timer.pending(), 0);
});

test('CEF audio lease expires and a provider that never activates cannot retain the microphone', async t => {
  const f = await fixture(t); f.intent(); f.timer.advance(15001);
  await assert.rejects(f.command('start'), /无效/); assert.deepEqual(f.requests, []);
  f.intent('fresh'); await f.command('start', 'fresh');
  f.timer.advance(15000);
  assert.equal(f.streams[0].track.stops, 1); assert.match(f.errors()[0].message, /未响应/);
  assert.equal(f.timer.pending(), 0);
});

test('CEF stops an active microphone when the audio graph stops producing callbacks', async t => {
  const f = await fixture(t); f.intent(); await f.command('start'); await f.command('activate');
  f.timer.advance(15000);
  assert.equal(f.streams[0].track.stops, 1);
  assert.match(f.errors()[0].message, /暂停/);
  assert.equal(f.timer.pending(), 0);
});

test('CEF context switch and navigation release audio and reject late commands without replay', async t => {
  const f = await fixture(t); f.intent(); await f.command('start'); await f.command('activate');
  await f.bridge.publishPetState({ version: 1, context: 'other-owner', ready: true });
  assert.equal(f.streams[0].track.stops, 1); await assert.rejects(f.command('activate'), /失效/);
  f.intent('other-audio', 'call', 'other-owner'); await f.command('start', 'other-audio');
  f.dispose(); f.contexts[1].pump();
  assert.equal(f.streams[1].track.stops, 1); assert.equal(f.timer.pending(), 0);
  await assert.rejects(f.command('activate', 'other-audio'), /失效/); assert.deepEqual(f.audio(), []);
});

for (const sampleRate of [44100, 48000]) test(`CEF resampler preserves one second at ${sampleRate} Hz across callback boundaries`, async t => {
  const f = await fixture(t, { sampleRate }); f.intent(); await f.command('start'); await f.command('activate');
  for (let offset = 0; offset < sampleRate; offset += 4096) {
    f.contexts[0].pump(-1, Math.min(4096, sampleRate - offset));
    await f.command('ack', 'audio-1', f.audio().at(-1).seq);
  }
  assert.equal(f.audio().reduce((total, event) => total + event.samples.length, 0), 16000);
  assert.equal(f.audio().every(event => event.samples.every(sample => sample >= -32768 && sample <= -32767)), true,
    'fractional resampling stays within one PCM quantization unit of full negative scale');
});

test('CEF adapter interoperates with the independently shipped AIChat pet audio protocol', {
  skip: !process.env.AICHAT_WEB_PET_AUDIO,
}, async t => {
  const source = fs.readFileSync(process.env.AICHAT_WEB_PET_AUDIO, 'utf8').replaceAll('export function ', 'function ');
  const scope = {};
  vm.createContext(scope);
  vm.runInContext(source + '\nthis.createCapture = createDesktopPetAudioCapture;', scope);
  const f = await fixture(t), pcm = [], failures = [];
  f.intent();
  const capture = scope.createCapture({ version: 1, id: 'audio-1' }, {
    audio: chunk => pcm.push([...chunk]), error: error => failures.push(error.message), stopped() {},
  }, f.bridge);
  await capture.start(); await capture.activate();
  f.contexts[0].pump(0.5); await settle();
  assert.equal(pcm.length, 1); assert.equal(pcm[0].length, 1600);
  assert.equal(pcm[0].every(sample => sample === 16383), true);
  assert.deepEqual(failures, []);
  capture.stop(); await settle();
  assert.equal(f.streams[0].track.stops, 1); assert.equal(f.timer.pending(), 0);
});
