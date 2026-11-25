const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("bumi-control.html");
const compileRenderer = name => ts.transpileModule(read("src/" + name + ".ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const script = compileRenderer("bumi-control");
const navigationScript = new vm.Script("(function(exports){" + compileRenderer("bumi-navigation") + "\n})");
const settle = () => new Promise(resolve => setImmediate(resolve));

class Control extends EventTarget {
  dataset = {};
  value = "";
  children = [];
  open = false;
  style = { setProperty(name, value) { this[name] = value; } };
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
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
  beforeMove = () => {}, beforeGuide = () => {}, beforeMode = () => {}, beforeListen = () => {}, legacy = false, initial = {},
  scanDevices = null, beforeScan = () => {}, beforeConnect = () => {},
  remote = false, robotStatus = 1, beforeCapture = () => {}, readBattery = () => 83,
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const ids = new Map();
  const groups = new Map();
  for (const [, tag, content] of html.matchAll(/(<[a-z][\w-]*\b[^>]*>)([^<]*)/g)) {
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
      if (data[1] === "move") {
        control.textContent = content;
        control.setAttribute("aria-label", tag.match(/\baria-label="([^"]+)"/)?.[1]);
      }
      const selector = `[data-${data[1]}]`;
      if (!groups.has(selector)) groups.set(selector, []);
      groups.get(selector).push(control);
    }
  }
  const document = Object.assign(new Control(), {
    hasFocus: () => true,
    getElementById: id => ids.get(id),
    createElement: () => new Control(),
    querySelectorAll: selector => groups.get(selector) || [],
  });
  const window = Object.assign(new Control(), { setTimeout, clearTimeout, setInterval, clearInterval, confirm: () => true });
  const robot = { id: "test-bumi", name: "Bumi", rssi: -50 };
  const snapshot = {
    ...(remote ? { remoteMotionVersion: 2, remoteVoiceCommandVersion: 1, guidedMotionVersion: 1, connectionId: "test-link" } : {}),
    connected: robot, devices: [robot], available: true, walkMode: false, locomotionMode: null,
    moving: false, status: null, battery: null, listening: false, ...initial,
  };
  const actions = [];
  const commandRequests = [];
  const moves = [];
  const movementRequests = [];
  const guidanceRequests = [];
  const calls = [];
  const connectionRequests = [];
  const listeners = new Set();
  const monitorRequests = [];
  const captures = [];
  const captureStops = [];
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
  async function invoke(name, args) {
    if (name === "bumi_remote_input") {
      assert.ok(remote, "native remote capture requires an explicit user action");
      if (args.enabled) {
        assert.ok(args.events);
        captures.push(args);
        await beforeCapture();
        return "Xiaomi RC003";
      }
      captureStops.push(args.captureId);
      return;
    }
    assert.equal(name, "bumi_control");
    const { request } = args;
    calls.push(request.operation === "connect" ? `connect:${request.id}` : request.operation);
    if (["scan", "connect", "cancelConnection"].includes(request.operation)) connectionRequests.push(request);
    if (request.operation === "scan" && scanDevices) {
      await beforeScan();
      snapshot.devices = scanDevices.map(device => ({ ...device }));
    } else if (request.operation === "connect" && scanDevices) {
      await beforeConnect(request.id);
      const found = snapshot.devices.find(device => device.id === request.id);
      if (!found) throw new Error(`unknown device ${request.id}`);
      snapshot.connected = { ...found };
    } else if (request.operation === "disconnect") {
      Object.assign(snapshot, { connected: null, walkMode: false, locomotionMode: null, moving: false, status: null });
    } else if (request.operation === "listen") {
      monitorRequests.push(request.enabled);
      snapshot.listening = request.enabled;
    } else if (request.operation === "guide") {
      assert.equal(snapshot.guidedMotionVersion, 1, "older hosts reject the optional operation");
      guidanceRequests.push(JSON.parse(JSON.stringify(request)));
      await beforeGuide(request);
      snapshot.moving = !!request.direction;
    } else if (request.operation === "send") {
      const cmd = request.command;
      actions.push(cmd.action);
      commandRequests.push(JSON.parse(JSON.stringify(request)));
      if (cmd.action === "walk" || cmd.action === "run") {
        await beforeMode(cmd.action);
        snapshot.walkMode = cmd.action === "walk";
        snapshot.locomotionMode = cmd.action;
      }
      if (["dance", "wave", "handshake", "cheer", "standUp", "standToFall"].includes(cmd.action)) {
        snapshot.walkMode = false;
        snapshot.locomotionMode = null;
      }
      if (cmd.action === "battery") snapshot.battery = readBattery();
      if (cmd.action === "status") snapshot.status = robotStatus;
      if (cmd.action === "move") {
        if (!remote) assert.equal(Object.hasOwn(cmd, "vy"), false);
        movementRequests.push(JSON.parse(JSON.stringify(request)));
        assert.ok(Number.isInteger(cmd.vx) && Number.isInteger(cmd.vyaw));
        // Tauri's serialized IPC sends JavaScript -0 as an ordinary zero.
        const axes = [cmd.vx, cmd.vyaw];
        if (remote) axes.push(cmd.vy ?? 0);
        moves.push(JSON.parse(JSON.stringify(axes)));
        await beforeMove(moves.length);
        snapshot.moving = !!(cmd.vx || cmd.vyaw || cmd.vy);
      }
    }
    const result = { ...snapshot };
    if (legacy) {
      delete result.locomotionMode;
    }
    return result;
  }
  const context = vm.createContext({ exports: {}, document, window, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === "@tauri-apps/api/event") return { listen };
      if (name === "./bumi-navigation") {
        const module = {};
        navigationScript.runInContext(context)(module);
        return module;
      }
      assert.equal(name, "@tauri-apps/api/core");
      return { invoke, Channel: class {} };
    },
  });
  vm.runInContext(script, context);
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
    document, window, actions, moves, calls, forward, chooseMode, monitorRequests, listeners, emit,
    captures, captureStops, commandRequests, guidanceRequests, movementRequests, connectionRequests, robotSnapshot: snapshot,
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

test("opening a connected robot shows its name and replaces the discovery instructions", async t => {
  const connected = { id: "classroom", name: "NTXB-01", rssi: -50 };
  const ui = await renderer(t, { initial: { connected } });
  assert.equal(ui.document.getElementById("device-help").textContent, "当前设备：NTXB-01");
  assert.equal(ui.document.getElementById("operation").textContent, "已读取机器人连接状态。");
});

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
  assert.deepEqual(ui.moves, [[80, 0], [0, 0]]);
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
    assert.deepEqual(ui.moves, [[80, 0]]);
    await ui.tick(1);
    await ui.tick(100);
    assert.deepEqual(ui.moves, [[80, 0], [80, 0], [80, 0]]);
    ui.release();
    await settle();
    await ui.tick(1000);
    assert.deepEqual(ui.moves, [[80, 0], [80, 0], [80, 0], [0, 0]]);
  });
}

test("four directions follow the official x/yaw axes: forward, backward, left turn, right turn", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  const expected = {
    forward: [80, 0], backward: [-80, 0],
    left: [0, 80], right: [0, -80],
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

test("lateral stick travel uses vy proportionally, preserves vx, and sends zero on release", async t => {
  const ui = await renderer(t, { remote: true });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  assert.equal(horizontal.disabled, false);
  horizontal.value = "lateral";
  horizontal.fire("change");
  assert.deepEqual(ui.moves, []);
  for (const [dx, dy, expected] of [
    [-30, -40, [51, 0, 38]], [30, 40, [-51, 0, -38]],
    [-100, 0, [0, 0, 127]], [120, -160, [102, 0, -76]],
  ]) {
    const start = ui.moves.length;
    ui.stick("pointerdown");
    assert.equal(horizontal.disabled, true);
    ui.stick("pointermove", dx, dy);
    await settle();
    ui.stick("pointerup");
    await settle();
    assert.deepEqual(ui.moves.slice(start), [expected, stopped]);
    assert.equal(horizontal.disabled, false);
  }
  horizontal.value = "yaw";
  horizontal.fire("change");
  ui.stick("pointerdown");
  ui.stick("pointermove", -30, -40);
  await settle();
  ui.stick("pointerup");
  await settle();
  assert.deepEqual(ui.moves.slice(-2), [[51, 38, 0], stopped]);
  assert.ok(ui.movementRequests.every(request => !Object.hasOwn(request, "remoteCaptureId")));
});

test("stick arrow keys follow the selected horizontal axis", async t => {
  const ui = await renderer(t, { remote: true });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  const stick = ui.document.getElementById("motion-stick");
  horizontal.value = "lateral";
  horizontal.fire("change");
  for (const [key, vector] of [["ArrowRight", [0, 0, -80]], ["ArrowUp", [80, 0, 0]]]) {
    stick.fire("keydown", { key });
    await settle();
    stick.fire("keyup", { key });
    await settle();
    assert.deepEqual(ui.moves.slice(-2), [vector, stopped]);
  }
});

function assertDirectionLabels(ui, expected) {
  for (const button of ui.document.querySelectorAll("[data-move]")) {
    const label = expected[button.dataset.move];
    assert.equal(button.textContent, label, button.dataset.move);
    assert.equal(button["aria-label"], "按住" + label);
  }
}

const yawLabels = { left: "左转", right: "右转", forward: "前进", backward: "后退" };
const lateralLabels = { ...yawLabels, left: "左移", right: "右移" };

test("screen direction labels and their low-speed actions follow lateral mode and switching back to yaw", async t => {
  const ui = await renderer(t, { remote: true });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  assertDirectionLabels(ui, yawLabels);
  for (const [mode, labels, left, right] of [
    ["lateral", lateralLabels, [0, 0, 80], [0, 0, -80]],
    ["yaw", yawLabels, [0, 80, 0], [0, -80, 0]],
  ]) {
    const beforeChange = ui.moves.length;
    horizontal.value = mode;
    horizontal.fire("change");
    assertDirectionLabels(ui, labels);
    assert.equal(ui.moves.length, beforeChange);
    for (const [side, vector] of [["left", left], ["right", right]]) {
      const control = ui.document.querySelectorAll("[data-move]").find(button => button.dataset.move === side);
      control.fire("pointerdown", { button: 0, pointerId: 1 });
      await settle();
      assert.equal(control["aria-pressed"], "true");
      control.fire("pointerup", { pointerId: 1 });
      await settle();
      assert.deepEqual(ui.moves.slice(-2), [vector, stopped]);
      assert.equal(control["aria-pressed"], "false");
    }
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
  assert.deepEqual(ui.moves, [[-80, 0]]);
  stick.fire("keyup", { key: "ArrowDown" });
  await settle();
  assert.deepEqual(ui.moves, [[-80, 0], [0, 0]]);
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
  assert.deepEqual(ui.moves, [[80, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.moves, [[80, 0], [80, 0]]);
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
  assert.deepEqual(ui.moves, [[80, 0]]);
  finishFirst();
  await settle();
  await ui.tick(79);
  assert.deepEqual(ui.moves, [[80, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.moves, [[80, 0], [80, 0]]);
  ui.release();
  await settle();
  await ui.tick(500);
  assert.deepEqual(ui.moves, [[80, 0], [80, 0], [0, 0]]);
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
  assert.deepEqual(ui.moves, [[80, 0], [80, 0]]);
  ui.window.fire("blur");
  assert.deepEqual(ui.moves, [[80, 0], [80, 0]]);
  finishWrite();
  await settle();
  assert.deepEqual(ui.moves, [[80, 0], [80, 0], [0, 0]]);
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
  assert.deepEqual(ui.moves, [[80, 0], [80, 0], [0, 0]]);
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
  assert.deepEqual(ui.moves, [[80, 0]]);
  finishWrite();
  await settle();
  assert.deepEqual(ui.moves, [[80, 0], [0, 0], [80, 0]]);
  ui.release();
  await settle();
  await ui.tick(1000);
  assert.deepEqual(ui.moves, [[80, 0], [0, 0], [80, 0], [0, 0]]);
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
  assert.deepEqual(ui.moves.filter(([vx, vyaw]) => vx || vyaw), [[80, 0]]);
});

test("one nearby robot connects from the single button without a device choice", async t => {
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] },
    scanDevices: [{ id: "only-bumi", name: "Bumi", rssi: -40 }],
  });
  const choice = ui.document.getElementById("device-choice");
  assert.equal(choice.hidden, true);
  ui.document.getElementById("connect").click();
  await settle();
  assert.equal(choice.hidden, true);
  assert.deepEqual(ui.calls.filter(call => call === "scan" || String(call).startsWith("connect:")), ["scan", "connect:only-bumi"]);
  assert.deepEqual(ui.actions, ["battery", "status"]);
  assert.equal(ui.document.getElementById("battery").textContent, "83%");
  assert.equal(ui.document.getElementById("robot-status").textContent, "准备（1）");
  assert.match(ui.document.getElementById("operation").textContent, /电量和状态已更新/);
  await ui.tick(80_000);
  assert.equal(ui.calls.filter(call => call === "scan").length, 1);
});

test("a battery timeout preserves the last status and the next query can report zero percent", async t => {
  let ready = false;
  const ui = await renderer(t, {
    initial: { status: 2 },
    readBattery() {
      if (!ready) throw new Error("4 秒内未收到 Bumi 的蓝牙通知。");
      return 0;
    },
  });
  const query = ui.document.querySelectorAll("[data-query]").find(item => item.dataset.query === "battery");
  query.click();
  await settle();
  assert.equal(ui.document.getElementById("battery").textContent, "—");
  assert.equal(ui.document.getElementById("robot-status").textContent, "行走（2）");
  assert.match(ui.document.getElementById("error").textContent, /未收到 Bumi 的蓝牙通知/);
  assert.equal(ui.document.getElementById("operation").textContent, "本次电量查询未完成。");
  ready = true;
  query.click();
  await settle();
  assert.equal(ui.document.getElementById("battery").textContent, "0%");
  assert.equal(ui.document.getElementById("error").textContent, "");
});

test("several robots wait for a choice and connect only the selected device", async t => {
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] },
    scanDevices: [
      { id: "a", name: "Bumi A", rssi: -40 },
      { id: "b", name: "NTXB B", rssi: -55 },
    ],
  });
  ui.document.getElementById("connect").click();
  await settle();
  const choice = ui.document.getElementById("device-choice");
  assert.equal(choice.hidden, false);
  assert.deepEqual(ui.calls.filter(call => String(call).startsWith("connect:")), []);
  assert.match(ui.document.getElementById("operation").textContent, /请选择/);
  await ui.tick(80_000);
  assert.equal(ui.calls.filter(call => call === "scan").length, 1);
  assert.equal(ui.calls.some(call => call.startsWith("connect:")), false);
  const picker = ui.document.getElementById("device-picker");
  picker.value = "b";
  picker.fire("change");
  await settle();
  assert.deepEqual(ui.calls.filter(call => String(call).startsWith("connect:")), ["connect:b"]);
  assert.deepEqual(ui.actions, ["battery", "status"]);
  assert.equal(choice.hidden, true);
});

test("an empty scan retries every 20 seconds and stops after three automatic retries", async t => {
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] },
    scanDevices: [],
  });
  await click(ui, "connect");
  const scanCount = () => ui.calls.filter(call => call === "scan").length;
  assert.equal(scanCount(), 1);
  for (let retry = 1; retry <= 3; retry++) {
    await ui.tick(19_999);
    assert.equal(scanCount(), retry);
    await ui.tick(1);
    assert.equal(scanCount(), retry + 1);
  }
  await ui.tick(80_000);
  assert.equal(scanCount(), 4);
  assert.equal(ui.document.getElementById("cancel-connect").hidden, true);
  assert.equal(ui.document.getElementById("device-choice").hidden, true);
  assert.equal(ui.calls.some(call => String(call).startsWith("connect:")), false);
  assert.deepEqual(ui.actions, []);
  await click(ui, "connect");
  assert.equal(scanCount(), 5, "the user can start another connection cycle after exhaustion");
});

test("a cancelled retry wait cannot start another scan, and a new click can connect", async t => {
  const devices = [];
  const ui = await renderer(t, { initial: { connected: null, devices: [] }, scanDevices: devices });
  await click(ui, "connect");
  await ui.tick(20_000);
  assert.equal(ui.calls.filter(call => call === "scan").length, 2);
  await ui.tick(19_999);
  await click(ui, "cancel-connect");
  await ui.tick(80_000);
  assert.equal(ui.calls.filter(call => call === "scan").length, 2);
  assert.equal(ui.document.getElementById("cancel-connect").hidden, true);
  devices.push({ id: "nearby", name: "Bumi", rssi: -40 });
  await click(ui, "connect");
  assert.deepEqual(ui.calls.filter(call => call.startsWith("connect:")), ["connect:nearby"]);
  assert.deepEqual(ui.actions, ["battery", "status"]);
});

test("a full native scan window counts towards the twenty-second retry interval", async t => {
  let finishScan;
  let scans = 0;
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] }, scanDevices: [],
    beforeScan() {
      if (++scans === 1) return new Promise(resolve => { finishScan = resolve; });
    },
  });
  await click(ui, "connect");
  await ui.tick(20_000);
  assert.equal(scans, 1, "a slow native scan must finish before starting another");
  finishScan();
  await settle();
  await ui.tick(0);
  assert.equal(scans, 2);
});

test("cancelling an in-flight retry ignores a device returned by the cancelled scan", async t => {
  let finishScan;
  const devices = [];
  let scans = 0;
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] }, scanDevices: devices,
    beforeScan() {
      if (++scans === 2) return new Promise(resolve => { finishScan = resolve; });
    },
  });
  await click(ui, "connect");
  await ui.tick(20_000);
  assert.equal(scans, 2);
  await click(ui, "cancel-connect");
  const scansSent = ui.connectionRequests.filter(request => request.operation === "scan");
  assert.ok(scansSent[1].attemptId, "cancellation targets the request in flight");
  const cancel = ui.connectionRequests.find(request => request.operation === "cancelConnection");
  assert.equal(cancel?.attemptId, scansSent[1].attemptId);
  devices.push({ id: "late", name: "Bumi", rssi: -40 });
  finishScan();
  await settle();
  await ui.tick(80_000);
  assert.equal(scans, 2);
  assert.equal(ui.calls.some(call => call.startsWith("connect:")), false);
  assert.deepEqual(ui.actions, []);
  assert.equal(ui.document.getElementById("connection-state").dataset.state, "offline");
  assert.equal(ui.document.getElementById("connect").disabled, false);
});

test("retrying an explicitly selected robot keeps that device and stops on success", async t => {
  let first = true;
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] },
    scanDevices: [
      { id: "a", name: "Bumi A", rssi: -35 }, { id: "b", name: "Bumi B", rssi: -60 },
    ],
    beforeConnect() {
      if (first) { first = false; throw new Error("temporarily unreachable"); }
    },
  });
  await click(ui, "connect");
  const picker = ui.document.getElementById("device-picker");
  picker.value = "b";
  picker.fire("change");
  await settle();
  const connections = () => ui.calls.filter(call => call.startsWith("connect:"));
  assert.deepEqual(connections(), ["connect:b"]);
  await ui.tick(19_999);
  assert.deepEqual(connections(), ["connect:b"]);
  await ui.tick(1);
  assert.deepEqual(connections(), ["connect:b", "connect:b"]);
  assert.deepEqual(ui.actions, ["battery", "status"]);
  await ui.tick(80_000);
  assert.deepEqual(connections(), ["connect:b", "connect:b"]);
  assert.equal(ui.document.getElementById("cancel-connect").hidden, true);
});

test("a late handshake after cancellation cannot show a connection or start device queries", async t => {
  let finishHandshake;
  const ui = await renderer(t, {
    initial: { connected: null, devices: [] },
    scanDevices: [{ id: "late-link", name: "Bumi", rssi: -50 }],
    beforeConnect: () => new Promise(resolve => { finishHandshake = resolve; }),
  });
  await click(ui, "connect");
  assert.ok(ui.calls.includes("connect:late-link"));
  await click(ui, "cancel-connect");
  finishHandshake();
  await settle();
  await ui.tick(80_000);
  assert.equal(ui.document.getElementById("connection-state").dataset.state, "offline");
  assert.equal(ui.document.getElementById("connect").disabled, false);
  assert.equal(ui.calls.filter(call => call === "scan").length, 1);
  assert.deepEqual(ui.actions, []);
});

test("a voice phrase jogs in the selected gait and then stops", async t => {
  const ui = await renderer(t);
  await ui.chooseMode("walk");
  const input = ui.document.getElementById("voice-command");
  input.value = "前进。";
  ui.document.getElementById("voice-run").click();
  await settle();
  assert.ok(ui.moves.some(([vx, vyaw]) => vx === 80 && vyaw === 0));
  await ui.tick(800);
  await settle();
  assert.deepEqual(ui.moves.at(-1), [0, 0]);
});

function pushKeys(capture, ...keys) {
  capture.events.onmessage({ keys, sampledAt: Date.now() });
}

function pushVoice(capture, voiceCommand, { sampledAt = Date.now(), voiceId = (capture.lastVoiceId || 0) + 1 } = {}) {
  capture.lastVoiceId = Math.max(capture.lastVoiceId || 0, voiceId);
  capture.events.onmessage({ keys: [], sampledAt, voiceId, voiceCommand });
}

async function click(ui, id) {
  const button = ui.document.getElementById(id);
  assert.ok(button && !button.disabled && !button.hidden, id + " should be available");
  button.click();
  await settle();
}

async function beginRemote(ui) {
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  assert.equal(ui.captures.length, 1);
  return ui.captures[0];
}

const stopped = [0, 0, 0];
const nonzero = axes => axes.some(value => value !== 0);

test("a final Xiaomi dance command writes one posture action directly from the armed Bumi remote", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  assert.equal(capture.voiceCommands, true);
  pushVoice(capture, "跳舞。");
  pushVoice(capture, "跳舞。", { voiceId: 1 });
  await settle();
  assert.deepEqual(ui.actions.filter(action => action === "dance"), ["dance"]);
  const dance = ui.commandRequests.find(request => request.command.action === "dance");
  assert.equal(dance.remoteCaptureId, capture.captureId);
  assert.equal(dance.voiceId, 1);
  assert.equal(ui.robotSnapshot.locomotionMode, null);
  assert.equal(ui.document.getElementById("remote-shield").open, false);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("directions held during speech never become release events and a spoken stop preempts an in-flight turn", async t => {
  let finish;
  const firstWrite = new Promise(resolve => { finish = resolve; });
  const ui = await renderer(t, {
    remote: true, robotStatus: 2, beforeMove: count => count === 1 ? firstWrite : undefined,
  });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushKeys(capture, "left");
  pushVoice(capture, "跳舞");
  pushVoice(capture, "走到讲台");
  await settle();
  assert.equal(ui.document.getElementById("remote-shield").open, true);
  assert.equal(ui.actions.includes("dance"), false);
  assert.deepEqual(ui.moves, [[0, 80, 0]]);
  pushVoice(capture, "停止");
  pushKeys(capture, "right");
  finish();
  await settle();
  assert.deepEqual(ui.moves, [[0, 80, 0], stopped]);
  assert.equal(ui.document.getElementById("remote-shield").open, false);
});

test("diagnostic, stale, and superseded Xiaomi voice events cannot dispatch robot actions", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  await click(ui, "remote-diagnose");
  const diagnostic = ui.captures[0];
  pushKeys(diagnostic);
  pushVoice(diagnostic, "跳舞");
  assert.equal(ui.actions.includes("dance"), false);
  await click(ui, "remote-diagnose");
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  const previous = ui.captures[1];
  pushKeys(previous);
  ui.window.fire("blur");
  await settle();
  await click(ui, "remote-toggle");
  const active = ui.captures[2];
  pushKeys(active);
  pushVoice(previous, "跳舞");
  active.events.onmessage({ keys: [], sampledAt: Date.now(), voiceId: 1, voiceError: "无法确认遥控器来源。" });
  assert.match(ui.document.getElementById("remote-shield-voice").textContent, /来源/);
  pushVoice(active, "跳舞", { voiceId: 1 });
  pushVoice(active, "不要跳舞");
  pushVoice(active, "跳舞", { sampledAt: Date.now() - 2_000 });
  await settle();
  assert.equal(ui.actions.includes("dance"), false);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("recognized speech cannot keep an expired Xiaomi direction listener armed", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  for (let i = 0; i < 7; i++) {
    await ui.tick(100);
    pushVoice(capture, "不要动");
  }
  assert.equal(ui.document.getElementById("remote-shield").open, false);
  pushVoice(capture, "跳舞");
  assert.equal(ui.actions.includes("dance"), false);
});

test("asking an armed Bumi remote for a destination opens the route guidance without issuing movement", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  const guidance = ui.document.getElementById("nav-status");
  const previous = guidance.textContent;
  pushVoice(capture, "走到讲台。");
  await settle();
  assert.notEqual(guidance.textContent, previous);
  assert.match(guidance.textContent, /讲台|目的地|地点|地图|位置/);
  assert.deepEqual(ui.moves, []);
  assert.deepEqual(ui.guidanceRequests, []);
});

function prepareNearbyGoal(ui, heading = 1) {
  const grid = ui.document.getElementById("nav-grid");
  const mode = ui.document.getElementById("nav-mode");
  mode.value = "pose";
  mode.fire("change");
  ui.document.getElementById("nav-facing").value = String(heading);
  grid.children[0].click();
  mode.value = "goal";
  mode.fire("change");
  ui.document.getElementById("nav-name").value = "讲台";
  grid.children[1].click();
}

test("a planned Bumi route drives only the current held leg and awaits observed arrival", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  await ui.chooseMode("walk");
  prepareNearbyGoal(ui);
  await click(ui, "remote-toggle");
  const capture = ui.captures[0];
  pushKeys(capture);
  pushVoice(capture, "走到讲台");
  await settle();
  assert.equal(ui.document.getElementById("nav-route").hidden, false);
  assert.deepEqual(ui.guidanceRequests, []);
  const hold = ui.document.getElementById("nav-drive");
  assert.equal(hold.disabled, false);
  hold.fire("pointerdown", { button: 0, pointerId: 1, isPrimary: true });
  await settle();
  assert.equal(ui.guidanceRequests.length, 1);
  const start = ui.guidanceRequests[0];
  assert.equal(start.captureId, capture.captureId);
  assert.equal(start.direction, "forward");
  assert.ok(start.pressId > 0);
  assert.deepEqual(ui.moves, [], "guided steps use a separate native operation");
  hold.fire("pointerup", { button: 0, pointerId: 1, isPrimary: true });
  await settle();
  assert.ok(ui.guidanceRequests.some(request => request.pressId === start.pressId && !request.direction));
  const beforeConfirm = ui.guidanceRequests.length;
  await click(ui, "nav-confirm");
  assert.match(ui.document.getElementById("nav-status").textContent, /已到达|已确认.*讲台|抵达/);
  assert.equal(ui.guidanceRequests.length, beforeConfirm, "confirming position never starts another leg");
});

test("spoken Bumi route execution stops each pulse and requires a fresh observed pose before changing legs", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  await ui.chooseMode("walk");
  // B1 is to the right, so a robot facing up must turn before walking.
  prepareNearbyGoal(ui, 0);
  await click(ui, "remote-toggle");
  const capture = ui.captures[0];
  pushKeys(capture);
  pushVoice(capture, "走到讲台");
  pushVoice(capture, "已到位");
  const confirm = ui.document.getElementById("nav-confirm");
  assert.equal(confirm.disabled, true);
  assert.deepEqual(ui.guidanceRequests, []);

  async function keepRemoteAlive(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      pushKeys(capture);
      await ui.tick(100);
    }
  }
  for (const expected of ["right", "forward"]) {
    const first = ui.guidanceRequests.length;
    pushVoice(capture, "执行本段");
    const voiceId = capture.lastVoiceId;
    await settle();
    assert.equal(ui.guidanceRequests[first]?.direction, expected);
    pushVoice(capture, "已到位");
    assert.equal(confirm.disabled, true, "confirmation while motion is active is ignored");
    await keepRemoteAlive(400);
    const writes = ui.guidanceRequests.slice(first);
    assert.ok(writes.filter(request => request.direction).every(request =>
      request.direction === expected && request.voiceId === voiceId));
    assert.ok(writes.every(request => request.captureId === capture.captureId && request.pressId === writes[0].pressId));
    assert.equal(writes.at(-1).direction, undefined, "the pulse requests zero speed even with a healthy remote");
    assert.equal(confirm.disabled, false);
    const stoppedAt = ui.guidanceRequests.length;
    pushVoice(capture, "执行本段", { voiceId });
    await keepRemoteAlive(600);
    assert.equal(ui.guidanceRequests.length, stoppedAt, "replayed transcripts cannot repeat a completed pulse");
    pushVoice(capture, "已到位");
    pushVoice(capture, "已到位", { voiceId: capture.lastVoiceId });
    await settle();
    assert.equal(ui.guidanceRequests.length, stoppedAt, "confirming a turn never starts the following step");
  }
  assert.match(ui.document.getElementById("nav-status").textContent, /已确认到达讲台/);
  assert.equal(ui.document.getElementById("nav-route").hidden, true);
  assert.deepEqual(ui.moves, []);
});

test("a failed guided stop discards the pose and blocks both arrival confirmation and a stale dance", async t => {
  const ui = await renderer(t, {
    remote: true, robotStatus: 2,
    beforeGuide: request => { if (!request.direction) throw new Error("stop not confirmed"); },
  });
  await ui.chooseMode("walk");
  prepareNearbyGoal(ui);
  await click(ui, "remote-toggle");
  const capture = ui.captures[0];
  pushKeys(capture);
  pushVoice(capture, "走到讲台");
  const hold = ui.document.getElementById("nav-drive");
  hold.fire("pointerdown", { button: 0, pointerId: 3, isPrimary: true });
  await settle();
  hold.fire("pointerup", { pointerId: 3 });
  await settle();
  assert.equal(ui.document.getElementById("remote-shield").open, false);
  assert.equal(ui.document.getElementById("nav-route").hidden, true);
  assert.match(ui.document.getElementById("error").textContent, /stop not confirmed/);
  pushVoice(capture, "跳舞");
  assert.equal(ui.actions.includes("dance"), false);
});

test("an older Bumi host can still drive with keys while voice actions remain unavailable", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteVoiceCommandVersion: undefined } });
  const capture = await beginRemote(ui);
  assert.notEqual(capture.voiceCommands, true);
  pushKeys(capture);
  pushVoice(capture, "跳舞");
  await settle();
  assert.equal(ui.actions.includes("dance"), false);
  pushKeys(capture, "up");
  await settle();
  pushKeys(capture);
  await settle();
  assert.deepEqual(ui.moves, [[80, 0, 0], stopped]);
});

test("driving opens a shield that swallows remote keyboard events and closes with the session", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const shield = ui.document.getElementById("remote-shield");
  assert.equal(shield.open, false);
  await ui.chooseMode("walk");
  ui.document.getElementById("remote-diagnose").click();
  await settle();
  assert.equal(shield.open, false, "key check does not cover the page");
  ui.window.fire("blur");
  await settle();
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  assert.equal(shield.open, true);
  const key = new Event("keydown", { cancelable: true });
  key.key = "Enter";
  ui.window.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  ui.document.getElementById("remote-shield-close").click();
  await settle();
  assert.equal(shield.open, false);
  assert.equal(ui.captures.length, 2);
  assert.equal(ui.captureStops.length, 2);
});

test("remote diagnostics can display a key without connecting to a robot or sending a motion frame", async t => {
  const ui = await renderer(t, { remote: true, initial: { connected: null, devices: [] } });
  await click(ui, "remote-diagnose");
  const capture = ui.captures[0];
  pushKeys(capture);
  pushKeys(capture, "left");
  await settle();
  assert.match(ui.document.getElementById("remote-status").textContent, /左|left/i);
  await ui.tick(500);
  pushKeys(capture);
  assert.deepEqual(ui.moves, []);
});

test("remote driving queries the robot's actual walking state before enabling any movement", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 1 });
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  assert.ok(ui.actions.includes("status"));
  if (ui.captures.length) {
    pushKeys(ui.captures[0]);
    pushKeys(ui.captures[0], "up");
  }
  await ui.tick(500);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("driving accepts a fresh single remote key, keeps forward/backward straight and waits for neutral after a chord", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture, "down");
  await ui.tick(200);
  assert.deepEqual(ui.moves.filter(nonzero), [], "a key already held when arming must not start motion");
  pushKeys(capture);
  pushKeys(capture, "up");
  await settle();
  const forward = ui.moves.at(-1);
  assert.ok(forward[0] > 0);
  assert.equal(ui.movementRequests.at(-1).remoteCaptureId, capture.captureId);
  assert.deepEqual(forward.slice(1), [0, 0]);
  pushKeys(capture, "up");
  await settle();
  assert.equal(ui.moves.filter(nonzero).length, 1, "duplicate key state must not write again");
  pushKeys(capture, "up", "down");
  await settle();
  assert.deepEqual(ui.moves.at(-1), stopped);
  const stoppedAt = ui.moves.length;
  pushKeys(capture, "down");
  await ui.tick(250);
  assert.equal(ui.moves.length, stoppedAt);
  pushKeys(capture);
  pushKeys(capture, "down");
  await settle();
  assert.deepEqual(ui.moves.at(-1), [-forward[0], 0, 0]);
  assert.equal(ui.movementRequests.at(-1).remoteCaptureId, capture.captureId);
  pushKeys(capture);
  await settle();
  assert.deepEqual(ui.moves.at(-1), stopped);
  assert.equal(Object.hasOwn(ui.movementRequests.at(-1), "remoteCaptureId"), false);
});

test("remote left and right hold a fixed yaw until release even with the screen stick set to lateral", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  assert.equal(horizontal.disabled, false);
  horizontal.value = "lateral";
  horizontal.fire("change");
  await click(ui, "remote-toggle");
  const capture = ui.captures[0];
  pushKeys(capture);
  for (const [key, yaw] of [["left", 80], ["right", -80]]) {
    const start = ui.moves.length;
    pushKeys(capture, key);
    await settle();
    for (let i = 0; i < 6; i++) {
      pushKeys(capture, key);
      await ui.tick(100);
    }
    const frames = ui.moves.slice(start);
    assert.ok(frames.length > 1);
    for (const frame of frames) assert.deepEqual(frame, [0, yaw, 0]);
    assert.ok(ui.movementRequests.slice(start).every(request => request.remoteCaptureId === capture.captureId));
    pushKeys(capture);
    await settle();
    assert.deepEqual(ui.moves.at(-1), stopped);
  }
});

for (const end of ["blur", "device removal", "stop button", "page hidden"]) {
  test(end + " queues stop behind an in-flight remote write and rejects stale input", async t => {
    let finish;
    const busy = new Promise(resolve => { finish = resolve; });
    const ui = await renderer(t, { remote: true, robotStatus: 2, beforeMove: count => count === 1 ? busy : undefined });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    pushKeys(capture, "up");
    if (end === "blur") ui.window.fire("blur");
    if (end === "device removal") capture.events.onmessage({ keys: [], sampledAt: Date.now(), error: "RC003 disconnected" });
    if (end === "stop button") ui.document.getElementById("stop-move").click();
    if (end === "page hidden") {
      ui.document.hidden = true;
      ui.document.fire("visibilitychange");
    }
    pushKeys(capture);
    pushKeys(capture, "down");
    await ui.tick(200);
    assert.equal(ui.moves.length, 1, "a zero frame waits for the current write");
    finish();
    await settle();
    await ui.tick(500);
    assert.equal(ui.moves.length, 2);
    assert.deepEqual(ui.moves[1], stopped);
  });
}

test("stale or missing remote heartbeats cancel movement until a new capture", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushKeys(capture, "up");
  await settle();
  assert.ok(ui.moves.at(-1)[0] > 0);
  for (let i = 0; i < 8; i++) await ui.tick(100);
  assert.deepEqual(ui.moves.at(-1), stopped, "holding a key cannot keep moving without native samples");
  const stoppedAt = ui.moves.length;
  capture.events.onmessage({ keys: ["down"], sampledAt: Date.now() - 3000 });
  pushKeys(capture);
  pushKeys(capture, "up");
  await ui.tick(200);
  assert.equal(ui.moves.length, stoppedAt);
});

test("ordinary keyboard arrows cannot drive or turn the robot while the remote owns motion", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  const stick = ui.document.getElementById("motion-stick");
  stick.fire("keydown", { key: "ArrowLeft" });
  stick.fire("keyup", { key: "ArrowLeft" });
  await ui.tick(100);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

for (const version of [undefined, 3]) {
  test(`missing or unknown motion capability (${version}) keeps ordinary yaw and disables lateral and remote driving`, async t => {
    const ui = await renderer(t, { remote: true, initial: { remoteMotionVersion: version } });
    await ui.chooseMode("walk");
    assert.equal(ui.document.getElementById("stick-horizontal").disabled, true);
    assert.equal(ui.document.getElementById("remote-toggle").disabled, true);
    ui.stick("pointerdown");
    ui.stick("pointermove", -30, -40);
    await settle();
    ui.stick("pointerup");
    await settle();
    assert.deepEqual(ui.moves, [[51, 38, 0], stopped]);
    assert.ok(ui.movementRequests.every(request => !Object.hasOwn(request, "remoteCaptureId")));
  });
}

test("losing three-axis support clears lateral selection before the next gesture", async t => {
  const ui = await renderer(t, { remote: true });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  horizontal.value = "lateral";
  horizontal.fire("change");
  delete ui.robotSnapshot.remoteMotionVersion;
  const status = ui.document.querySelectorAll("[data-query]").find(button => button.dataset.query === "status");
  status.click();
  await settle();
  assert.equal(horizontal.disabled, true);
  assert.equal(horizontal.value, "yaw");
  assertDirectionLabels(ui, yawLabels);
  ui.stick("pointerdown");
  ui.stick("pointermove", -50, 0);
  await settle();
  ui.stick("pointerup");
  await settle();
  assert.deepEqual(ui.moves, [[0, 64, 0], stopped]);
});

test("the original three-axis host supports screen lateral motion but cannot arm remote yaw", async t => {
  const ui = await renderer(t, { remote: true, initial: { remoteMotionVersion: 1 } });
  await ui.chooseMode("walk");
  assert.equal(ui.document.getElementById("remote-toggle").disabled, true);
  const horizontal = ui.document.getElementById("stick-horizontal");
  assert.equal(horizontal.disabled, false);
  horizontal.value = "lateral";
  horizontal.fire("change");
  ui.stick("pointerdown");
  ui.stick("pointermove", 50, 0);
  await settle();
  ui.stick("pointerup");
  await settle();
  assert.deepEqual(ui.moves, [[0, 0, -64], stopped]);
  assert.ok(ui.movementRequests.every(request => !Object.hasOwn(request, "remoteCaptureId")));
});

test("a capture completing after blur cannot re-enable an old session", async t => {
  let finish;
  const registration = new Promise(resolve => { finish = resolve; });
  const ui = await renderer(t, { remote: true, robotStatus: 2, beforeCapture: () => registration });
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  assert.equal(ui.captures.length, 1);
  const old = ui.captures[0];
  ui.window.fire("blur");
  finish();
  await settle();
  pushKeys(old);
  pushKeys(old, "down");
  await ui.tick(250);
  assert.ok(ui.captureStops.includes(old.captureId));
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("disconnecting and reconnecting a robot requires a new remote session and a fresh press", async t => {
  const robot = { id: "test-bumi", name: "Bumi", rssi: -50 };
  const ui = await renderer(t, { remote: true, robotStatus: 2, scanDevices: [robot] });
  const old = await beginRemote(ui);
  pushKeys(old);
  pushKeys(old, "up");
  await settle();
  await click(ui, "disconnect");
  await ui.tick(100);
  await click(ui, "connect");
  await ui.chooseMode("walk");
  const start = ui.moves.length;
  pushKeys(old);
  pushKeys(old, "down");
  await ui.tick(200);
  assert.deepEqual(ui.moves.slice(start).filter(nonzero), []);
  await click(ui, "remote-toggle");
  const current = ui.captures.at(-1);
  assert.notEqual(current.captureId, old.captureId);
  pushKeys(current);
  pushKeys(current, "left");
  await settle();
  assert.deepEqual(ui.moves.at(-1), [0, 80, 0]);
  assert.equal(ui.movementRequests.at(-1).remoteCaptureId, current.captureId);
  pushKeys(current);
  await settle();
  assert.deepEqual(ui.moves.at(-1), stopped);
  pushKeys(current, "up");
  await settle();
  assert.ok(ui.moves.at(-1)[0] > 0);
  pushKeys(current);
  await settle();
  assert.deepEqual(ui.moves.at(-1), stopped);
});

test("BLE link loss discards only the matching connection and a late movement response cannot restore it", async t => {
  let finish;
  const firstWrite = new Promise(resolve => { finish = resolve; });
  const ui = await renderer(t, {
    initial: { connectionId: "current-link" }, remote: true, robotStatus: 2,
    beforeMove: count => count === 1 ? firstWrite : undefined,
  });
  const capture = await beginRemote(ui);
  assert.ok([...ui.listeners].some(listener => listener.event === "bumi:disconnected" && listener.target === "bumi-control"));
  ui.emit("bumi:disconnected", { id: "test-bumi", connectionId: "older-link" });
  ui.emit("bumi:disconnected", { id: "different-robot", connectionId: "current-link" });
  pushKeys(capture);
  pushKeys(capture, "down");
  assert.equal(ui.movementRequests.length, 1);
  assert.equal(ui.movementRequests[0].remoteCaptureId, capture.captureId);
  ui.emit("bumi:disconnected", { id: "test-bumi", connectionId: "current-link" });
  assert.ok(ui.captureStops.includes(capture.captureId));
  pushKeys(capture);
  pushKeys(capture, "up");
  finish();
  await settle();
  await ui.tick(500);
  assert.deepEqual(ui.document.getElementById("connection-state").dataset.state, "offline");
  assert.match(ui.document.getElementById("remote-status").textContent, /停止状态未知/);
  assert.equal(ui.movementRequests.length, 1, "the disconnected transport cannot be sent stop or replayed movement");
});

test("a native release that overtakes a short tap sends stop and leaves the remote ready for a fresh press", async t => {
  let rejectMove;
  const write = new Promise((_, reject) => { rejectMove = reject; });
  const ui = await renderer(t, {
    remote: true, robotStatus: 2, beforeMove: count => count === 1 ? write : undefined,
  });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushKeys(capture, "up");
  pushKeys(capture);
  rejectMove("遥控方向键已释放或遥控会话已结束。");
  await settle();
  assert.deepEqual(ui.moves[1], stopped);
  assert.equal(ui.captureStops.length, 0);
  pushKeys(capture, "down");
  await settle();
  assert.ok(ui.moves.at(-1)[0] < 0);
  assert.equal(ui.movementRequests.at(-1).remoteCaptureId, capture.captureId);
  pushKeys(capture);
  await settle();
  assert.deepEqual(ui.moves.at(-1), stopped);
});
