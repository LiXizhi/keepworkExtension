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
  let current = initial;
  let publish;
  let handler;
  const calls = [];
  const document = {
    querySelectorAll: () => [],
    addEventListener() {},
    body: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
        elements.set(id, {
          style: {}, dataset: {}, children: [], value: "", textContent: "", disabled: false,
          scrollTop: 0, scrollHeight: 100, clientHeight: 100,
          classList: { toggle() {}, add() {}, remove() {} },
          setAttribute(key, value) { this[key] = value; },
          addEventListener(type, callback) { listeners.set(type, callback); },
          replaceChildren(...children) { this.children = children; },
          focus() { document.activeElement = this; },
          click() { if (!this.disabled) return this.onclick?.({}); },
          fire(type, event = {}) { return listeners.get(type)?.(event); },
        });
      }
      return elements.get(id);
    },
    createElement() { return { textContent: "", disabled: false }; },
  };
  const api = {
    subscribe(callback) { publish = callback; },
    async action(name, args = {}) {
      if (name === "state") return current;
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
      addEventListener() {}, matchMedia: () => ({ matches: true }),
      getSelection: () => null, setTimeout,
    },
    document,
    performance,
    requestAnimationFrame() {},
  });
  await settle();
  return {
    element: id => document.getElementById(id),
    calls,
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
