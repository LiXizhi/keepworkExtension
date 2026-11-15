const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(process.env.AICHAT_PET_RENDERER_BASELINE || path.join(__dirname, "../src/pet.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
};
const snapshot = (extra = {}) => ({
  version: 1,
  context: "persona:alice",
  target: "persona",
  expanded: true,
  ready: false,
  draft: "",
  attention: "请在 AIChat 中连接本机服务和第二大脑。",
  ...extra,
});

async function renderer(initial = snapshot(), { speech } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = new Map();
  const resizeObservers = [];
  const surfaceIds = ["pet", "panel", "bubble", "compact-controls", "exit-bubble", "permission-bubble"];
  const defaultRects = {
    pet: { left: 800, top: 650, width: 112, height: 128 },
    panel: { left: 560, top: 430, width: 348, height: 190 },
    bubble: { left: 550, top: 200, width: 348, height: 100 },
    "compact-controls": { left: 780, top: 620, width: 100, height: 40 },
    "exit-bubble": { left: 550, top: 300, width: 348, height: 220 },
    "permission-bubble": { left: 500, top: 250, width: 348, height: 210 },
  };
  let frameId = 0;
  let elapsed = 0;
  let current = initial;
  let publish;
  let handler;
  const calls = [];
  const regionCalls = [];
  const pointerHolds = [];
  const captures = [];
  const releasedCaptures = [];
  const bodyClasses = new Set();
  function addListener(listeners, type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  }
  function dispatch(listeners, type, event = {}) {
    for (const callback of listeners.get(type) || []) callback({ type, preventDefault() {}, stopPropagation() {}, ...event });
  }
  function visible(element) {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden) return false;
    }
    return true;
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); resizeObservers.push(this); }
    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
  }
  const document = {
    hidden: false,
    visibilityState: "visible",
    querySelectorAll: () => [],
    addEventListener(type, callback) { addListener(documentListeners, type, callback); },
    body: { style: { setProperty() {} }, classList: {
      add(...names) { for (const name of names) bodyClasses.add(name); },
      remove(...names) { for (const name of names) bodyClasses.delete(name); },
    } },
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
        const classes = new Set();
        elements.set(id, {
          id, style: {}, dataset: {}, children: [], value: "", textContent: "", disabled: false,
          hidden: ["remote-recording-status", "remote-transcribing-status", "remote-voice-preview"].includes(id) || (surfaceIds.includes(id) && id !== "pet"),
          rect: { left: 0, top: 0, width: 0, height: 0, ...defaultRects[id] },
          scrollTop: 0, scrollHeight: 100, clientHeight: 100,
          classList: {
            contains(name) { return classes.has(name); },
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            toggle(name, force = !classes.has(name)) {
              if (force) classes.add(name); else classes.delete(name);
              return force;
            },
          },
          setAttribute(key, value) { this[key] = value; },
          addEventListener(type, callback) { addListener(listeners, type, callback); },
          replaceChildren(...children) { this.children = children; },
          setPointerCapture(id) { captures.push(id); },
          releasePointerCapture(id) { releasedCaptures.push(id); },
          focus() { document.activeElement = this; },
          click() { if (!this.disabled) return this.onclick?.({}); },
          fire(type, event = {}) { return dispatch(listeners, type, { target: this, ...event }); },
          getBoundingClientRect() {
            return { ...this.rect, x: this.rect.left, y: this.rect.top,
              right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
          },
          getClientRects() { return visible(this) ? [this.getBoundingClientRect()] : []; },
          closest(selector) {
            if (selector.split(",").some(part => part.trim() === `#${this.id}`)) return this;
            return this.parentElement?.closest(selector) || null;
          },
        });
        if (surfaceIds.includes(id) && id !== "pet") {
          elements.get(id).parentElement = document.getElementById("stack");
        }
        if (["draft", "send", "target", "dictation", "call"].includes(id)) {
          elements.get(id).parentElement = document.getElementById("panel");
        }
      }
      return elements.get(id);
    },
    createElement() { return { textContent: "", disabled: false }; },
  };
  const api = {
    subscribe(callback) { publish = callback; },
    async action(name, args = {}) {
      if (name === "state") return current;
      if (name === "hit-regions") { regionCalls.push(JSON.parse(JSON.stringify(args))); return { ok: true }; }
      if (name === "pointer-hold") { pointerHolds.push(JSON.parse(JSON.stringify(args))); return { ok: true }; }
      calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (handler) return handler(name, args);
      if (name === "expand") {
        current = { ...current, expanded: args.expanded };
        publish(current);
      }
      if (name === "input") current = { ...current, draft: args.text };
      if (name === "send") current = { ...current, draft: "" };
      return current;
    },
  };
  const window = {
    desktopPet: api, innerWidth: 1000, innerHeight: 800,
    addEventListener(type, callback) { addListener(windowListeners, type, callback); },
    matchMedia: () => ({ matches: true }),
    getSelection: () => null, clearTimeout, ...speech?.browser,
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    },
  };
  const modules = new Map();
  const nativeCalls = [];
  const sandbox = {
    exports: {},
    require(name) {
      if (name === "@tauri-apps/api/core") return {
        async invoke(command, args) { nativeCalls.push({ command, args: JSON.parse(JSON.stringify(args)) }); },
      };
      if (name === "./petAudio") return { installPetAudioCapture() {} };
      if (!name.startsWith("./")) return {};
      if (!modules.has(name)) {
        const moduleSource = fs.readFileSync(path.join(__dirname, "../src", name + ".ts"), "utf8");
        const code = ts.transpileModule(moduleSource, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports = {};
        vm.runInNewContext(code, { ...sandbox, exports });
        modules.set(name, exports);
      }
      return modules.get(name);
    },
    window, setTimeout, clearTimeout, Date, ...speech?.browser,
    document,
    performance: { now: () => performance.now() + elapsed },
    ResizeObserver,
    getComputedStyle: element => ({ display: visible(element) ? "block" : "none", visibility: "visible" }),
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.runInNewContext(javascript, sandbox);
  await settle();
  async function flushFrame() {
    await settle();
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
    await settle();
  }
  async function flushLayout() {
    for (let i = 0; frames.size && i < 10; i++) {
      await flushFrame();
    }
  }
  await flushLayout();
  return {
    element: id => document.getElementById(id),
    calls,
    regionCalls,
    nativeCalls,
    pointerHolds,
    captures,
    releasedCaptures,
    bodyHasClass: name => bodyClasses.has(name),
    flushFrame,
    frameCount: () => frames.size,
    advanceClock(ms) { elapsed += ms; },
    flushLayout,
    focusedId() { return document.activeElement?.id; },
    documentEvent(type, event) { dispatch(documentListeners, type, event); },
    setHidden(hidden) {
      document.hidden = hidden;
      document.visibilityState = hidden ? "hidden" : "visible";
      dispatch(documentListeners, "visibilitychange");
    },
    windowEvent(type, event) { dispatch(windowListeners, type, event); },
    resizeObserved() {
      for (const observer of resizeObservers) observer.callback([...observer.observed].map(target => ({ target })));
    },
    setRect(id, rect) { Object.assign(document.getElementById(id).rect, rect); },
    publish(extra) { current = { ...current, ...extra }; publish(current); },
    handle(callback) { handler = callback; },
    input(text) {
      const draft = document.getElementById("draft");
      assert.equal(draft.disabled, false, "plain-text composer must accept input");
      draft.value = text;
      draft.fire("input");
    },
  };
}

function speechBrowser() {
  const utterances = [];
  const actions = [];
  const systemVoice = { name: "Fixture voice", lang: "en-US", localService: true, default: true };
  const synth = {
    speaking: false,
    paused: false,
    getVoices: () => [systemVoice],
    speak(utterance) {
      utterances.push(utterance);
      this.speaking = true;
      queueMicrotask(() => utterance.onstart?.({ type: "start" }));
    },
    pause() { this.paused = true; actions.push("pause"); },
    resume() { this.paused = false; actions.push("resume"); },
    cancel() { this.speaking = false; this.paused = false; actions.push("cancel"); },
  };
  return {
    browser: {
      speechSynthesis: synth,
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    },
    actions, utterances,
    finish() {
      synth.speaking = false;
      utterances.at(-1)?.onend?.({ type: "end" });
    },
  };
}

const petTurn = (extra = {}) => snapshot({
  target: "session", context: "session:fixture", petReplyPresentationVersion: 1,
  ready: true, draft: "A question", attention: "", ...extra,
});

async function beginPetTurn(pet, extra = {}) {
  pet.handle(name => {
    assert.equal(name, "send");
    return petTurn({ expanded: false, draft: "", sentRequestId: "pet-turn-1", ...extra });
  });
  pet.element("send").click();
  await settle();
  pet.publish({ expanded: false, busy: true, draft: "", reply: { thinking: true, text: "Reasoning preview" } });
}

const finalPetReply = (text, extra = {}) => ({
  draft: "", expanded: false, busy: false,
  reply: { requestId: "pet-turn-1", thinking: false, text, speechText: text, options: [], ...extra },
});

test("pet send collapses and starts waiting before its command acknowledgement", async () => {
  const pet = await renderer(petTurn({ reply: { text: "Previous reply" } }));
  let acknowledge;
  pet.handle(name => {
    assert.equal(name, "send");
    return new Promise(resolve => { acknowledge = resolve; });
  });
  pet.element("send").click();
  // The UI must react before the host, including when the desktop bridge is slow.
  await settle();
  assert.equal(pet.element("panel").hidden, true);
  assert.equal(pet.element("bubble").hidden, false);
  assert.equal(pet.element("thinking").hidden, false);
  assert.equal(pet.element("bubble").classList.contains("thinking"), true);
  pet.publish({ expanded: true, reply: { text: "Previous reply" } });
  assert.equal(pet.element("panel").hidden, true, "a queued pre-send snapshot cannot reopen the composer");
  assert.equal(pet.element("bubble").classList.contains("thinking"), true);
  acknowledge(petTurn({ draft: "", expanded: false, sentRequestId: "pet-turn-1" }));
  await settle();
  assert.equal(pet.element("bubble").classList.contains("thinking"), true);
  assert.equal(pet.calls.filter(call => call.name === "send").length, 1);
});

test("pet reply narrates matched final prose once, pauses and resumes on click, and dismisses at speech end", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const speech = speechBrowser();
  const pet = await renderer(petTurn({ reply: { text: "An older answer" } }), { speech });
  await beginPetTurn(pet);
  pet.publish({ busy: true, reply: { text: "Partial response", requestId: "pet-turn-1" } });
  assert.equal(speech.utterances.length, 0, "old, reasoning, and partial replies must stay silent");
  const final = finalPetReply("Hello! ![diagram](https://example.test/chart.png)", { speechText: "Hello!" });
  pet.publish(final);
  await settle();
  assert.deepEqual(speech.utterances.map(u => u.text), ["Hello!"]);
  assert.equal(pet.element("bubble").hidden, false);
  assert.equal(pet.element("bubble").classList.contains("thinking"), false);
  pet.publish({ ...final, attention: "another snapshot" });
  await settle();
  assert.equal(speech.utterances.length, 1);
  pet.element("reply").click();
  t.mock.timers.tick(60_000);
  assert.equal(pet.element("bubble").hidden, false, "paused audio keeps its reply visible");
  pet.element("reply").click();
  assert.deepEqual(speech.actions.filter(action => action !== "cancel"), ["pause", "resume"]);
  assert.equal(pet.calls.some(call => call.name === "open"), false);
  speech.finish();
  await settle();
  assert.equal(pet.element("bubble").hidden, true);
  pet.publish(final);
  assert.equal(pet.element("bubble").hidden, true, "an identical later snapshot cannot resurrect a finished reply");
  assert.equal(speech.utterances.length, 1);
});

test("pet reply without narration expires by text length and preserves quick reply options", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  async function timedReply(text, options = []) {
    const pet = await renderer(petTurn());
    await beginPetTurn(pet);
    pet.publish(finalPetReply(text, { options }));
    await settle();
    assert.equal(pet.element("reply").hidden, false);
    return pet;
  }
  const short = await timedReply("Yes.");
  const long = await timedReply("A longer answer for the reader to finish. ".repeat(12), [{ text: "Continue" }]);
  let shortExpiry;
  let longExpiry;
  for (let seconds = 1; seconds <= 20; seconds++) {
    t.mock.timers.tick(1000);
    await settle();
    if (shortExpiry === undefined && short.element("bubble").hidden) shortExpiry = seconds;
    if (longExpiry === undefined && long.element("reply").hidden) longExpiry = seconds;
  }
  assert.ok(shortExpiry >= 2 && shortExpiry < longExpiry && longExpiry <= 20,
    `expected short then long expiry, got ${shortExpiry}s and ${longExpiry}s`);
  assert.equal(long.element("bubble").hidden, false);
  assert.equal(long.element("options").children[0].disabled, false);
});

test("pet reply binds a fast final to the acknowledged send and respects empty spoken text", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const speechText of ["Matched answer", ""]) {
    const speech = speechBrowser();
    const pet = await renderer(petTurn(), { speech });
    let acknowledge;
    pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
    pet.element("send").click();
    await settle();
    pet.publish(finalPetReply("Another turn", { requestId: "other-request" }));
    assert.equal(speech.utterances.length, 0);
    const final = finalPetReply(speechText || "![image](https://example.test/photo.jpg)", { speechText });
    pet.publish(final);
    acknowledge(petTurn({ ...final, sentRequestId: "pet-turn-1" }));
    await settle();
    assert.deepEqual(speech.utterances.map(u => u.text), speechText ? [speechText] : []);
    assert.equal(pet.element("bubble").classList.contains("thinking"), false);
    speech.finish();
  }
});

test("pet reply from a legacy page uses the sent turn's busy transition before speaking", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const speech = speechBrowser();
  const initial = snapshot({ ready: true, draft: "Hello", reply: { text: "Previous turn" } });
  const pet = await renderer(initial, { speech });
  pet.handle(() => ({ ...initial, draft: "", expanded: false }));
  pet.element("send").click();
  await settle();
  pet.publish({ expanded: false, draft: "", busy: false });
  assert.equal(speech.utterances.length, 0);
  pet.publish({ busy: true, reply: { thinking: true, text: "private reasoning" } });
  pet.publish({ busy: false, reply: { text: "Final words ![picture](https://example.test/x.png)" } });
  await settle();
  assert.deepEqual(speech.utterances.map(u => u.text.trim()), ["Final words"]);
  speech.finish();
});

test("pet reply keeps thinking while busy, bounds an idle wait and still speaks a late tagged result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const speech = speechBrowser();
  const pet = await renderer(petTurn(), { speech });
  await beginPetTurn(pet);
  t.mock.timers.tick(180_001);
  assert.equal(pet.element("thinking").hidden, false, "the page is still actively generating");
  pet.publish({ busy: false, reply: null });
  assert.equal(pet.element("thinking").hidden, true);
  pet.publish(finalPetReply("A late result"));
  await settle();
  assert.equal(pet.element("reply").hidden, false);
  assert.deepEqual(speech.utterances.map(u => u.text), ["A late result"]);
  speech.finish();
});

test("pet reply shows untagged coalesced or external answers silently without reviving expired text", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const speech = speechBrowser();
  const initial = snapshot({ ready: true, draft: "Hello", reply: { text: "Previous" } });
  const pet = await renderer(initial, { speech });
  pet.handle(() => ({ ...initial, draft: "", expanded: false }));
  pet.element("send").click();
  await settle();
  const first = { text: "An answer without a busy transition" };
  pet.publish({ expanded: false, draft: "", reply: first, busy: false });
  assert.equal(pet.element("reply").textContent, first.text);
  assert.equal(pet.element("reply").hidden, false);
  t.mock.timers.tick(16_000);
  const external = { text: "What next?", options: [{ text: "Continue" }] };
  pet.publish({ reply: external });
  assert.equal(pet.element("reply").textContent, external.text);
  assert.equal(pet.element("options").children[0].disabled, false);
  pet.publish({ reply: first });
  assert.ok(pet.element("reply").hidden || pet.element("reply").textContent !== first.text);
  assert.deepEqual(speech.utterances, []);
});

test("pet send failure restores the composer and draft without speaking or retrying", async () => {
  const speech = speechBrowser();
  const pet = await renderer(petTurn(), { speech });
  pet.handle((name, args) => {
    if (name === "expand") return petTurn({ expanded: args.expanded });
    assert.equal(name, "send");
    throw Error("Send rejected");
  });
  pet.element("send").click();
  await settle();
  assert.equal(pet.element("panel").hidden, false);
  assert.equal(pet.element("draft").value, "A question");
  assert.match(pet.element("error").textContent, /Send rejected/);
  assert.equal(pet.element("bubble").hidden, true);
  assert.equal(speech.utterances.length, 0);
  assert.equal(pet.calls.filter(call => call.name === "send").length, 1);
});

test("pet quick reply sends immediately or opens the editable composer as requested", async () => {
  for (const immediate of [true, false]) {
    const initial = petTurn({ expanded: false, draft: "", reply: { text: "Choose", immediate, options: [{ text: "Continue" }] } });
    const pet = await renderer(initial);
    await pet.element("options").children[0].onclick();
    await settle();
    assert.deepEqual(pet.calls.filter(call => ["input", "send"].includes(call.name)).map(call => call.name),
      immediate ? ["input", "send"] : ["input"]);
    assert.equal(pet.element("panel").hidden, immediate);
    if (immediate) assert.equal(pet.element("bubble").classList.contains("thinking"), true);
    else assert.equal(pet.element("draft").value, "Continue");
  }
});

test("pet reply stops narration on native hide or context change and ignores a late speech event", async () => {
  for (const leave of ["native-hide", "document-hide", "context"]) {
    const speech = speechBrowser();
    const pet = await renderer(petTurn(), { speech });
    await beginPetTurn(pet);
    const final = finalPetReply("Read this answer");
    pet.publish(final);
    await settle();
    assert.equal(speech.utterances.length, 1);
    if (leave === "native-hide") pet.windowEvent("aichat:pet-hidden");
    else if (leave === "document-hide") pet.setHidden(true);
    else pet.publish({ context: "session:other", busy: false, reply: null });
    await settle();
    assert.ok(speech.actions.includes("cancel"), `speech must stop on ${leave}`);
    speech.finish();
    await settle();
    assert.equal(speech.utterances.length, 1);
    assert.equal(pet.element("bubble").hidden, true);
  }
});

const sharedTurn = (extra = {}) => petTurn({ petStreamingSpeechVersion: 1, ...extra });
const sharedSpeech = (state, text = "", requestId = "pet-turn-1") => ({ requestId, state, text });

async function sharedPet() {
  const system = speechBrowser();
  const pet = await renderer(sharedTurn(), { speech: system });
  pet.handle(name => name === "send"
    ? sharedTurn({ expanded: false, draft: "", sentRequestId: "pet-turn-1" }) : null);
  pet.element("send").click();
  await settle();
  return { pet, system };
}

test("shared pet speech displays live prose before the final reply and controls that same turn", async () => {
  const { pet, system } = await sharedPet();
  const first = "A full sentence is available now.";
  const more = first + " The answer continues.";
  pet.publish({ expanded: false, busy: true, reply: null, petSpeech: sharedSpeech("waiting") });
  assert.equal(pet.element("thinking").hidden, false);
  pet.publish({ busy: true, reply: null, petSpeech: sharedSpeech("speaking", first) });
  assert.equal(pet.element("thinking").hidden, true);
  assert.equal(pet.element("reply").hidden, false);
  assert.equal(pet.element("reply").textContent, first);
  assert.match(pet.element("reply").title, /暂停/);
  let releasePause;
  pet.handle(name => name === "pause-speech" ? new Promise(resolve => { releasePause = resolve; }) : null);
  pet.element("reply").click();
  pet.element("reply").click();
  await settle();
  assert.equal(pet.calls.filter(c => c.name === "pause-speech").length, 1);
  pet.publish({ busy: true, petSpeech: sharedSpeech("paused", more) });
  releasePause(null);
  await settle();
  assert.match(pet.element("reply").title, /继续|恢复/);
  assert.equal(pet.element("reply").textContent, more);
  pet.element("reply").click();
  await settle();
  const controls = pet.calls.filter(call => call.name.endsWith("-speech"));
  assert.deepEqual(controls.map(call => call.name), ["pause-speech", "resume-speech"]);
  assert.ok(controls.every(call => call.args.context === "session:fixture" && call.args.speechRequestId === "pet-turn-1"));
  assert.equal(pet.calls.some(call => call.name === "open"), false);
  pet.publish({ ...finalPetReply(more), petSpeech: sharedSpeech("speaking", more) });
  assert.equal(pet.element("reply").hidden, false, "receiving the final text must keep ongoing playback visible");
  pet.publish({ petSpeech: sharedSpeech("ended", more) });
  assert.equal(pet.element("bubble").hidden, true);
  assert.deepEqual(system.utterances, [], "shared SDK speech must never be replayed through the system voice");
});

test("shared pet speech binds pre-ack snapshots to the originating request and ignores foreign IDs", async () => {
  const system = speechBrowser();
  const pet = await renderer(sharedTurn(), { speech: system });
  let acknowledge;
  pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
  pet.element("send").click();
  await settle();
  pet.publish({ expanded: false, busy: true, petSpeech: sharedSpeech("speaking", "Someone else's turn", "other") });
  assert.equal(pet.element("reply").hidden, true);
  pet.publish({ petSpeech: sharedSpeech("speaking", "The first phrase") });
  assert.equal(pet.element("reply").hidden, true);
  acknowledge(sharedTurn({ expanded: false, draft: "", busy: true, sentRequestId: "pet-turn-1" }));
  await settle();
  assert.equal(pet.element("reply").textContent, "The first phrase");
  assert.equal(pet.element("reply").hidden, false);
  pet.publish({ petSpeech: sharedSpeech("ended", "Stale completion", "other") });
  assert.equal(pet.element("reply").textContent, "The first phrase");
  assert.equal(pet.element("reply").hidden, false);
  pet.windowEvent("aichat:pet-hidden");
  assert.deepEqual(system.utterances, []);
});

test("shared pet speech stays dismissed when audio ends before the final snapshot or after hiding", async () => {
  for (const finish of ["ended", "native-hide", "context-change"]) {
    const { pet, system } = await sharedPet();
    pet.publish({ busy: true, reply: null, petSpeech: sharedSpeech("speaking", "Audio first.") });
    assert.equal(pet.element("reply").hidden, false);
    if (finish === "ended") pet.publish({ busy: true, petSpeech: sharedSpeech("ended", "Audio first.") });
    if (finish === "native-hide") pet.windowEvent("aichat:pet-hidden");
    if (finish === "context-change") pet.publish({ context: "session:next", busy: false, reply: null, petSpeech: null });
    const oldTurn = { ...finalPetReply("Audio first."), petSpeech: sharedSpeech("ended", "Audio first.") };
    pet.publish(oldTurn);
    await settle();
    assert.equal(pet.element("bubble").hidden, true, `late final after ${finish} revived the reply`);
    assert.deepEqual(system.utterances, []);
  }
});

test("shared pet speech cancels the original send if its acknowledgment arrives after switching conversations", async () => {
  const system = speechBrowser();
  const pet = await renderer(sharedTurn(), { speech: system });
  let acknowledge;
  pet.handle(name => name === "send" ? new Promise(resolve => { acknowledge = resolve; }) : null);
  pet.element("send").click();
  await settle();
  pet.publish({ context: "session:next", busy: false, reply: null, petSpeech: null });
  assert.equal(pet.calls.some(call => call.name === "cancel-speech"), false);
  acknowledge(sharedTurn({ expanded: false, draft: "", sentRequestId: "pet-turn-1" }));
  await settle();
  const cancels = pet.calls.filter(call => call.name === "cancel-speech");
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].args.context, "session:fixture");
  assert.equal(cancels[0].args.speechRequestId, "pet-turn-1");
  assert.equal(pet.element("bubble").hidden, true);
  assert.deepEqual(system.utterances, []);
});

test("shared pet speech falls back to timed text if the configured voice is unavailable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { pet, system } = await sharedPet();
  pet.publish({ busy: true, petSpeech: sharedSpeech("unavailable") });
  pet.publish({ ...finalPetReply("The written answer"), petSpeech: sharedSpeech("unavailable") });
  assert.equal(pet.element("reply").textContent, "The written answer");
  assert.equal(pet.element("reply").hidden, false);
  assert.deepEqual(system.utterances, []);
  t.mock.timers.tick(16_000);
  assert.equal(pet.element("bubble").hidden, true);
});

test("offline and legacy pet snapshots allow typing while remote actions stay unavailable", async () => {
  for (const ready of [false, undefined]) {
    const pet = await renderer(snapshot({ ready }));
    assert.equal(pet.element("draft").disabled, false);
    for (const id of ["send", "dictation", "call"]) assert.equal(pet.element(id).disabled, true);
    pet.input("离线记录，稍后发送");
    await settle();
    pet.publish({ draft: "", attention: "等待本机服务" });
    assert.equal(pet.element("draft").value, "离线记录，稍后发送");
    assert.deepEqual(pet.calls, [], "offline edits must stay local");
  }
});

test("ready pet voice buttons forward the current persona or session context", async () => {
  for (const [context, target] of [["persona:alice", "persona"], ["session:legacy", "session"]]) {
    const pet = await renderer(snapshot({ context, target, ready: true, canCall: true, attention: "" }));
    assert.equal(pet.element("dictation").disabled, false);
    assert.equal(pet.element("call").disabled, false);
    assert.equal(pet.element("dictation").textContent, "语音输入");
    assert.equal(pet.element("call").textContent, "通话");
    pet.element("dictation").click();
    await settle();
    pet.element("call").click();
    await settle();
    assert.deepEqual(pet.calls, [
      { name: "dictation", args: { context } },
      { name: "call", args: { context } },
    ]);
  }
});

test("recovering pet readiness enables voice without starting capture automatically", async () => {
  const pet = await renderer(snapshot({ canCall: true }));
  pet.element("dictation").click();
  pet.element("call").click();
  await settle();
  assert.deepEqual(pet.calls, []);
  pet.publish({ ready: true, attention: "" });
  await settle();
  assert.equal(pet.element("dictation").disabled, false);
  assert.equal(pet.element("call").disabled, false);
  assert.deepEqual(pet.calls, [], "a restored page snapshot must not replay media actions");
  pet.element("dictation").click();
  await settle();
  assert.deepEqual(pet.calls, [{ name: "dictation", args: { context: "persona:alice" } }]);
});

test("dictation excludes calls and rich drafts while remaining stoppable", async () => {
  const pet = await renderer(snapshot({ ready: true, canCall: true, dictating: true, attention: "" }));
  assert.equal(pet.element("dictation").textContent, "停止输入");
  assert.equal(pet.element("dictation").disabled, false);
  assert.equal(pet.element("call").disabled, true);
  pet.element("call").click();
  pet.element("dictation").click();
  await settle();
  assert.deepEqual(pet.calls, [{ name: "dictation", args: { context: "persona:alice" } }]);
  pet.publish({ dictating: false, richDraft: true });
  assert.equal(pet.element("dictation").disabled, true);
  pet.element("dictation").click();
  await settle();
  assert.equal(pet.calls.length, 1);
});

test("missing call capability permits dictation and still allows an active call to stop", async () => {
  for (const canCall of [false, undefined]) {
    const pet = await renderer(snapshot({ ready: true, canCall, attention: "" }));
    assert.equal(pet.element("dictation").disabled, false);
    assert.equal(pet.element("call").disabled, true);
    pet.element("call").click();
    await settle();
    assert.deepEqual(pet.calls, []);

    pet.publish({ voice: { active: true, muted: false, state: "listening" } });
    assert.equal(pet.element("dictation").disabled, true);
    assert.equal(pet.element("call").disabled, false);
    assert.equal(pet.element("call").textContent, "结束通话");
    assert.equal(pet.element("mute").hidden, false);
    pet.element("dictation").click();
    pet.element("mute").click();
    await settle();
    pet.element("call").click();
    await settle();
    assert.deepEqual(pet.calls, [
      { name: "mute", args: { context: "persona:alice" } },
      { name: "call", args: { context: "persona:alice" } },
    ]);
  }
});

test("microphone permission failures stay visible without replaying the request", async () => {
  const pet = await renderer(snapshot({ ready: true, canCall: true, attention: "" }));
  pet.handle(async () => { throw new Error("麦克风权限被拒绝，请在系统设置中允许访问"); });
  pet.element("dictation").click();
  await settle();
  assert.equal(pet.calls.length, 1);
  assert.match(pet.element("error").textContent, /麦克风权限被拒绝/);
  pet.publish({ ready: true });
  await settle();
  assert.equal(pet.calls.length, 1);
  assert.match(pet.element("error").textContent, /麦克风权限被拒绝/);
});

test("reconnect retains the offline draft and only explicit send synchronizes then sends it", async () => {
  const pet = await renderer();
  pet.input("重连后保留的草稿");
  await settle();
  pet.publish({ ready: true, draft: "", attention: "" });
  await settle();
  assert.equal(pet.element("draft").value, "重连后保留的草稿");
  assert.deepEqual(pet.calls, [], "reconnect must not replay edits or send automatically");
  pet.element("send").click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input", "send"]);
  assert.equal(pet.calls[0].args.text, "重连后保留的草稿");
  assert.equal(pet.calls[0].args.context, "persona:alice");
});

test("failed draft synchronization retains text and does not send", async () => {
  const pet = await renderer();
  pet.input("不能丢失的内容");
  pet.publish({ ready: true, draft: "", attention: "" });
  pet.handle(async name => {
    if (name === "input") throw new Error("本机服务已断开");
    throw new Error(`unexpected action ${name}`);
  });
  pet.element("send").click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
  assert.equal(pet.element("draft").value, "不能丢失的内容");
  assert.match(pet.element("error").textContent, /本机服务已断开/);
});

test("pending online input survives stale snapshots and send waits for its acknowledgement", async () => {
  const pet = await renderer(snapshot({ ready: true, attention: "" }));
  let acknowledge;
  pet.handle((name, args) => {
    if (name === "input") return new Promise(resolve => { acknowledge = resolve; });
    return snapshot({ ready: true, draft: "", attention: "" });
  });
  pet.input("等待确认的输入");
  await settle();
  pet.publish({ draft: "" });
  assert.equal(pet.element("draft").value, "等待确认的输入");
  pet.element("send").click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
  acknowledge(snapshot({ ready: true, draft: "等待确认的输入", attention: "" }));
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input", "send"]);
});

test("changing context discards the old local draft without sending it to the new owner", async () => {
  const pet = await renderer();
  pet.input("Alice 的离线草稿");
  await settle();
  pet.publish({ context: "persona:bob", ready: true, draft: "Bob 的草稿", attention: "" });
  assert.equal(pet.element("draft").value, "Bob 的草稿");
  assert.deepEqual(pet.calls, []);
  pet.element("send").click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["send"]);
  assert.equal(pet.calls[0].args.context, "persona:bob");
});

test("a late acknowledgement from a previous context cannot restore or send its draft", async () => {
  const pet = await renderer(snapshot({ ready: true, attention: "" }));
  let acknowledge;
  pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
  pet.input("Alice 的待确认输入");
  await settle();
  pet.element("send").click();
  await settle();
  pet.publish({ context: "persona:bob", ready: true, draft: "Bob 的草稿", attention: "" });
  acknowledge(snapshot({ ready: true, draft: "Alice 的待确认输入", attention: "" }));
  await settle();
  assert.equal(pet.element("draft").value, "Bob 的草稿");
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
});

test("an earlier online acknowledgement cannot discard edits made after disconnect", async () => {
  const pet = await renderer(snapshot({ ready: true, attention: "" }));
  let acknowledge;
  let count = 0;
  pet.handle((name, args) => {
    if (name === "input" && count++ === 0) return new Promise(resolve => { acknowledge = resolve; });
    return snapshot({ ready: true, draft: name === "input" ? args.text : "", attention: "" });
  });
  pet.input("在线输入");
  await settle();
  pet.publish({ ready: false, draft: "" });
  pet.input("断开后继续编辑的新内容");
  acknowledge(snapshot({ ready: false, draft: "在线输入" }));
  await settle();
  assert.equal(pet.element("draft").value, "断开后继续编辑的新内容");
  pet.publish({ ready: true, draft: "在线输入", attention: "" });
  pet.element("send").click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input", "input", "send"]);
  assert.equal(pet.calls[1].args.text, "断开后继续编辑的新内容");
});

test("editing while send synchronizes a draft requires another explicit send", async () => {
  const pet = await renderer();
  let acknowledge;
  let count = 0;
  pet.handle((name, args) => {
    if (name === "input" && count++ === 0) return new Promise(resolve => { acknowledge = resolve; });
    return snapshot({ ready: true, draft: args.text, attention: "" });
  });
  pet.input("点击发送前的草稿");
  pet.publish({ ready: true, draft: "", attention: "" });
  pet.element("send").click();
  await settle();
  pet.input("点击发送后继续编辑的内容");
  acknowledge(snapshot({ ready: true, draft: "点击发送前的草稿", attention: "" }));
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input", "input"]);
  assert.equal(pet.element("draft").value, "点击发送后继续编辑的内容");
});

test("rich drafts and active dictation still prevent text editing", async () => {
  const pet = await renderer();
  for (const extra of [
    { ready: false, richDraft: true, dictating: false },
    { ready: true, richDraft: true, dictating: false },
    { ready: false, richDraft: false, dictating: true },
    { ready: true, richDraft: false, dictating: true },
  ]) {
    pet.publish(extra);
    assert.equal(pet.element("draft").disabled, true);
  }
});

test("IME composition and Shift+Enter never submit the draft", async () => {
  const pet = await renderer(snapshot({ ready: true, attention: "" }));
  let prevented = 0;
  for (const event of [{ isComposing: true }, { shiftKey: true }]) {
    pet.element("draft").fire("keydown", {
      key: "Enter", preventDefault() { prevented++; }, ...event,
    });
  }
  await settle();
  assert.equal(prevented, 0);
  assert.deepEqual(pet.calls, []);
});

function remoteBack(pet, context = "persona:alice") {
  pet.windowEvent("aichat:remote-back", { detail: { context } });
}

test("remote Back clears all visible text, collapses the empty composer, then temporarily hides the pet", async () => {
  const pet = await renderer(snapshot({ ready: true, draft: "  " }));
  for (let i = 0; i < 3; i++) remoteBack(pet);
  await settle();
  assert.equal(pet.element("draft").value, "");
  assert.equal(pet.element("panel").hidden, true);
  assert.deepEqual(pet.calls, [
    { name: "input", args: { text: "", context: "persona:alice" } },
    { name: "expand", args: { expanded: false, context: "persona:alice" } },
    { name: "hide-temporarily", args: { context: "persona:alice" } },
  ]);
});

test("remote Back counts a locally edited draft while offline and preserves a collapsed draft", async () => {
  const pet = await renderer();
  pet.input("本地草稿");
  remoteBack(pet);
  await settle();
  pet.publish({ draft: "旧草稿" });
  assert.equal(pet.element("draft").value, "");
  assert.equal(pet.element("panel").hidden, false);
  assert.deepEqual(pet.calls, []);
  remoteBack(pet);
  await settle();
  assert.equal(pet.element("panel").hidden, true);
  const collapsed = await renderer(snapshot({ expanded: false, ready: true, draft: "保留草稿" }));
  remoteBack(collapsed);
  await settle();
  assert.equal(collapsed.element("draft").value, "保留草稿");
  assert.deepEqual(collapsed.calls.map(call => call.name), ["hide-temporarily"]);
});

test("remote Back clears a pending edit immediately and sends its empty value after the earlier edit", async () => {
  const pet = await renderer(snapshot({ ready: true }));
  let acknowledge;
  pet.handle((name, args) => {
    if (args.text === "新输入") return new Promise(resolve => { acknowledge = resolve; });
    return snapshot({ ready: true, draft: args.text });
  });
  pet.input("新输入");
  await settle();
  remoteBack(pet);
  await settle();
  assert.equal(pet.element("draft").value, "");
  assert.deepEqual(pet.calls.map(call => call.args.text), ["新输入"]);
  pet.publish({ draft: "旧草稿" });
  assert.equal(pet.element("draft").value, "");
  acknowledge(snapshot({ ready: true, draft: "新输入" }));
  await settle();
  assert.deepEqual(pet.calls.map(call => call.args.text), ["新输入", ""]);
  assert.equal(pet.element("draft").value, "");
});

test("remote Back waits for draft writes and never applies queued presses to a new context", async () => {
  const pet = await renderer(snapshot({ ready: true, draft: "Alice" }));
  let acknowledge;
  pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
  remoteBack(pet);
  remoteBack(pet);
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
  pet.publish({ context: "persona:bob", draft: "Bob" });
  acknowledge(snapshot({ ready: true, draft: "" }));
  remoteBack(pet, "persona:alice");
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
  assert.equal(pet.element("draft").value, "Bob");
  assert.equal(pet.element("panel").hidden, false);
});

test("a queued Back press expires while a slow clear is in flight", async () => {
  const pet = await renderer(snapshot({ ready: true, draft: "旧输入" }));
  let acknowledge;
  pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
  remoteBack(pet);
  remoteBack(pet);
  await settle();
  pet.advanceClock(1500);
  acknowledge(snapshot({ ready: true, draft: "" }));
  await settle();
  assert.equal(pet.element("panel").hidden, false);
  assert.deepEqual(pet.calls.map(call => call.name), ["input"]);
});

test("a delayed temporary-hide action cannot hide the composer after it reopens", async () => {
  const pet = await renderer(snapshot({ ready: true, expanded: false, canCall: true }));
  let acknowledge;
  pet.handle(() => new Promise(resolve => { acknowledge = resolve; }));
  pet.element("call").click();
  await settle();
  remoteBack(pet);
  await settle();
  acknowledge(snapshot({ ready: true, expanded: true }));
  await settle();
  assert.equal(pet.element("panel").hidden, false);
  assert.deepEqual(pet.calls.map(call => call.name), ["call"]);
});

test("failed clear requires an acknowledged empty edit before Back collapses", async () => {
  const pet = await renderer(snapshot({ ready: true, draft: "未同步" }));
  pet.handle(() => { throw Error("同步失败"); });
  remoteBack(pet);
  await settle();
  assert.equal(pet.element("draft").value, "");
  pet.handle((name, args) => snapshot({ ready: true, draft: "", expanded: name !== "expand" }));
  remoteBack(pet);
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["input", "input"]);
  assert.equal(pet.element("panel").hidden, false);
  remoteBack(pet);
  await settle();
  assert.equal(pet.element("panel").hidden, true);
});

test("remote Back respects protected pet prompts and non-editable drafts", async () => {
  for (const extra of [
    { exitPrompt: { id: "exit", personas: [] } },
    { permission: { id: "capture", client: "QA" } },
    { richDraft: true },
    { dictating: true },
  ]) {
    const pet = await renderer(snapshot({ ready: true, draft: "保留", ...extra }));
    remoteBack(pet);
    await settle();
    assert.deepEqual(pet.calls, []);
    assert.equal(pet.element("draft").value, "保留");
  }
});

function surfaceIds(pet) {
  assert.ok(pet.regionCalls.length, "visible surfaces must be reported without mouse movement");
  return pet.regionCalls.at(-1).regions.map(region => region.id).filter(id => id !== "pet").sort();
}

function remoteVoiceFocus(pet, detail) {
  let accepted = false;
  pet.windowEvent("aichat:remote-voice-focus", {
    cancelable: true, detail,
    preventDefault() { accepted = true; },
  });
  return accepted;
}

const remoteDialogueId = "97f4a4c8-63a0-4607-9bcd-142aeef952b4";
function physicalDialogue(pet, action, id = remoteDialogueId) {
  const detail = { action, id };
  pet.windowEvent(action === "interrupt" ? "aichat:remote-dialogue" : "aichat:remote-dialogue-live", { detail });
  return detail.status;
}

test("physical Record interrupts an older page's ongoing system narration before a new recording", async () => {
  const speech = speechBrowser();
  const pet = await renderer(petTurn(), { speech });
  await beginPetTurn(pet);
  const final = finalPetReply("First reply is being read.");
  pet.publish(final);
  await settle();
  assert.equal(speech.utterances.length, 1);
  physicalDialogue(pet, "interrupt");
  assert.equal(speech.actions.at(-1), "cancel");
  speech.finish();
  pet.publish(final);
  await settle();
  assert.equal(speech.utterances.length, 1);
});

test("the pet displays the main phone phase without claiming audio or opening the composer", async () => {
  for (const source of ["desktop", "remote"]) {
    const pet = await renderer(petTurn({ expanded: false, ready: false, context: "persona:alice" }));
    const icon = pet.element("dialogue-icon");
    assert.equal(icon.hidden, true);
    for (const state of ["starting", "listening", "thinking", "speaking", "paused"]) {
      const status = source === "desktop" ? { phoneState: state } : { remoteDialogue: { id: remoteDialogueId, state } };
      pet.publish({ ...status, reply: { text: "Call transcript." }, attention: "Speaking", compactVoice: true });
      assert.equal(pet.element("panel").hidden, true);
      assert.equal(pet.element("bubble").hidden, true);
      assert.equal(pet.element("compact-controls").hidden, true);
      assert.equal(icon.hidden, false);
      assert.equal(icon.dataset.state, state);
      assert.equal(pet.element("badge").hidden, true);
      assert.match(icon.title, /语音通话 · /);
    }
    for (const action of ["enter", "record", "exit"]) assert.equal(physicalDialogue(pet, action), undefined);
    pet.windowEvent("aichat:pet-hidden");
    pet.setHidden(true);
    assert.equal(icon.hidden, true);
    pet.setHidden(false);
    assert.equal(icon.hidden, false);
    pet.windowEvent("pagehide");
    pet.publish({ context: "session:next" });
    assert.equal(icon.hidden, false);
    pet.publish({ phoneState: "", remoteDialogue: null });
    assert.equal(icon.hidden, true);
    assert.equal(pet.element("bubble").hidden, true);
    assert.deepEqual(pet.calls, []);
    assert.deepEqual(pet.nativeCalls, []);
  }
  const html = fs.readFileSync(path.join(__dirname, "../pet.html"), "utf8");
  assert.match(html, /<[^>]+id="dialogue-icon"[^>]*>\s*(?:☎|&#9742;|&#x260[eE];)/u);
});

test("phone start errors offer to open the desktop while the pet is collapsed", async () => {
  const pet = await renderer(petTurn({ expanded: false }));
  const button = pet.element("phone-error");
  pet.publish({ error: "Persona offline" });
  assert.equal(button.hidden, true);
  assert.equal(pet.element("bubble").hidden, true);
  pet.publish({ phoneError: "麦克风权限已拒绝" });
  assert.equal(button.hidden, false);
  assert.match(button.textContent, /麦克风权限已拒绝.*打开 AIChat/);
  assert.equal(pet.element("bubble").hidden, false);
  assert.equal(pet.element("panel").hidden, true);
  assert.equal(pet.element("draft").value, "A question");
  button.click();
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["open"]);
  pet.publish({ exitPrompt: { personas: [] } });
  assert.equal(pet.element("bubble").hidden, true);
  pet.publish({ exitPrompt: null, permission: { client: "fixture" } });
  assert.equal(pet.element("bubble").hidden, true);
  pet.publish({ permission: null, expanded: true });
  assert.equal(button.hidden, true);
  assert.match(pet.element("error").textContent, /麦克风权限已拒绝/);
  pet.publish({ expanded: false, phoneError: "" });
  assert.equal(pet.element("bubble").hidden, true);
});

test("existing pet persona calls retain their voice controls and phone status", async () => {
  const pet = await renderer(petTurn({ expanded: false, compactVoice: true, canCall: true,
    voice: { active: true, state: "listening" } }));
  assert.equal(pet.element("dialogue-icon").hidden, false);
  assert.equal(pet.element("compact-controls").hidden, false);
  assert.equal(pet.element("compact-call")["aria-pressed"], "true");
  pet.publish({ voice: { active: false } });
  assert.equal(pet.element("dialogue-icon").hidden, true);
});

test("partial remote dictation previews replace one another without entering the pet draft", async () => {
  const pet = await renderer(snapshot({ ready: true, expanded: false, draft: "已有的草稿" }));
  const preview = pet.element("remote-voice-preview");
  const draft = pet.element("draft");
  const phase = (name, detail) => pet.windowEvent("aichat:remote-voice-" + name, { detail });
  const show = (press, text) => phase("preview", { press, text });
  show(30, "延迟回调");
  assert.equal(preview.hidden, true);
  assert.equal(remoteVoiceFocus(pet, 31), true);
  phase("recording", 31);
  draft.selectionStart = 1;
  draft.selectionEnd = 3;
  pet.element("target").focus();
  const first = "第一句话。";
  const second = first + "第二句话包含小于号 <示例>。";
  show(31, first);
  assert.equal(preview.hidden, false);
  assert.equal(preview.textContent, first);
  show(31, second);
  pet.publish({ attention: "普通界面更新" });
  show(30, "上一轮结果");
  assert.equal(preview.textContent, second);
  assert.equal(preview.hidden, false);
  assert.equal(draft.value, "已有的草稿");
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [1, 3]);
  assert.equal(pet.focusedId(), "target");
  phase("transcribing", 31);
  phase("end", 31);
  show(31, "迟到的结果");
  assert.equal(preview.hidden, true);
  assert.equal(preview.textContent, "");
  assert.equal(remoteVoiceFocus(pet, 32), true);
  show(31, "上一轮结果");
  assert.equal(preview.hidden, true);
  show(32, "新的录音");
  phase("end", 31);
  assert.equal(preview.textContent, "新的录音");
  phase("end", 32);
  assert.equal(preview.hidden, true);
  assert.equal(draft.value, "已有的草稿");
  await settle();
  assert.deepEqual(pet.calls, []);
});

test("remote PTT opens and focuses the editable pet draft without changing its text or selection", async () => {
  for (const ready of [true, false]) {
    const pet = await renderer(snapshot({ expanded: false, ready, draft: "保留这段草稿" }));
    const draft = pet.element("draft");
    pet.element("pet").focus();
    draft.selectionStart = 2;
    draft.selectionEnd = 4;
    assert.equal(remoteVoiceFocus(pet), true, "confirm only after focus succeeds");
    assert.equal(pet.element("panel").hidden, false);
    assert.equal(pet.focusedId(), "draft");
    assert.equal(draft.value, "保留这段草稿");
    assert.deepEqual([draft.selectionStart, draft.selectionEnd], [2, 4]);
    await pet.flushLayout();
    assert.ok(surfaceIds(pet).includes("panel"), "expanded panel must accept pointer input");

    pet.element("target").focus();
    pet.publish({ expanded: true });
    assert.equal(pet.focusedId(), "target", "updates after the press must not reclaim focus");
    assert.deepEqual(pet.calls, [], "native PTT must not start webpage dictation, sync or send a draft");
  }
});

test("PTT shows the red recording state immediately and clears it synchronously on release", async () => {
  const pet = await renderer(snapshot({ expanded: false, ready: false, draft: "已有的文字" }));
  const panel = pet.element("panel");
  const status = pet.element("remote-recording-status");
  const draft = pet.element("draft");
  assert.equal(panel.classList.contains("remote-recording"), false);
  assert.equal(status.hidden, true);
  assert.equal(remoteVoiceFocus(pet, 17), true);
  assert.equal(panel.classList.contains("remote-recording"), true);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /语音键已按下/);
  pet.windowEvent("aichat:remote-voice-recording", { detail: 17 });
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /录音中/);

  pet.input("已有的文字加上未同步编辑");
  draft.selectionStart = 2;
  draft.selectionEnd = 5;
  pet.element("target").focus();
  pet.publish({ expanded: true, attention: "普通状态刷新" });
  assert.equal(panel.classList.contains("remote-recording"), true);
  assert.equal(status.hidden, false);
  assert.equal(pet.focusedId(), "target");
  pet.windowEvent("aichat:remote-voice-end", { detail: 17 });
  assert.equal(panel.classList.contains("remote-recording"), false);
  assert.equal(status.hidden, true);
  assert.equal(panel.hidden, false);
  assert.equal(draft.disabled, false);
  assert.equal(draft.value, "已有的文字加上未同步编辑");
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [2, 5]);
  assert.equal(pet.focusedId(), "target");
  await settle();
  assert.deepEqual(pet.calls, []);
});

test("only the released press shows recognition dots and leaves the draft and focus intact", async () => {
  const pet = await renderer(snapshot({ expanded: false, draft: "已有草稿" }));
  const dots = pet.element("remote-transcribing-status");
  const recording = pet.element("remote-recording-status");
  const panel = pet.element("panel");
  const draft = pet.element("draft");
  const phase = (name, detail) => pet.windowEvent("aichat:remote-voice-" + name, { detail });
  assert.equal(dots.hidden, true);
  assert.equal(remoteVoiceFocus(pet, 18), true);
  phase("recording", 18);
  phase("transcribing", 17);
  assert.equal(dots.hidden, true);
  assert.equal(panel.classList.contains("remote-recording"), true);

  pet.input("已有草稿继续编辑");
  draft.selectionStart = 1;
  draft.selectionEnd = 3;
  pet.element("target").focus();
  phase("transcribing", 18);
  phase("recording", 18); // A late notification must not restore the red recording cue.
  assert.equal(recording.hidden, true);
  assert.equal(panel.classList.contains("remote-recording"), false);
  assert.equal(dots.hidden, false);
  phase("end", 17);
  assert.equal(dots.hidden, false);
  assert.equal(pet.focusedId(), "target");
  assert.equal(draft.value, "已有草稿继续编辑");
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [1, 3]);
  phase("end", 18);
  phase("transcribing", 18);
  assert.equal(dots.hidden, true);
  assert.deepEqual(pet.calls, []);

  remoteVoiceFocus(pet, 19);
  phase("transcribing", 19);
  remoteVoiceFocus(pet, 20);
  phase("end", 19);
  assert.equal(dots.hidden, true);
  assert.equal(recording.hidden, false);
  assert.equal(panel.classList.contains("remote-recording"), true);
});

test("late PTT releases cannot clear a newer press and a focus-only event does not start recording", async () => {
  const pet = await renderer(snapshot({ expanded: false }));
  const status = pet.element("remote-recording-status");
  assert.equal(remoteVoiceFocus(pet), true);
  assert.equal(status.hidden, true);
  assert.equal(remoteVoiceFocus(pet, 21), true);
  pet.windowEvent("aichat:remote-voice-end", { detail: 21 });
  assert.equal(remoteVoiceFocus(pet, 22), true);
  pet.windowEvent("aichat:remote-voice-end", { detail: 21 });
  pet.windowEvent("aichat:remote-voice-recording", { detail: 21 });
  assert.equal(remoteVoiceFocus(pet, 21), false);
  assert.match(status.textContent, /语音键已按下/);
  assert.equal(status.hidden, false);
  assert.equal(pet.element("panel").classList.contains("remote-recording"), true);
  pet.windowEvent("aichat:remote-voice-recording", { detail: 22 });
  assert.match(status.textContent, /录音中/);
  pet.windowEvent("aichat:remote-voice-end", { detail: 22 });
  pet.windowEvent("aichat:remote-voice-recording", { detail: 22 });
  assert.equal(remoteVoiceFocus(pet, 22), false);
  assert.equal(status.hidden, true);
  pet.windowEvent("aichat:remote-voice-end", { detail: 23 });
  assert.equal(remoteVoiceFocus(pet, 23), false, "release can arrive ahead of a delayed press");
  assert.equal(status.hidden, true);
});

test("remote PTT declines before pet initialization and in modal or read-only states", async () => {
  for (const initial of [
    null,
    snapshot({ expanded: false, exitPrompt: { id: "exit", personas: [] } }),
    snapshot({ expanded: false, permission: { id: "capture", client: "QA" } }),
    snapshot({ expanded: false, richDraft: true }),
    snapshot({ expanded: false, dictating: true }),
  ]) {
    const pet = await renderer(initial);
    const focus = pet.focusedId();
    assert.equal(remoteVoiceFocus(pet, 8), false);
    pet.windowEvent("aichat:remote-voice-recording", { detail: 8 });
    assert.equal(pet.element("panel").classList.contains("remote-recording"), false);
    assert.equal(pet.element("remote-recording-status").hidden, true);
    assert.equal(pet.focusedId(), focus);
    assert.equal(pet.element("panel").hidden, true);
    assert.deepEqual(pet.calls, []);
  }
});

test("remote PTT declines if the pet webview cannot focus the draft", async () => {
  const pet = await renderer(snapshot({ expanded: true }));
  pet.element("target").focus();
  pet.element("draft").focus = () => {};
  assert.equal(remoteVoiceFocus(pet), false);
  assert.equal(pet.focusedId(), "target");
  assert.deepEqual(pet.calls, []);
});

test("visible hit regions are published without mouse movement or focus changes", async () => {
  const pet = await renderer();
  assert.deepEqual(surfaceIds(pet), ["panel"]);
  const panel = pet.regionCalls.at(-1).regions.find(region => region.id === "panel");
  assert.deepEqual(panel, { id: "panel", left: 560, top: 430, width: 348, height: 190 });
  pet.windowEvent("blur");
  await pet.flushLayout();
  assert.deepEqual(surfaceIds(pet), ["panel"], "blur must not discard regions needed by the native cursor probe");
  assert.equal(pet.focusedId(), undefined, "geometry reporting must not focus the pet or its composer");
  pet.documentEvent("mousemove", { target: pet.element("draft") });
  pet.documentEvent("mousemove", { target: pet.element("stack") });
  assert.deepEqual(pet.calls, [], "hit testing must not depend on forwarded DOM mousemove commands");
});

test("hit regions follow the visible UI surfaces and exclude transparent stack gaps", async () => {
  const pet = await renderer();
  const transitions = [
    [{ expanded: false, reply: { text: "回复内容" } }, ["bubble"]],
    [{ reply: null, compactVoice: true }, ["compact-controls"]],
    [{ exitPrompt: { id: "exit-1", personas: [] } }, ["exit-bubble"]],
    [{ permission: { id: "permission-1", client: "QA" } }, ["permission-bubble"]],
    [{ exitPrompt: null, permission: null, expanded: true }, ["panel"]],
    [{ expanded: false, compactVoice: false }, []],
  ];
  for (const [state, expected] of transitions) {
    pet.publish(state);
    await pet.flushLayout();
    assert.deepEqual(surfaceIds(pet), expected);
    assert.ok(pet.regionCalls.at(-1).regions.every(region => region.id !== "stack"));
  }
});

test("layout reports are batched and deduplicated across resize, observations and animations", async () => {
  const pet = await renderer(snapshot({ petLeft: 800, petTop: 650, petPixels: 112 }));
  assert.deepEqual(surfaceIds(pet), ["panel"]);
  const count = pet.regionCalls.length;
  pet.setRect("panel", { left: 120, top: 55, width: 300, height: 190 });
  pet.resizeObserved();
  pet.resizeObserved();
  pet.windowEvent("resize");
  pet.documentEvent("animationend", { target: pet.element("panel") });
  assert.equal(pet.regionCalls.length, count, "measurement should wait for the animation frame");
  await pet.flushLayout();
  assert.equal(pet.regionCalls.length, count + 1);
  assert.deepEqual(pet.regionCalls.at(-1).regions.find(region => region.id === "panel"), {
    id: "panel", left: 120, top: 55, width: 300, height: 190,
  });
  pet.publish({ attention: "状态变化但布局未变" });
  pet.resizeObserved();
  pet.windowEvent("resize");
  pet.documentEvent("animationend", { target: pet.element("panel") });
  await pet.flushLayout();
  assert.equal(pet.regionCalls.length, count + 1, "unchanged geometry must not create repeated IPC reports");

  pet.setRect("panel", { width: 320 });
  pet.resizeObserved();
  await pet.flushLayout();
  assert.equal(pet.regionCalls.at(-1).regions.find(region => region.id === "panel").width, 320);
  pet.setRect("panel", { top: 80 });
  pet.documentEvent("animationend", { target: pet.element("panel") });
  await pet.flushLayout();
  assert.equal(pet.regionCalls.at(-1).regions.find(region => region.id === "panel").top, 80);

  pet.setRect("panel", { left: 400, top: 180 });
  pet.setRect("pet", { left: 600, top: 440, width: 224, height: 240 });
  pet.publish({ petLeft: 600, petTop: 440, petPixels: 224 });
  await pet.flushLayout();
  assert.deepEqual(pet.regionCalls.at(-1).regions.find(region => region.id === "panel"), {
    id: "panel", left: 400, top: 180, width: 320, height: 190,
  }, "a native drag or scale snapshot must refresh the measured surfaces");
});

test("invalid and empty rectangles cannot become native hit targets", async () => {
  const pet = await renderer();
  assert.deepEqual(surfaceIds(pet), ["panel"]);
  for (const rect of [
    { left: 10, top: 20, width: 0, height: 100 },
    { left: Number.NaN, top: 20, width: 100, height: 100 },
    { left: 10, top: Number.POSITIVE_INFINITY, width: 100, height: 100 },
    { left: 10, top: 20, width: 100, height: -1 },
  ]) {
    pet.setRect("panel", rect);
    pet.resizeObserved();
    await pet.flushLayout();
    assert.deepEqual(surfaceIds(pet), []);
  }
});

test("a new native hit-region epoch republishes unchanged geometry", async () => {
  const pet = await renderer(snapshot({ hitRegionsEpoch: 1 }));
  assert.deepEqual(surfaceIds(pet), ["panel"]);
  const before = pet.regionCalls.at(-1);
  const count = pet.regionCalls.length;
  assert.equal(before.epoch, 1);

  pet.publish({ hitRegionsEpoch: 2 });
  await pet.flushLayout();
  assert.equal(pet.regionCalls.length, count + 1,
    "native invalidation must restore regions even when every rectangle stays unchanged");
  assert.equal(pet.regionCalls.at(-1).epoch, 2);
  assert.deepEqual(pet.regionCalls.at(-1).regions, before.regions);

  pet.publish({ hitRegionsEpoch: 2, attention: "仅消息状态变化" });
  pet.resizeObserved();
  await pet.flushLayout();
  assert.equal(pet.regionCalls.length, count + 1, "the same epoch and geometry should still deduplicate");
});

test("only a primary press beginning on visible UI holds interaction until release or cancel", async () => {
  const pet = await renderer();
  pet.documentEvent("pointerdown", { button: 0, pointerId: 1, target: pet.element("draft") });
  pet.documentEvent("pointerup", { button: 0, pointerId: 1, target: pet.element("stack") });
  assert.deepEqual(pet.pointerHolds, [{ active: true }, { active: false }]);

  pet.documentEvent("pointerdown", { button: 0, pointerId: 2, target: pet.element("stack") });
  pet.documentEvent("pointerup", { button: 0, pointerId: 2, target: pet.element("stack") });
  pet.documentEvent("pointerdown", { button: 2, pointerId: 3, target: pet.element("draft") });
  pet.documentEvent("pointerup", { button: 2, pointerId: 3, target: pet.element("draft") });
  assert.ok(pet.pointerHolds.slice(2).every(hold => hold.active === false),
    "background and secondary clicks must not retain the whole canvas");

  pet.documentEvent("pointerdown", { button: 0, pointerId: 4, target: pet.element("draft") });
  pet.documentEvent("pointercancel", { pointerId: 4, target: pet.element("stack") });
  assert.deepEqual(pet.pointerHolds.slice(-2), [{ active: true }, { active: false }]);

  pet.documentEvent("pointerdown", { button: 0, pointerId: 5, target: pet.element("draft") });
  pet.windowEvent("blur");
  assert.deepEqual(pet.pointerHolds.slice(-2), [{ active: true }, { active: false }]);
});

const dragState = (extra = {}) => snapshot({ ready: true, petLeft: 800, petTop: 650, ...extra });
function pointer(pet, type, id, x = 100, y = 100, extra = {}) {
  pet.element("pet").fire(type, { button: 0, pointerId: id, screenX: x, screenY: y, ...extra });
}

test("pet drag preserves the four-pixel threshold and click, double-click and menu actions", async () => {
  const pet = await renderer(dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 104, 100);
  await pet.flushFrame();
  assert.equal(pet.calls.some(call => call.name === "drag"), false);
  pointer(pet, "pointerup", 1, 104, 100);
  pet.element("pet").fire("click", { detail: 1 });
  await settle();
  assert.equal(pet.calls.filter(call => call.name === "expand").length, 1);
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 2 });
  await settle();
  assert.equal(pet.calls.filter(call => call.name === "open").length, 1);
  let prevented = 0;
  pet.element("pet").fire("contextmenu", { preventDefault() { prevented++; } });
  await settle();
  assert.equal(prevented, 1);
  assert.equal(pet.calls.at(-1).name, "menu");
});

for (const [label, button, ctrlKey] of [["secondary click", 2, false], ["Control-click", 0, true]]) {
  test(`pet ${label} opens only its menu without beginning a drag or opening chat`, async () => {
    const pet = await renderer(dragState({ draft: "保留的草稿", dictating: true }));
    let prevented = 0, stopped = 0;
    pointer(pet, "pointerdown", 10, 100, 100, { button, ctrlKey });
    pointer(pet, "pointerup", 10, 100, 100, { button, ctrlKey });
    pet.element("pet").fire("click", { detail: 1, button, ctrlKey });
    pet.element("pet").fire("contextmenu", {
      button, ctrlKey,
      preventDefault() { prevented++; },
      stopPropagation() { stopped++; },
    });
    await settle();
    assert.equal(prevented, 1);
    assert.equal(stopped, 1, "native menu owns this context request");
    assert.deepEqual(pet.calls, [{ name: "menu", args: {} }]);
    assert.deepEqual(pet.captures, []);
    assert.equal(pet.bodyHasClass("dragging"), false);
    assert.equal(pet.element("draft").value, "保留的草稿");
    assert.equal(pet.element("dictation").textContent, "停止输入");
  });
}

test("pet menu failures stay visible and an explicit successful retry clears them", async () => {
  const pet = await renderer(dragState({ draft: "菜单失败也保留草稿" }));
  let attempts = 0;
  pet.handle(name => {
    assert.equal(name, "menu");
    if (++attempts === 1) throw Error("右键菜单暂时不可用，请重试");
    return dragState({ draft: "菜单失败也保留草稿" });
  });
  pet.element("pet").fire("contextmenu");
  await settle();
  assert.match(pet.element("error").textContent, /右键菜单暂时不可用/);
  pet.publish({ draft: "菜单失败也保留草稿" });
  await settle();
  assert.equal(attempts, 1, "refresh cannot replay a menu request");
  assert.match(pet.element("error").textContent, /右键菜单暂时不可用/);
  pet.element("pet").fire("contextmenu");
  await settle();
  assert.equal(attempts, 2);
  assert.equal(pet.element("error").textContent, "");
  assert.equal(pet.element("draft").value, "菜单失败也保留草稿");
  assert.deepEqual(pet.calls, [{ name: "menu", args: {} }, { name: "menu", args: {} }]);
});

test("opening the pet context menu preserves the next ordinary left click", async () => {
  const pet = await renderer(dragState());
  pet.element("pet").fire("contextmenu");
  await settle();
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 1, button: 0 });
  await settle();
  assert.deepEqual(pet.calls.map(call => call.name), ["menu", "drag-start", "drag-end", "expand"]);
  assert.equal(pet.bodyHasClass("dragging"), false);
});

test("synthetic pointerup during a cross-monitor drag does not end native tracking or open chat", async () => {
  const pet = await renderer(dragState());
  let drags = 0;
  pet.handle(name => name === "drag" ? dragState({ dragging: ++drags < 2, petLeft: 100, petTop: 150 }) : dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 105, 100);
  await pet.flushFrame();
  assert.deepEqual(pet.releasedCaptures, [1]);
  pointer(pet, "pointerup", 1, 105, 100);
  pet.element("pet").fire("click", { detail: 1 });
  await pet.flushFrame();
  assert.equal(drags, 2);
  assert.equal(pet.calls.some(call => ["drag-end", "expand", "open"].includes(call.name)), false);
  assert.equal(pet.element("pet").style.transform, "translate3d(100px, 150px, 0)");
});

for (const rejected of [false, true]) {
  test(`a prior pet drag's late ${rejected ? "error" : "completion"} cannot move or end a new drag`, async () => {
    const pet = await renderer(dragState()), requests = [];
    pet.handle(name => name === "drag" ? new Promise((resolve, reject) => requests.push({ resolve, reject })) : dragState());
    pointer(pet, "pointerdown", 1);
    pointer(pet, "pointermove", 1, 110, 100);
    await pet.flushFrame();
    assert.equal(requests.length, 1);
    pointer(pet, "pointerdown", 2, 200, 200);
    pointer(pet, "pointermove", 2, 210, 200);
    await pet.flushFrame();
    assert.equal(requests.length, 2);
    if (rejected) requests[0].reject(Error("late old window move"));
    else requests[0].resolve(dragState({ dragging: false, petLeft: 333, petTop: 444 }));
    await settle();
    assert.equal(pet.element("pet").style.transform, "translate3d(800px, 650px, 0)");
    await pet.flushFrame();
    assert.equal(requests.length, 2, "a stale error must not schedule an extra tracker for the new pointer");
    requests[1].resolve(dragState({ dragging: true, petLeft: 600, petTop: 500 }));
    await settle();
    assert.equal(pet.element("pet").style.transform, "translate3d(600px, 500px, 0)");
    pointer(pet, "pointermove", 2, 230, 210);
    await pet.flushFrame();
    assert.equal(requests.length, 3, "the new drag must keep following its pointer");
    requests[2].resolve(dragState({ dragging: false, petLeft: 620, petTop: 510 }));
    await settle();
  });
}

test("a released old press cannot end a new native drag when its startup acknowledgement arrives late", async () => {
  const pet = await renderer(dragState());
  let firstStart, starts = 0;
  pet.handle(name => name === "drag-start" && ++starts === 1 ? new Promise(resolve => { firstStart = resolve; }) : dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointerup", 1);
  pointer(pet, "pointerdown", 2, 200, 200);
  await settle();
  firstStart(dragState());
  await settle();
  assert.equal(pet.calls.filter(call => call.name === "drag-end").length, 0);
  pointer(pet, "pointerup", 2, 200, 200);
  await settle();
  assert.equal(pet.calls.filter(call => call.name === "drag-end").length, 1);
});

test("native drag-end broadcasts release the matching renderer tracker while its RPC remains pending", async () => {
  const pet = await renderer(dragState());
  let resolveDrag;
  pet.handle(name => name === "drag" ? new Promise(resolve => { resolveDrag = resolve; }) : dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 110, 100);
  await pet.flushFrame();
  assert.equal(pet.calls.filter(call => call.name === "drag").length, 1);
  pet.publish({ dragging: false, petLeft: 300, petTop: 250 });
  await pet.flushFrame();
  assert.equal(pet.element("pet").style.transform, "translate3d(300px, 250px, 0)");
  resolveDrag(dragState({ dragging: true, petLeft: 50, petTop: 60 }));
  await settle();
  await pet.flushFrame();
  assert.equal(pet.element("pet").style.transform, "translate3d(300px, 250px, 0)", "the pending RPC cannot rewind a completed native move");
  assert.equal(pet.calls.filter(call => call.name === "drag").length, 1);
});

test("native drag tracking needs no renderer animation frame or drag RPC after threshold", async () => {
  const pet = await renderer(dragState());
  let confirmStart;
  pet.handle((name, args) => {
    if (name === "drag-start") return new Promise(resolve => {
      confirmStart = () => resolve(dragState({ nativeDragTracking: true, dragging: true, dragId: args.dragId }));
    });
    if (name === "drag") throw Error("native tracking must not poll the renderer");
    return dragState();
  });
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 110, 100);
  await settle();
  assert.equal(pet.frameCount(), 0, "pending startup must not require a renderer frame");
  confirmStart();
  await settle();
  assert.equal(pet.frameCount(), 0, "native capability must not schedule a fallback frame");
  const dragId = pet.calls.find(call => call.name === "drag-start").args.dragId;
  assert.ok(Number.isInteger(dragId));
  pet.publish({ nativeDragTracking: true, dragId, dragging: true, petLeft: 120, petTop: 240 });
  assert.equal(pet.element("pet").style.transform, "translate3d(120px, 240px, 0)");
  pointer(pet, "pointerup", 1, 110, 100);
  await pet.flushLayout();
  assert.equal(pet.calls.some(call => ["drag", "drag-end"].includes(call.name)), false);
  pet.publish({ nativeDragTracking: true, dragId, dragging: false, petLeft: 180, petTop: 260 });
  await pet.flushLayout();
  assert.equal(pet.element("pet").style.transform, "translate3d(180px, 260px, 0)");
  assert.deepEqual(pet.releasedCaptures, [1, 1]);
  assert.equal(pet.calls.some(call => call.name === "drag"), false);
});

test("an old native drag ID cannot move or finish the next native drag", async () => {
  const pet = await renderer(dragState());
  pet.handle((name, args) => dragState({ nativeDragTracking: true, dragging: true, dragId: args.dragId }));
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 110, 100);
  await settle();
  const firstId = pet.calls.at(-1).args.dragId;
  pointer(pet, "pointerdown", 2, 200, 200);
  pointer(pet, "pointermove", 2, 210, 200);
  await settle();
  const secondId = pet.calls.at(-1).args.dragId;
  assert.notEqual(firstId, secondId);
  pet.publish({ nativeDragTracking: true, dragId: secondId, dragging: true, petLeft: 600, petTop: 500 });
  pet.publish({ nativeDragTracking: true, dragId: firstId, dragging: false, petLeft: 1, petTop: 2 });
  assert.equal(pet.element("pet").style.transform, "translate3d(600px, 500px, 0)");
  assert.deepEqual(pet.releasedCaptures, [1, 2], "old completion must leave the new pointer tracking");
  pet.publish({ nativeDragTracking: true, dragId: secondId, dragging: false, petLeft: 620, petTop: 520 });
  assert.deepEqual(pet.releasedCaptures, [1, 2, 2]);
  assert.equal(pet.element("pet").style.transform, "translate3d(620px, 520px, 0)");
});

test("a matching native drag-end can arrive before the drag-start acknowledgement", async () => {
  const pet = await renderer(dragState());
  let confirmStart;
  pet.handle((name, args) => name === "drag-start" ? new Promise(resolve => {
    confirmStart = () => resolve(dragState({ nativeDragTracking: true, dragging: true, dragId: args.dragId }));
  }) : dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 110, 100);
  const dragId = pet.calls.at(-1).args.dragId;
  pet.publish({ nativeDragTracking: true, dragId, dragging: false, petLeft: 500, petTop: 400 });
  confirmStart();
  await settle();
  await pet.flushLayout();
  assert.deepEqual(pet.releasedCaptures, [1, 1]);
  assert.equal(pet.calls.some(call => call.name === "drag"), false);
  assert.equal(pet.element("pet").style.transform, "translate3d(500px, 400px, 0)");
});

test("legacy host drag polling carries an optional ID and ends with its own matching ID", async () => {
  const pet = await renderer(dragState());
  let finishDrag;
  pet.handle((name, args) => name === "drag" ? new Promise(resolve => { finishDrag = resolve; }) : dragState());
  pointer(pet, "pointerdown", 1);
  pointer(pet, "pointermove", 1, 110, 100);
  await pet.flushFrame();
  const start = pet.calls.find(call => call.name === "drag-start"), drag = pet.calls.find(call => call.name === "drag");
  assert.ok(start && drag, "a host without nativeDragTracking keeps the fallback");
  assert.equal(start.args.dragId, drag.args.dragId);
  finishDrag(dragState({ dragging: false }));
  await settle();
  pointer(pet, "pointerdown", 2, 200, 200);
  pointer(pet, "pointerup", 2, 200, 200);
  await settle();
  const secondStart = pet.calls.filter(call => call.name === "drag-start").at(-1);
  assert.equal(pet.calls.at(-1).name, "drag-end");
  assert.equal(pet.calls.at(-1).args.dragId, secondStart.args.dragId);
  assert.notEqual(secondStart.args.dragId, start.args.dragId);
});

test("native movement without a DOM pointermove still excludes synthetic clicks and drag-end", async () => {
  const pet = await renderer(dragState());
  pet.handle((name, args) => dragState({ nativeDragTracking: true, dragging: true, dragId: args.dragId }));
  pointer(pet, "pointerdown", 1);
  await settle();
  const dragId = pet.calls.at(-1).args.dragId;
  pet.publish({ nativeDragTracking: true, dragId, dragMoved: true, dragging: true, petLeft: 200, petTop: 300 });
  assert.deepEqual(pet.releasedCaptures, [1]);
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 1 });
  await pet.flushLayout();
  assert.equal(pet.calls.some(call => ["drag", "drag-end", "expand", "open"].includes(call.name)), false);
  pet.publish({ nativeDragTracking: true, dragId, dragMoved: true, dragging: false, petLeft: 220, petTop: 320 });
  assert.deepEqual(pet.releasedCaptures, [1, 1]);
  assert.equal(pet.element("pet").style.transform, "translate3d(220px, 320px, 0)");
});

test("native startup can report movement without rewinding newer native geometry", async () => {
  const pet = await renderer(dragState());
  let confirmStart;
  pet.handle((name, args) => name === "drag-start" ? new Promise(resolve => {
    confirmStart = () => resolve(dragState({ nativeDragTracking: true, dragId: args.dragId, dragMoved: true, dragging: true, petLeft: 1, petTop: 2 }));
  }) : dragState());
  pointer(pet, "pointerdown", 1);
  const dragId = pet.calls.at(-1).args.dragId;
  pet.publish({ nativeDragTracking: true, dragId, dragging: true, petLeft: 500, petTop: 400 });
  confirmStart();
  await settle();
  assert.equal(pet.element("pet").style.transform, "translate3d(500px, 400px, 0)");
  assert.deepEqual(pet.releasedCaptures, [1]);
  pointer(pet, "pointerup", 1);
  await settle();
  assert.equal(pet.calls.some(call => call.name === "drag-end"), false);
  pet.publish({ nativeDragTracking: true, dragId, dragMoved: true, dragging: false });
});

test("a fast native drag with only its final snapshot can never become a click", async () => {
  const pet = await renderer(dragState());
  pet.handle((name, args) => dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: true }));
  pointer(pet, "pointerdown", 1);
  await settle();
  const dragId = pet.calls.at(-1).args.dragId;
  pet.publish({ nativeDragTracking: true, dragId, dragMoved: true, dragging: false, petLeft: 150, petTop: 250 });
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 1 });
  await pet.flushLayout();
  assert.equal(pet.calls.some(call => ["drag", "drag-end", "expand", "open"].includes(call.name)), false);
  assert.deepEqual(pet.releasedCaptures, [1, 1]);
  assert.equal(pet.element("pet").style.transform, "translate3d(150px, 250px, 0)");
});

test("a synthetic native pointerup waits for physical release confirmation before allowing clicks", async () => {
  const pet = await renderer(dragState());
  const releases = [];
  pet.handle((name, args) => name === "drag-end"
    ? new Promise(resolve => releases.push(() => resolve(dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: releases.length === 1, dragMoved: false }))))
    : dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: true }));
  pointer(pet, "pointerdown", 1);
  await settle();
  const dragId = pet.calls.at(-1).args.dragId;
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 1 });
  await settle();
  assert.equal(releases.length, 1);
  assert.equal(pet.calls.some(call => call.name === "expand"), false, "an unconfirmed up is never a tap");
  releases[0]();
  await settle();
  assert.equal(pet.calls.some(call => call.name === "expand"), false, "button-still-down response rejects the synthetic click");
  pet.publish({ nativeDragTracking: true, dragId, dragging: true, dragMoved: true, petLeft: 300, petTop: 350 });
  assert.equal(pet.element("pet").style.transform, "translate3d(300px, 350px, 0)");
  pet.publish({ nativeDragTracking: true, dragId, dragging: false, dragMoved: true });
  assert.equal(pet.calls.some(call => call.name === "expand"), false);

  pointer(pet, "pointerdown", 2, 200, 200);
  await settle();
  pointer(pet, "pointerup", 2, 200, 200);
  pet.element("pet").fire("click", { detail: 1 });
  await settle();
  assert.equal(releases.length, 2);
  assert.equal(pet.calls.some(call => call.name === "expand"), false);
  releases[1]();
  await settle();
  assert.equal(pet.calls.filter(call => call.name === "expand").length, 1, "a confirmed unmoved release retains normal tap behavior");
});

test("a pending native release cannot turn its delayed click into an action in the next press", async () => {
  const pet = await renderer(dragState());
  let confirmRelease;
  pet.handle((name, args) => name === "drag-end" ? new Promise(resolve => {
    confirmRelease = () => resolve(dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: false, dragMoved: false }));
  }) : dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: true }));
  pointer(pet, "pointerdown", 1);
  await settle();
  pointer(pet, "pointerup", 1);
  pet.element("pet").fire("click", { detail: 1 });
  await settle();
  pointer(pet, "pointerdown", 2, 200, 200);
  confirmRelease();
  await settle();
  assert.equal(pet.calls.some(call => ["expand", "open"].includes(call.name)), false);
});

test("normal native taps preserve single-click expansion and double-click opening", async () => {
  const pet = await renderer(dragState());
  pet.handle((name, args) => dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: name !== "drag-end", dragMoved: false }));
  for (const detail of [1, 2]) {
    pointer(pet, "pointerdown", detail);
    await settle();
    pointer(pet, "pointerup", detail);
    pet.element("pet").fire("click", { detail });
    await settle();
  }
  assert.equal(pet.calls.filter(call => call.name === "expand").length, 1);
  assert.equal(pet.calls.filter(call => call.name === "open").length, 1);
});

for (const firstMoved of [false, true]) {
  test(`delayed native first-release confirmation ${firstMoved ? "rejects a dragged double-click" : "preserves a valid double-click"}`, async () => {
    const pet = await renderer(dragState());
    let firstRelease, ends = 0;
    pet.handle((name, args) => {
      const result = dragState({ nativeDragTracking: true, dragId: args.dragId, dragging: name !== "drag-end", dragMoved: name === "drag-end" && ends === 0 && firstMoved });
      if (name === "drag-end" && ends++ === 0) return new Promise(resolve => { firstRelease = () => resolve(result); });
      return result;
    });
    pointer(pet, "pointerdown", 1);
    await settle();
    pointer(pet, "pointerup", 1);
    pet.element("pet").fire("click", { detail: 1 });
    await settle();
    pointer(pet, "pointerdown", 2);
    await settle();
    pointer(pet, "pointerup", 2);
    pet.element("pet").fire("click", { detail: 2 });
    await settle();
    assert.equal(pet.calls.some(call => ["expand", "open"].includes(call.name)), false, "unconfirmed first click cannot act in the second press");
    firstRelease();
    await settle();
    assert.equal(pet.calls.filter(call => call.name === "expand").length, 0, "the superseded single click must never toggle the panel");
    assert.equal(pet.calls.filter(call => call.name === "open").length, firstMoved ? 0 : 1);
  });
}
