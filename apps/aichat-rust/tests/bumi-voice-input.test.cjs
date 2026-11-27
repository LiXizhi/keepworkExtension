const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/bumi-voice-input.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class Channel {
  onmessage = () => {};
  emit(event) { this.onmessage(event); }
}
const exported = {};
vm.runInNewContext(javascript, {
  exports: exported,
  require: () => ({ Channel, invoke: async () => {} }),
});
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(t, options = {}) {
  const calls = [], phases = [], previews = [], results = [], contexts = [];
  let capture = true;
  function stream() {
    const track = Object.assign(new EventTarget(), { stops: 0, stop() { this.stops++; } });
    return { track, getTracks: () => [track] };
  }
  class Node {
    connect() {}
    disconnect() {}
  }
  class Context {
    state = "running";
    sampleRate = options.sampleRate || 48000;
    destination = {};
    closes = 0;
    constructor() { contexts.push(this); }
    async close() { this.closes++; this.state = "closed"; }
    createMediaStreamSource() { return this.source = new Node(); }
    createScriptProcessor() { return this.processor = new Node(); }
    createGain() { return this.silent = Object.assign(new Node(), { gain: { value: 1 } }); }
    pump(value = 0.5, size = 4800) {
      this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(size).fill(value) } });
    }
  }
  let currentStream, eventChannel;
  const control = exported.createBumiVoiceInput({
    start: async (id, events) => { calls.push(["start", id]); eventChannel = events; if (options.start) await options.start(); },
    send: async (id, samples) => { calls.push(["audio", id, [...samples]]); if (options.send) await options.send(); },
    finish: async id => { calls.push(["finish", id]); },
    cancel: async id => { calls.push(["cancel", id]); },
    getUserMedia: async constraints => {
      calls.push(["microphone", constraints]);
      if (options.permission) await options.permission.promise;
      currentStream = stream();
      return currentStream;
    },
    createAudioContext: () => new Context(),
    createId: () => "voice-test",
    canCapture: () => capture,
    onPhase: (phase, message) => phases.push([phase, message]),
    onPreview: text => previews.push(text),
    onResult: text => results.push(text),
  });
  t.after(() => control.cancel());
  return {
    control, calls, phases, previews, results, contexts,
    get events() { return eventChannel; },
    get stream() { return currentStream; },
    visible(value) { capture = value; },
    audio: () => calls.filter(call => call[0] === "audio"),
  };
}

test("computer microphone streams PCM and only a completed utterance fills the command draft", async t => {
  const f = fixture(t);
  f.control.toggle();
  await settle();
  assert.equal(f.control.active(), true);
  assert.deepEqual(f.calls.slice(0, 2).map(call => call[0]), ["microphone", "start"]);
  assert.equal(f.contexts[0].silent.gain.value, 0);
  f.contexts[0].pump();
  await settle();
  assert.equal(f.audio().length, 1);
  assert.equal(f.audio()[0][2].length, 1600);
  assert.equal(f.audio()[0][2][0], 16383);
  f.events.emit({ type: "preview", text: "向前走" });
  assert.deepEqual(f.previews, ["向前走"]);
  assert.deepEqual(f.results, []);
  f.control.toggle();
  await settle();
  assert.equal(f.calls.some(call => call[0] === "finish"), true);
  assert.equal(f.stream.track.stops, 1);
  f.events.emit({ type: "done", text: "向前走一步" });
  assert.deepEqual(f.results, ["向前走一步"]);
  assert.equal(f.control.active(), false);
});

test("stopping waits for queued audio before closing the native utterance", async t => {
  const sending = deferred();
  const f = fixture(t, { send: () => sending.promise });
  f.control.toggle();
  await settle();
  f.contexts[0].pump();
  await settle();
  f.control.toggle();
  await settle();
  assert.equal(f.calls.some(call => call[0] === "finish"), false);
  sending.resolve();
  await settle();
  assert.deepEqual(f.calls.filter(call => ["audio", "finish"].includes(call[0])).map(call => call[0]), ["audio", "finish"]);
});

test("cancelling during microphone permission releases a late stream and ignores late recognition", async t => {
  const permission = deferred();
  const f = fixture(t, { permission });
  const starting = f.control.start();
  await settle();
  f.control.cancel();
  assert.equal(f.stream, undefined);
  permission.resolve();
  await starting;
  await settle();
  assert.equal(f.stream.track.stops, 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.calls.some(call => call[0] === "cancel"), true);
  assert.equal(f.calls.some(call => call[0] === "start"), false);
  assert.deepEqual(f.results, []);
});

test("cancelling while native recognition starts releases the prepared microphone", async t => {
  const startingNative = deferred();
  const f = fixture(t, { start: () => startingNative.promise });
  const starting = f.control.start();
  await settle();
  assert.equal(f.calls.some(call => call[0] === "start"), true);
  f.control.cancel();
  startingNative.resolve();
  await starting;
  await settle();
  assert.equal(f.stream.track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.calls.some(call => call[0] === "finish"), false);
  f.events.emit({ type: "done", text: "过期口令" });
  assert.deepEqual(f.results, []);
});

test("losing window focus after permission cannot leave a microphone running", async t => {
  const permission = deferred();
  const f = fixture(t, { permission });
  const starting = f.control.start();
  await settle();
  f.visible(false);
  permission.resolve();
  await starting;
  await settle();
  assert.equal(f.stream.track.stops, 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.control.active(), false);
  assert.equal(f.calls.some(call => call[0] === "cancel"), true);
  assert.deepEqual(f.results, []);
});

test("cancelling transcription suppresses its final text and releases capture", async t => {
  const f = fixture(t);
  f.control.toggle();
  await settle();
  f.control.toggle();
  await settle();
  f.control.cancel();
  f.events.emit({ type: "done", text: "过期口令" });
  assert.deepEqual(f.results, []);
  assert.equal(f.stream.track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.calls.filter(call => call[0] === "cancel").length, 1);
});

test("empty and failed recognition return to idle without producing a command", async t => {
  for (const event of [{ type: "done", text: " " }, { type: "error", message: "网络不可用" }]) {
    const f = fixture(t);
    f.control.toggle();
    await settle();
    f.events.emit(event);
    assert.deepEqual(f.results, []);
    assert.equal(f.control.active(), false);
    assert.equal(f.stream.track.stops, 1);
    assert.equal(f.contexts[0].closes, 1);
  }
});
