const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/petAudio.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function captureFactory(timers = { setTimeout, clearTimeout }) {
  const exported = {};
  vm.runInNewContext(javascript, {
    exports: exported, require: () => ({}), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return exported.createPetAudioCapture;
}
const createPetAudioCapture = captureFactory();
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function manualClock() {
  let now = 0, sequence = 0;
  const pending = new Map(), callbacks = [];
  return {
    setTimeout(callback, delay) {
      const id = ++sequence;
      pending.set(id, { callback, due: now + delay }); callbacks.push(callback);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, task] of [...pending]) {
        if (task.due <= now) { pending.delete(id); task.callback(); }
      }
    },
    pending: () => pending.size,
    lastCallback: () => callbacks.at(-1),
  };
}

function fixture(t, options = {}) {
  const reports = [], contexts = [], streams = [], requests = [], order = [];
  const resumeEntered = deferred();
  let visible = true;
  function stream() {
    const track = Object.assign(new EventTarget(), { stops: 0, stop() { this.stops++; } });
    const value = { track, getTracks: () => [track] };
    streams.push(value);
    return value;
  }
  class Node {
    connections = [];
    disconnects = 0;
    connect(node) { this.connections.push(node); }
    disconnect() { this.disconnects++; }
  }
  class Context {
    state = options.state || "running";
    sampleRate = options.sampleRate || 48000;
    destination = {};
    closes = 0;
    constructor() { contexts.push(this); }
    async resume() { resumeEntered.resolve(); if (options.resume) await options.resume(this); this.state = "running"; }
    async close() { this.closes++; this.state = "closed"; }
    createMediaStreamSource() { return this.source = new Node(); }
    createScriptProcessor() { return this.processor = new Node(); }
    createGain() { return this.silent = Object.assign(new Node(), { gain: { value: 1 } }); }
    pump(value = 0.5, size = 4800) {
      this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(size).fill(value) } });
    }
  }
  const createCapture = options.clock ? captureFactory(options.clock) : createPetAudioCapture;
  const control = createCapture({
    report: async (id, event) => {
      reports.push({ id, event: JSON.parse(JSON.stringify(event)) }); order.push(event.type);
      if (options.report) return options.report(id, event);
      return true;
    },
    getUserMedia: async constraints => { requests.push(JSON.parse(JSON.stringify(constraints))); order.push("getUserMedia"); return options.getUserMedia ? options.getUserMedia() : stream(); },
    createAudioContext: () => new Context(),
    isVisible: () => visible,
    isSecure: () => options.secure !== false,
    resumeTimeoutMs: 20,
    maxQueuedChunks: 8,
  });
  t.after(async () => { control.dispose(); await settle(); });
  return {
    control, reports, contexts, streams, requests, order, stream, resumeEntered: resumeEntered.promise,
    visible(value) { visible = value; },
    command: (op, id = "capture-1") => control.command({ op, id }),
    audio: () => reports.filter(record => record.event.type === "audio"),
    errors: () => reports.filter(record => record.event.type === "error"),
  };
}

test("visible pet claims native intent before microphone access and sends PCM only after active acknowledgement", async t => {
  const active = deferred();
  const f = fixture(t, { report: (_id, event) => event.type === "active" ? active.promise : true });
  await f.command("start");
  assert.deepEqual(f.order, ["claim", "getUserMedia", "ready"]);
  assert.deepEqual(f.requests, [{ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
  assert.deepEqual(f.reports[1].event, { type: "ready", sampleRate: 16000, channels: 1, format: "pcm16" });
  assert.equal(f.contexts[0].silent.gain.value, 0);
  f.contexts[0].pump(); await settle(); assert.deepEqual(f.audio(), []);
  const activation = f.command("activate"); await settle();
  f.contexts[0].pump(); await settle(); assert.deepEqual(f.audio(), [], "native must accept activation before audio is sent");
  active.resolve(true); await activation;
  f.contexts[0].pump(); await settle();
  f.contexts[0].pump(-1); await settle();
  assert.deepEqual(f.audio().map(record => [record.event.seq, record.event.samples.length, record.event.samples[0]]), [[1, 1600, 16383], [2, 1600, -32768]]);
  await f.command("stop");
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].processor.onaudioprocess, null);
  assert.deepEqual(f.errors(), []);
});

test("continuous resampling preserves exactly one second of 16 kHz PCM across fractional callback boundaries", async t => {
  for (const sampleRate of [48000, 44100]) {
    const f = fixture(t, { sampleRate });
    await f.command("start"); await f.command("activate");
    for (let offset = 0; offset < sampleRate; offset += 4096) {
      f.contexts[0].pump(0.5, Math.min(4096, sampleRate - offset)); await settle();
    }
    const audio = f.audio();
    assert.equal(audio.reduce((total, record) => total + record.event.samples.length, 0), 16000, `${sampleRate} Hz input must not lose the fractional output window`);
    assert.equal(audio.every(record => record.event.samples.length <= 4096 && record.event.samples.every(sample => sample === 16383)), true);
    assert.deepEqual(audio.map(record => record.event.seq), audio.map((_, index) => index + 1));
    await f.command("stop");
  }
});

for (const result of [false, "reject"]) test(`unclaimed pet event ${result} cannot request a microphone`, async t => {
  const f = fixture(t, { report: (_id, event) => event.type === "claim" ? (result === "reject" ? Promise.reject(Error("No pet click lease")) : false) : true });
  await f.command("start"); await settle();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.contexts, []);
});

test("stop while native claim is pending prevents a later microphone request", async t => {
  const claim = deferred();
  const f = fixture(t, { report: (_id, event) => event.type === "claim" ? claim.promise : true });
  const starting = f.command("start"); await settle();
  await f.command("stop"); claim.resolve(true); await starting;
  assert.deepEqual(f.requests, []);
});

test("stop while native active acknowledgement is pending cannot enable a cancelled microphone", async t => {
  const active = deferred();
  const f = fixture(t, { report: (_id, event) => event.type === "active" ? active.promise : true });
  await f.command("start");
  const activation = f.command("activate"); await settle();
  await f.command("stop");
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  active.resolve(true); await activation;
  f.contexts[0].pump(); await settle();
  assert.deepEqual(f.audio(), []);
  assert.deepEqual(f.errors(), []);
});

test("stop during microphone permission wait releases the late stream without creating an audio context", async t => {
  const permission = deferred();
  const f = fixture(t, { getUserMedia: () => permission.promise });
  const starting = f.command("start"); await settle();
  await f.command("stop");
  const stream = f.stream(); permission.resolve(stream); await starting;
  assert.equal(stream.track.stops, 1);
  assert.deepEqual(f.contexts, []);
  assert.equal(f.reports.some(record => record.event.type === "ready"), false);
});

for (const late of ["resolve", "reject"]) test(`stopping an audio resume immediately releases resources and ignores late ${late}`, async t => {
  const clock = manualClock();
  const resumed = deferred();
  let resumes = 0;
  const f = fixture(t, { clock, state: "suspended", resume: () => resumes++ === 0 ? resumed.promise : Promise.resolve() });
  const starting = f.command("start"); await f.resumeEntered;
  const oldDeadline = clock.lastCallback();
  assert.equal(typeof oldDeadline, "function", "stop must exercise an already pending resume");
  assert.equal(clock.pending(), 1);
  // No wall-clock wait may choose the event order: stop wins before timeout.
  await f.command("stop"); await f.command("stop"); await starting;
  assert.equal(clock.pending(), 0);
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.reports.some(record => record.event.type === "ready"), false);
  await f.command("start", "replacement");
  oldDeadline(); // A stale callback already queued before clearTimeout is safe too.
  if (late === "resolve") resumed.resolve(); else resumed.reject(Error("Late audio rejection"));
  clock.advance(20); await settle();
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.streams[1].track.stops, 0, "old completion cannot cancel the replacement capture");
  assert.equal(f.contexts[1].closes, 0);
  assert.equal(f.reports.some(record => record.id === "capture-1" && record.event.type === "ready"), false);
  assert.deepEqual(f.reports.filter(record => record.event.type === "ready").map(record => record.id), ["replacement"]);
  assert.deepEqual(f.audio(), []);
  assert.deepEqual(f.errors(), []);
});

test("audio resume reject ends capture and reports a bounded error", async t => {
  const f = fixture(t, { state: "suspended", resume: () => Promise.reject(Error("Audio unavailable")) });
  await f.command("start"); await settle();
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.errors().length, 1);
});

for (const late of ["resolve", "reject"]) test(`audio resume timeout before stop reports one error and ignores late ${late}`, async t => {
  const clock = manualClock(), resumed = deferred();
  const f = fixture(t, { clock, state: "suspended", resume: () => resumed.promise });
  const starting = f.command("start"); await f.resumeEntered;
  clock.advance(19); await settle();
  assert.deepEqual(f.errors(), []);
  clock.advance(1); await starting; await settle();
  assert.equal(f.errors().length, 1, "a timeout processed before stop is a legitimate error");
  assert.match(f.errors()[0].event.message, /麦克风音频未能启动/);
  await f.command("stop"); await f.command("stop");
  if (late === "resolve") resumed.resolve(); else resumed.reject(Error("Late audio rejection"));
  clock.advance(20); await settle();
  assert.equal(clock.pending(), 0);
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.errors().length, 1);
  assert.equal(f.reports.some(record => record.event.type === "ready"), false);
  assert.deepEqual(f.audio(), []);
});

test("native IPC backpressure aborts capture at the bounded queue rather than losing audio silently", async t => {
  const sending = deferred();
  const f = fixture(t, { report: (_id, event) => event.type === "audio" ? sending.promise : true });
  await f.command("start"); await f.command("activate");
  f.contexts[0].pump(); await settle();
  for (let index = 0; index < 9; index++) f.contexts[0].pump();
  assert.equal(f.streams[0].track.stops, 1, "overflow immediately stops microphone capture");
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.audio().length, 1, "only one IPC audio request may be in flight");
  sending.resolve(true); await settle();
  assert.equal(f.errors().length, 1);
  assert.match(f.errors()[0].event.message, /阻塞/);
});

test("new capture replaces old capture and stale activate/stop commands cannot affect it", async t => {
  const f = fixture(t);
  await f.command("start", "old"); await f.command("activate", "old");
  await f.command("start", "new");
  assert.equal(f.streams[0].track.stops, 1);
  await f.command("stop", "old"); await f.command("activate", "old");
  assert.equal(f.streams[1].track.stops, 0);
  f.contexts[1].pump(); await settle(); assert.deepEqual(f.audio(), []);
  await f.command("activate", "new"); f.contexts[1].pump(); await settle();
  assert.deepEqual(f.audio().map(record => record.id), ["new"]);
});

test("hidden or closed pet emits ended and releases resources; collapsing its panel does not stop visible capture", async t => {
  const f = fixture(t);
  await f.command("start"); await f.command("activate");
  await f.command("start"); assert.equal(f.streams.length, 1, "duplicate starts are idempotent");
  assert.equal(f.streams[0].track.stops, 0, "capture depends on window visibility, not panel expansion");
  f.visible(false); f.control.hidden(); await settle();
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.reports.filter(record => record.event.type === "ended").length, 1);
  f.contexts[0].pump(); await settle(); assert.deepEqual(f.audio(), []);
});

test("a removed microphone produces a normal ended event and no later audio", async t => {
  const f = fixture(t);
  await f.command("start"); await f.command("activate");
  f.streams[0].track.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.reports.filter(record => record.event.type === "ended").length, 1);
  assert.deepEqual(f.errors(), []);
});

test("microphone denial and audio transport failure clean capture and allow retry", async t => {
  let deny = true;
  const f = fixture(t, { getUserMedia: () => deny ? Promise.reject(Error("Permission denied")) : f.stream(), report: (_id, event) => event.type === "audio" ? Promise.reject(Error("IPC gone")) : true });
  await f.command("start"); await settle(); assert.equal(f.errors().length, 1);
  deny = false; await f.command("start", "retry"); await f.command("activate", "retry");
  f.contexts[0].pump(); await settle();
  assert.equal(f.streams[0].track.stops, 1);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.errors().length, 2);
});

test("a hidden or insecure pet refuses capture after validating native intent", async t => {
  const f = fixture(t, { secure: false });
  await f.command("start"); await settle();
  assert.deepEqual(f.requests, []);
  assert.equal(f.errors().length, 1);
});
