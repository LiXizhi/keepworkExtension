const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("bumi-control.html");
const script = ts.transpileModule(read("src/bumi-control.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

class Control extends EventTarget {
  dataset = {};
  value = "";
  children = [];
  style = { setProperty(name, value) { this[name] = value; } };
  setAttribute(name, value) { this[name] = value; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture(id) { if (this.captured === id) this.captured = undefined; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  fire(type, properties = {}) {
    this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties));
  }
  click() { if (!this.disabled) this.fire("click"); }
}

async function renderer(t, {
  beforeMove = () => {}, beforeMode = () => {}, beforeListen = () => {}, legacy = false, initial = {},
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const ids = new Map();
  const groups = new Map();
  for (const [tag] of html.matchAll(/<[a-z][\w-]*\b[^>]*>/g)) {
    const control = new Control();
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (id) ids.set(id, control);
    if (id === "direction-pad" || id === "motion-stick") {
      const size = id === "direction-pad" ? 252 : 52;
      control.getBoundingClientRect = () => ({
        left: 146 - size / 2, top: 186 - size / 2, width: size, height: size,
      });
    }
    control.disabled = /\sdisabled\b/.test(tag);
    control.hidden = /\shidden\b/.test(tag);
    const data = tag.match(/\bdata-(command|query|move)="([^"]+)"/);
    if (data) {
      control.dataset[data[1]] = data[2];
      const selector = `[data-${data[1]}]`;
      if (!groups.has(selector)) groups.set(selector, []);
      groups.get(selector).push(control);
    }
  }
  const document = Object.assign(new Control(), {
    getElementById: id => ids.get(id),
    createElement: () => new Control(),
    querySelectorAll: selector => groups.get(selector) || [],
  });
  const window = Object.assign(new Control(), { setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true });
  const robot = { id: "test-bumi", name: "Bumi", rssi: -50 };
  const snapshot = { connected: robot, devices: [robot], available: true, walkMode: false, locomotionMode: null,
    moving: false, status: null, battery: null, listening: false, ...initial };
  const actions = [];
  const moves = [];
  const listeners = new Set();
  const monitorRequests = [];
  async function listen(event, handle, options) {
    await beforeListen(event);
    const listener = { event, handle, target: options?.target };
    listeners.add(listener);
    return async () => { listeners.delete(listener); };
  }
  function emit(event, payload) {
    for (const listener of listeners) {
      if (listener.event === event) listener.handle({ event, payload });
    }
  }
  async function invoke(name, { request }) {
    assert.equal(name, "bumi_control");
    if (request.operation === "disconnect") {
      Object.assign(snapshot, { connected: null, walkMode: false, locomotionMode: null, moving: false, status: null });
    } else if (request.operation === "listen") {
      monitorRequests.push(request.enabled);
      snapshot.listening = request.enabled;
    } else if (request.operation === "send") {
      const cmd = request.command;
      actions.push(cmd.action);
      if (cmd.action === "walk" || cmd.action === "run") {
        await beforeMode(cmd.action);
        snapshot.walkMode = cmd.action === "walk";
        snapshot.locomotionMode = cmd.action;
      }
      if (cmd.action === "wave") {
        snapshot.walkMode = false;
        snapshot.locomotionMode = null;
      }
      if (cmd.action === "move") {
        assert.equal(Object.hasOwn(cmd, "vy"), false);
        assert.ok(Number.isInteger(cmd.vx) && Number.isInteger(cmd.vyaw));
        // Tauri's serialized IPC sends JavaScript -0 as an ordinary zero.
        moves.push(JSON.parse(JSON.stringify([cmd.vx, cmd.vyaw])));
        await beforeMove(moves.length);
        snapshot.moving = !!(cmd.vx || cmd.vyaw);
      }
    }
    const result = { ...snapshot };
    if (legacy) {
      delete result.locomotionMode;
    }
    return result;
  }
  vm.runInNewContext(script, { exports: {}, document, window, setTimeout, clearTimeout,
    require(name) {
      if (name === "@tauri-apps/api/event") return { listen };
      assert.equal(name, "@tauri-apps/api/core");
      return { invoke };
    },
  });
  await settle();
  const forward = document.querySelectorAll("[data-move]").find(control => control.dataset.move === "forward");
  assert.equal(forward.disabled, true);
  async function chooseMode(mode) {
    const control = document.getElementById(mode + "-mode");
    assert.ok(control, mode + " mode button is present");
    assert.equal(control.hidden, false);
    assert.equal(control.disabled, false);
    control.click();
    await settle();
    assert.equal(forward.disabled, false);
  }
  return {
    document, window, actions, moves, forward, chooseMode, monitorRequests, listeners, emit,
    stick(type, dx = 0, dy = 0, pointerId = 2) {
      // The user grabs the thumb off-center. Available drag radius is 100 px.
      document.getElementById("motion-stick").fire(type, {
        clientX: 152 + dx, clientY: 180 + dy, pointerId, button: 0, isPrimary: true,
      });
    },
    press() { forward.fire("pointerdown", { button: 0, pointerId: 1 }); },
    release() { forward.fire("pointerup", { pointerId: 1 }); },
    async tick(ms) { t.mock.timers.tick(ms); await settle(); },
  };
}

test("the native monitor starts after both window event subscriptions are ready", async t => {
  let finishRegistration;
  const registering = new Promise(resolve => { finishRegistration = resolve; });
  const ui = await renderer(t, {
    beforeListen: event => event === "bumi:listener" ? registering : undefined,
  });
  ui.document.getElementById("listen-toggle").click();
  await settle();
  assert.deepEqual(ui.monitorRequests, []);
  finishRegistration();
  await settle();
  assert.deepEqual(ui.monitorRequests, [true]);
  assert.deepEqual([...ui.listeners].map(({ event }) => event).sort(), ["bumi:listener", "bumi:message"]);
  for (const { target } of ui.listeners) assert.equal(target, "bumi-control");
});

for (const [status, label] of [[0, "未启动（0）"], [2, "行走（2）"], [87, "状态码（87）"]]) {
  test(`the last queried BLE status preserves code ${status} when a gait is requested`, async t => {
    const ui = await renderer(t, { initial: { status } });
    await ui.chooseMode("walk");
    assert.equal(ui.document.getElementById("robot-status").textContent, label);
  });
}

test("an event registration failure is visible and a retry registers each listener once", async t => {
  let rejectRegistration = true;
  const ui = await renderer(t, { beforeListen(event) {
    if (rejectRegistration && event === "bumi:listener") throw new Error("event permission denied");
  } });
  const toggle = ui.document.getElementById("listen-toggle");
  toggle.click();
  await settle();
  assert.deepEqual(ui.monitorRequests, []);
  assert.match(ui.document.getElementById("error").textContent, /event permission denied/);
  assert.equal(toggle.disabled, false);

  rejectRegistration = false;
  toggle.click();
  await settle();
  assert.deepEqual(ui.monitorRequests, [true]);
  assert.equal(ui.listeners.size, 2);
  assert.equal(ui.document.getElementById("error").textContent, "");
});

test("the monitor distinguishes a status query write from the robot's response", async t => {
  const ui = await renderer(t);
  ui.document.getElementById("listen-toggle").click();
  await settle();
  const status = ui.document.querySelectorAll("[data-query]").find(control => control.dataset.query === "status");
  status.click();
  await settle();
  assert.deepEqual(ui.actions, ["status"]);

  const log = ui.document.getElementById("message-log");
  const counts = ui.document.getElementById("listener-status");
  const textOf = element => [element.textContent || "", ...element.children.map(textOf)].join(" ");
  const timestamp = "2026-11-24T10:00:00.000Z";
  ui.emit("bumi:message", { direction: "tx", receivedAt: timestamp, hex: "55 AA 05 31 05",
    size: 5, opcode: 0x31, summary: "查询状态", text: null, truncated: false });
  assert.equal(log.children.length, 1);
  assert.match(textOf(log.children[0]), /发送/);
  assert.match(textOf(log.children[0]), /55 AA 05 31 05/);
  assert.match(counts.textContent, /发送 1 条.*接收 0 条/);
  ui.emit("bumi:message", { direction: "rx", receivedAt: timestamp, hex: "55 AA 06 51 02 06",
    size: 6, opcode: 0x51, summary: "运行状态码 2", text: null, truncated: false });
  assert.equal(log.children.length, 2);
  assert.match(textOf(log.children[1]), /接收/);
  assert.match(textOf(log.children[1]), /55 AA 06 51 02 06/);
  assert.match(counts.textContent, /发送 1 条.*接收 1 条/);
  ui.document.getElementById("clear-messages").click();
  assert.match(counts.textContent, /发送 0 条.*接收 0 条/);
});

test("requesting or re-requesting walk mode never moves the robot on its own", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  await ui.tick(1000);
  await ui.chooseMode("walk");
  await ui.tick(1000);
  assert.equal(ui.actions.filter(action => action === "walk").length, 2);
  assert.deepEqual(ui.moves, []);
});

test("mode switches never initiate movement and other actions clear the selected gait", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  await ui.chooseMode("run");
  await ui.tick(1000);
  assert.deepEqual(ui.actions, ["walk", "run"]);
  const wave = ui.document.querySelectorAll("[data-command]").find(button => button.dataset.command === "wave");
  for (const mode of ["walk", "run"]) {
    await ui.chooseMode(mode);
    wave.click();
    await settle();
    assert.equal(ui.forward.disabled, true);
    ui.press();
    await ui.tick(1000);
    assert.equal(ui.moves.length, 0);
  }
  await ui.chooseMode("walk");
  assert.deepEqual(ui.actions, ["walk", "run", "walk", "wave", "run", "wave", "walk"]);
});

test("a pending or failed switch to run blocks motion until a new mode is selected", async t => {
  let rejectWrite;
  const pendingRun = new Promise((resolve, reject) => { rejectWrite = reject; });
  const ui = await renderer(t, { beforeMode: mode => mode === "run" ? pendingRun : undefined });
  await ui.chooseMode("walk");
  ui.document.getElementById("run-mode").click();
  assert.equal(ui.forward.disabled, true);
  ui.press();
  ui.document.getElementById("walk-mode").click();
  await ui.tick(1000);
  assert.deepEqual(ui.actions, ["walk", "run"]);
  rejectWrite(new Error("run mode write failed"));
  await settle();
  assert.match(ui.document.getElementById("error").textContent, /run mode write failed/);
  assert.equal(ui.forward.disabled, true);
  ui.press();
  await ui.tick(1000);
  assert.deepEqual(ui.actions, ["walk", "run"]);
  await ui.chooseMode("walk");
  assert.deepEqual(ui.moves, []);
});

test("legacy snapshots keep walk controls available and hide run", async t => {
  const ui = await renderer(t, { legacy: true });
  assert.equal(ui.document.getElementById("run-mode").hidden, true);
  await ui.chooseMode("walk");
  ui.press();
  await settle();
  ui.release();
  await settle();
  assert.deepEqual(ui.moves, [[40, 0], [0, 0]]);
});

test("NTXB exposes full-body walking through the existing run IPC command", async t => {
  const ui = await renderer(t, { initial: { connected: { id: "bumi", name: "NTXB001", rssi: -42 } } });
  assert.match(ui.document.getElementById("run-mode").textContent, /全身行走/);
  await ui.chooseMode("run");
  assert.deepEqual(ui.actions, ["run"]);
  assert.deepEqual(ui.moves, []);
});

for (const mode of [null, "future-mode"]) {
  test(`snapshot mode ${mode} keeps directions disabled despite a legacy walk flag`, async t => {
    const ui = await renderer(t, { initial: { walkMode: true, locomotionMode: mode } });
    ui.press();
    await ui.tick(1000);
    assert.deepEqual(ui.actions, []);
  });
}

for (const mode of ["walk", "run"]) {
  test(`holding a direction in ${mode} mode refreshes its low-speed vector until release`, async t => {
    const ui = await renderer(t);
    await ui.chooseMode(mode);
    ui.press();
    await settle();
    for (const id of ["walk-mode", "run-mode"]) {
      const control = ui.document.getElementById(id);
      assert.equal(control.disabled, true);
      control.click();
    }
    assert.deepEqual(ui.actions, [mode, "move"]);
    await ui.tick(99);
    assert.deepEqual(ui.moves, [[40, 0]]);
    await ui.tick(1);
    await ui.tick(100);
    assert.deepEqual(ui.moves, [[40, 0], [40, 0], [40, 0]]);
    ui.release();
    await settle();
    await ui.tick(1000);
    assert.deepEqual(ui.moves, [[40, 0], [40, 0], [40, 0], [0, 0]]);
  });
}

test("four directions follow the official x/yaw axes: forward, backward, left turn, right turn", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  const expected = {
    forward: [40, 0], backward: [-40, 0],
    left: [0, 40], right: [0, -40],
  };
  for (const [direction, vector] of Object.entries(expected)) {
    const control = ui.document.querySelectorAll("[data-move]").find(button => button.dataset.move === direction);
    assert.equal(control.disabled, false, direction);
    control.fire("pointerdown", { button: 0, pointerId: 1 });
    await settle();
    control.fire("pointerup", { pointerId: 1 });
    await settle();
  }
  assert.deepEqual(ui.moves, [
    expected.forward, [0, 0], expected.backward, [0, 0],
    expected.left, [0, 0], expected.right, [0, 0],
  ]);
});

test("portrait stick travel controls speed and maps the screen axes to forward and yaw", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  // Expected signed bytes follow the Bumi 3.2.2 portrait joystick path.
  for (const [dx, dy, vector] of [
    [-30, -40, [51, 38]], [0, 50, [-64, 0]], [0, -100, [127, 0]],
    [0, 100, [-127, 0]], [-100, 0, [0, 127]], [100, 0, [0, -127]],
    [120, -160, [102, -76]],
  ]) {
    const start = ui.moves.length;
    ui.stick("pointerdown");
    await ui.tick(200);
    assert.equal(ui.moves.length, start, "touching the thumb alone must not move the robot");
    ui.stick("pointermove", dx, dy);
    await settle();
    assert.deepEqual(ui.moves.slice(start), [vector]);
    ui.stick("pointerup", dx, dy);
    await settle();
    assert.deepEqual(ui.moves.slice(start), [vector, [0, 0]]);
  }
});

test("fast drags sample the latest deflection, and returning to center stops immediately", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  ui.stick("pointerdown");
  ui.stick("pointermove", 0, -20);
  await settle();
  await ui.tick(20);
  ui.stick("pointermove", 0, -80);
  await ui.tick(20);
  ui.stick("pointermove", 0, 50);
  await ui.tick(59);
  assert.deepEqual(ui.moves, [[25, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.moves, [[25, 0], [-64, 0]]);
  ui.stick("pointermove", 0, 0);
  await settle();
  assert.deepEqual(ui.moves, [[25, 0], [-64, 0], [0, 0]]);
  await ui.tick(500);
  assert.equal(ui.moves.length, 3);
});

test("arrow keys on the stick keep the low-speed step and release only their own direction", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  const stick = ui.document.getElementById("motion-stick");
  stick.fire("keydown", { key: "ArrowDown" });
  await settle();
  stick.fire("keydown", { key: "ArrowDown", repeat: true });
  stick.fire("keyup", { key: "ArrowLeft" });
  await settle();
  assert.deepEqual(ui.moves, [[-40, 0]]);
  stick.fire("keyup", { key: "ArrowDown" });
  await settle();
  assert.deepEqual(ui.moves, [[-40, 0], [0, 0]]);
});

for (const end of ["pointercancel", "stop", "blur"]) {
  test(`a stick ${end} stops after an in-flight write and ignores subsequent stale pointer moves`, async t => {
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    const ui = await renderer(t, { beforeMove: count => count === 1 ? first : undefined });
    await ui.chooseMode("walk");
    ui.stick("pointerdown");
    ui.stick("pointermove", 0, -100);
    ui.stick("pointermove", 100, 0);
    await ui.tick(250);
    if (end === "pointercancel") ui.stick(end);
    if (end === "stop") ui.document.getElementById("stop-move").click();
    if (end === "blur") ui.window.fire(end);
    ui.stick("pointermove", -100, 0);
    assert.deepEqual(ui.moves, [[127, 0]]);
    finish();
    await settle();
    ui.stick("pointermove", 0, 100);
    await ui.tick(500);
    assert.deepEqual(ui.moves, [[127, 0], [0, 0]]);
  });
}

test("a new stick gesture waits for the previous release's queued zero", async t => {
  let finish;
  const first = new Promise(resolve => { finish = resolve; });
  const ui = await renderer(t, { beforeMove: count => count === 1 ? first : undefined });
  await ui.chooseMode("walk");
  ui.stick("pointerdown");
  ui.stick("pointermove", 0, -100);
  ui.stick("pointerup");
  ui.stick("pointerdown", 0, 0, 3);
  ui.stick("pointermove", 100, 0, 3);
  ui.stick("lostpointercapture", 0, 0, 2);
  finish();
  await settle();
  await ui.tick(100);
  assert.deepEqual(ui.moves.slice(0, 3), [[127, 0], [0, 0], [0, -127]]);
  ui.stick("pointerup", 100, 0, 3);
  await settle();
  assert.deepEqual(ui.moves.at(-1), [0, 0]);
});

test("a 60 ms write keeps the second joystick frame at 100 ms from press", async t => {
  let finishFirst;
  const firstWrite = new Promise(resolve => { finishFirst = resolve; });
  const ui = await renderer(t, { beforeMove: count => count === 1 ? firstWrite : undefined });
  await ui.chooseMode("walk");
  ui.press();
  await ui.tick(60);
  finishFirst();
  await settle();
  await ui.tick(39);
  assert.deepEqual(ui.moves, [[40, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.moves, [[40, 0], [40, 0]]);
  ui.release();
  await settle();
  assert.deepEqual(ui.moves.at(-1), [0, 0]);
});

test("ticks missed during a write are skipped and the next available tick resumes the hold", async t => {
  let finishFirst;
  const firstWrite = new Promise(resolve => { finishFirst = resolve; });
  const ui = await renderer(t, { beforeMove: count => count === 1 ? firstWrite : undefined });
  await ui.chooseMode("walk");
  ui.press();
  for (let i = 0; i < 3; i++) await ui.tick(100);
  await ui.tick(20);
  assert.deepEqual(ui.moves, [[40, 0]]);
  finishFirst();
  await settle();
  await ui.tick(79);
  assert.deepEqual(ui.moves, [[40, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.moves, [[40, 0], [40, 0]]);
  ui.release();
  await settle();
  await ui.tick(500);
  assert.deepEqual(ui.moves, [[40, 0], [40, 0], [0, 0]]);
});

test("a slow refresh stays single-flight and losing focus puts stop next", async t => {
  let finishWrite;
  const slow = new Promise(resolve => { finishWrite = resolve; });
  const ui = await renderer(t, { beforeMove: count => count === 2 ? slow : undefined });
  await ui.chooseMode("walk");
  ui.press();
  await settle();
  await ui.tick(100);
  await ui.tick(1000);
  assert.deepEqual(ui.moves, [[40, 0], [40, 0]]);
  ui.window.fire("blur");
  assert.deepEqual(ui.moves, [[40, 0], [40, 0]]);
  finishWrite();
  await settle();
  assert.deepEqual(ui.moves, [[40, 0], [40, 0], [0, 0]]);
  await ui.tick(1000);
  assert.equal(ui.moves.length, 3);
});

test("a failed refresh triggers a zero frame and no further nonzero writes", async t => {
  const ui = await renderer(t, {
    beforeMove(count) { if (count === 2) throw new Error("Bluetooth write failed"); },
  });
  await ui.chooseMode("walk");
  ui.press();
  await settle();
  await ui.tick(100);
  await ui.tick(1000);
  assert.deepEqual(ui.moves, [[40, 0], [40, 0], [0, 0]]);
  assert.match(ui.document.getElementById("error").textContent, /Bluetooth write failed/);
});

test("release followed by another press cannot replace a queued stop", async t => {
  let finishWrite;
  const slow = new Promise(resolve => { finishWrite = resolve; });
  const ui = await renderer(t, { beforeMove: count => count === 1 ? slow : undefined });
  await ui.chooseMode("walk");
  ui.press();
  ui.release();
  ui.press();
  assert.deepEqual(ui.moves, [[40, 0]]);
  finishWrite();
  await settle();
  assert.deepEqual(ui.moves, [[40, 0], [0, 0], [40, 0]]);
  ui.release();
  await settle();
  await ui.tick(1000);
  assert.deepEqual(ui.moves, [[40, 0], [0, 0], [40, 0], [0, 0]]);
});

test("disconnecting during a hold cancels subsequent nonzero writes", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  ui.press();
  await settle();
  ui.document.getElementById("disconnect").click();
  await settle();
  await ui.tick(1000);
  assert.equal(ui.forward.disabled, true);
  assert.equal(ui.document.getElementById("disconnect").hidden, true);
  assert.deepEqual(ui.moves.filter(([vx, vyaw]) => vx || vyaw), [[40, 0]]);
});
