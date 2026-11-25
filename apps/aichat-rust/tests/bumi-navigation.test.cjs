const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/bumi-navigation.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class Element extends EventTarget {
  children = [];
  dataset = {};
  value = "";
  appendChild(child) { this.children.push(child); }
  fire(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields)); }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
}
function renderer({ storage = new Map(), ready = true, guided = true } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = Object.assign(new Element(), { getElementById: el, createElement: () => new Element() });
  let timer;
  const window = Object.assign(new Element(), {
    setTimeout(fn, ms) { timer = { fn, ms }; return 1; },
    clearTimeout() { timer = null; },
    localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
  } });
  const exports = {};
  vm.runInNewContext(js, { document, window, exports });
  const actions = [];
  const nav = exports.createBumiNavigation({
    canGuide() { return guided; },
    startLeg(dir) { if (ready) actions.push(dir); return ready; },
    stopLeg() { actions.push("stop"); },
  });
  return { el, nav, window, storage, actions,
    expireHold(ms = 2000) { assert.equal(timer.ms, ms); timer.fn(); },
    mark(address, mode, value = "") {
      el("nav-mode").value = mode;
      if (mode === "pose") el("nav-facing").value = String(value);
      if (mode === "goal") el("nav-name").value = value;
      const pos = (Number(address[1]) - 1) * 5 + address.charCodeAt(0) - "A".charCodeAt(0);
      el("nav-grid").children[pos].fire("click");
    },
    press() { el("nav-drive").fire("pointerdown", { pointerId: 1, button: 0, isPrimary: true }); },
    lift() { el("nav-drive").fire("pointerup", { pointerId: 1 }); },
    confirm() { el("nav-confirm").fire("click"); },
  };
}

test("the floor map plans around obstacles and never connects opposite row ends or unknown cells", () => {
  const ui = renderer();
  ui.mark("E1", "pose", 2);
  ui.mark("A2", "goal", "门口");
  ui.mark("E2", "floor");
  ui.mark("D2", "blocked");
  ui.mark("D2", "goal", "过道"); // Naming an obstacle cannot silently open it.
  assert.match(ui.el("nav-status").textContent, /障碍/);
  assert.match(ui.nav.plan("门口"), /没有已标记为可通行的路线/);
  for (const cell of ["D1", "C1", "C2", "B2"]) ui.mark(cell, "floor");
  assert.match(ui.nav.plan("门口"), /右转/);
  assert.match(ui.el("nav-path").textContent, /E1 → D1 → C1 → C2 → B2 → A2/);
  assert.deepEqual(ui.actions, []);
});

test("turn and forward legs each require a held control, release and observed arrival", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 3); // Face left. Reaching B1 needs two right turns.
  ui.mark("B1", "goal", "讲台");
  ui.nav.setRemoteActive(true);
  assert.match(ui.nav.plan("讲台"), /右转/);
  ui.confirm();
  assert.equal(ui.el("nav-confirm").disabled, true);
  for (const expected of ["右转", "右转", "前进"]) {
    assert.equal(ui.el("nav-drive").textContent, "按住" + expected);
    ui.press();
    ui.press(); // A second contact or autorepeat cannot own this movement.
    ui.nav.setMoving(true);
    ui.confirm();
    ui.nav.setMoving(false);
    ui.confirm(); // Still held.
    ui.lift();
    assert.equal(ui.el("nav-confirm").disabled, false);
    ui.confirm();
  }
  assert.deepEqual(ui.actions, ["right", "stop", "right", "stop", "forward", "stop"]);
  assert.equal(ui.el("nav-route").hidden, true);
  assert.match(ui.el("nav-status").textContent, /现场已确认到达讲台/);
});

test("taking over, losing pointer capture or changing session stops the held leg exactly once", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "门口");
  ui.nav.setRemoteActive(true);
  ui.nav.plan("门口");
  ui.press();
  ui.nav.interruptLeg();
  ui.lift();
  ui.press();
  ui.el("nav-drive").fire("lostpointercapture", { pointerId: 1 });
  ui.press();
  ui.window.fire("blur");
  ui.press();
  ui.nav.setRemoteActive(false);
  ui.confirm();
  ui.lift();
  assert.deepEqual(ui.actions, ["forward", "stop", "forward", "stop", "forward", "stop", "forward", "stop"]);
  assert.equal(ui.el("nav-route").hidden, true);
  assert.match(ui.nav.plan("门口"), /当前所在格/);
});

test("a rejected drive never advances the route or asserts the robot reached a point", () => {
  const ui = renderer({ ready: false });
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "门口");
  ui.nav.setRemoteActive(true);
  ui.nav.plan("门口");
  ui.press();
  ui.confirm();
  assert.match(ui.el("nav-status").textContent, /未启动/);
  assert.equal(ui.el("nav-confirm").disabled, true);
  assert.deepEqual(ui.actions, []);
});

test("one held press has a finite travel window and never implicitly confirms the next segment", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "讲台");
  ui.nav.setRemoteActive(true);
  ui.nav.plan("讲台");
  ui.press();
  ui.expireHold();
  ui.lift();
  assert.deepEqual(ui.actions, ["forward", "stop"]);
  assert.equal(ui.el("nav-route").hidden, false);
  assert.equal(ui.el("nav-confirm").disabled, false);
});

test("hosts without guided motion can plan and confirm a manually driven segment", () => {
  const ui = renderer({ guided: false });
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "门口");
  ui.nav.setRemoteActive(true);
  assert.match(ui.nav.plan("门口"), /按遥控器方向键/);
  assert.equal(ui.el("nav-drive").disabled, true);
  ui.press();
  assert.deepEqual(ui.actions, []);
  ui.nav.motionStarted();
  ui.confirm();
  assert.match(ui.el("nav-status").textContent, /现场已确认到达门口/);
});

test("spoken steps pulse only the planned direction; each turn and cell require explicit observation", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 0);
  ui.mark("B1", "goal", "讲台");
  ui.nav.setRemoteActive(true);
  assert.match(ui.nav.voiceStep(), /先开启遥控并说出要去的地点/);
  ui.nav.plan("讲台");
  assert.match(ui.nav.confirmStep(), /本段还未移动/);
  assert.match(ui.nav.voiceStep(), /右转/);
  assert.match(ui.nav.voiceStep(), /停稳/);
  assert.match(ui.nav.confirmStep(), /停稳/);
  ui.press(); // Pointer cannot take over a voice pulse.
  ui.lift();
  ui.expireHold(400);
  ui.nav.setMoving(true); // A slow BLE stop is still in progress.
  assert.match(ui.nav.confirmStep(), /停稳/);
  ui.nav.setMoving(false);
  ui.nav.voiceStep(); // Not aligned yet: repeat the turn rather than blindly advance.
  ui.expireHold(400);
  assert.match(ui.nav.confirmStep(), /前进到 B1/);
  ui.nav.voiceStep();
  ui.expireHold(400);
  assert.equal(ui.el("nav-route").hidden, false);
  assert.match(ui.nav.confirmStep(), /现场已确认到达讲台/);
  assert.deepEqual(ui.actions, ["right", "stop", "right", "stop", "forward", "stop"]);
});

test("a held pointer blocks spoken movement; cancel and lost focus interrupt an active spoken pulse", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "门口");
  ui.nav.setRemoteActive(true);
  ui.nav.plan("门口");
  ui.press();
  assert.match(ui.nav.voiceStep(), /停稳/);
  ui.lift();
  ui.nav.voiceStep();
  ui.window.fire("blur");
  ui.nav.voiceStep();
  ui.el("nav-cancel").fire("click");
  assert.match(ui.nav.confirmStep(), /没有正在执行的路线/);
  assert.deepEqual(ui.actions, ["forward", "stop", "forward", "stop", "forward", "stop"]);
});

test("only room geometry survives a new window; unconfirmed motion expires the old pose", () => {
  const ui = renderer();
  ui.mark("A1", "pose", 1);
  ui.mark("B1", "goal", "讲台");
  ui.nav.motionStarted();
  assert.match(ui.nav.plan("讲台"), /当前所在格/);
  const next = renderer({ storage: ui.storage });
  assert.match(next.nav.plan("讲台"), /当前所在格/);
  next.mark("A1", "pose", 1);
  assert.match(next.nav.plan("讲台"), /前进到 B1/);
  assert.deepEqual(next.actions, []);
});
