const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/pet.ts"), "utf8");
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
  function addListener(listeners, type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  }
  function dispatch(listeners, type, event = {}) {
    for (const callback of listeners.get(type) || []) callback({ type, ...event });
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
    body: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
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
      calls.push({ name, args });
      if (handler) return handler(name, args);
      if (name === "input") current = { ...current, draft: args.text };
      if (name === "send") current = { ...current, draft: "" };
      return current;
    },
  };
  vm.runInNewContext(javascript, {
    exports: {},
    require: () => ({}),
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
  async function flushLayout() {
    for (let i = 0; frames.size && i < 10; i++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
      await settle();
    }
  }
  await flushLayout();
  return {
    element: id => document.getElementById(id),
    calls,
    regionCalls,
    pointerHolds,
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
