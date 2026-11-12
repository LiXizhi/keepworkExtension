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

async function renderer(initial = snapshot()) {
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
    querySelectorAll: () => [],
    addEventListener(type, callback) { addListener(documentListeners, type, callback); },
    body: { style: { setProperty() {} }, classList: {
      add(...names) { for (const name of names) bodyClasses.add(name); },
      remove(...names) { for (const name of names) bodyClasses.delete(name); },
    } },
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
        elements.set(id, {
          id, style: {}, dataset: {}, children: [], value: "", textContent: "", disabled: false,
          hidden: surfaceIds.includes(id) && id !== "pet",
          rect: { left: 0, top: 0, width: 0, height: 0, ...defaultRects[id] },
          scrollTop: 0, scrollHeight: 100, clientHeight: 100,
          classList: { toggle() {}, add() {}, remove() {} },
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
      if (name === "input") current = { ...current, draft: args.text };
      if (name === "send") current = { ...current, draft: "" };
      return current;
    },
  };
  vm.runInNewContext(javascript, {
    exports: {},
    require: name => name === "./petAudio" ? { installPetAudioCapture() {} } : {},
    window: {
      desktopPet: api, innerWidth: 1000, innerHeight: 800,
      addEventListener(type, callback) { addListener(windowListeners, type, callback); },
      matchMedia: () => ({ matches: true }),
      getSelection: () => null, setTimeout,
    },
    document,
    performance,
    ResizeObserver,
    getComputedStyle: element => ({ display: visible(element) ? "block" : "none", visibility: "visible" }),
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
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
    pointerHolds,
    captures,
    releasedCaptures,
    bodyHasClass: name => bodyClasses.has(name),
    flushFrame,
    frameCount: () => frames.size,
    flushLayout,
    focusedId() { return document.activeElement?.id; },
    documentEvent(type, event) { dispatch(documentListeners, type, event); },
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

function surfaceIds(pet) {
  assert.ok(pet.regionCalls.length, "visible surfaces must be reported without mouse movement");
  return pet.regionCalls.at(-1).regions.map(region => region.id).filter(id => id !== "pet").sort();
}

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
