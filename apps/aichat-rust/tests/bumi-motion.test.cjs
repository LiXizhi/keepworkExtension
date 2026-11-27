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
const classroomModules = Object.fromEntries(["bumi-workspace", "bumi-chat", "bumi-classroom-vision", "bumi-route", "bumi-walk", "bumi-voice-commands", "bumi-voice-input", "bumi-voice-control"].map(name =>
  ["./" + name, new vm.Script("(function(exports){" + compileRenderer(name) + "\n})")]));
const embodiedScript = new vm.Script("(function(exports){" + compileRenderer("bumi-embodied") + "\n})");
const visionScript = new vm.Script("(function(exports){" + compileRenderer("bumi-vision") + "\n})");
const settle = () => new Promise(resolve => setImmediate(resolve));

class Control extends EventTarget {
  dataset = {};
  value = "";
  children = [];
  open = false;
  style = { setProperty(name, value) { this[name] = value; } };
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.fire("close"), 0);
  }
  focus() {}
  setAttribute(name, value) { this[name] = value; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture(id) { if (this.captured === id) this.captured = undefined; }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(c => c !== child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  insertBefore(child) { return this.appendChild(child); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
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
  readVoiceModeStatus = mode => mode === "walk" ? 2 : 3,
  readTeachList = actions => actions, classroom,
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const ids = new Map();
  const groups = new Map();
  const ancestors = [];
  for (const [, tag, closing, name, content] of html.matchAll(/(<(\/?)([a-z][\w-]*)\b[^>]*>)([^<]*)/g)) {
    if (closing) { if (ancestors.at(-1)?.tagName === name.toUpperCase()) ancestors.pop(); continue; }
    const control = new Control();
    control.tagName = name.toUpperCase();
    ancestors.at(-1)?.appendChild(control);
    if (!["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"].includes(name)) ancestors.push(control);
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (id) { assert.ok(!ids.has(id), id); ids.set(id, control); control.id = id; }
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
  const classroomRequests = [];
  const previewLabels = [];
  const previewLabelHistory = [];
  const capturedLabels = [];
  const snapshotPaint = { images: [], labels: [] };
  const encodedFrameSizes = [];
  let videoFramesRequested = 0;
  let media;
  if (classroom) {
    const storage = classroom.storage ?? new Map();
    if (!classroom.uncalibrated) storage.set("keepwork.bumi.vision-calibration.v1", JSON.stringify({
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      calibratedCamera: { deviceId: "classroom-camera", width: 640, height: 480 },
    }));
    window.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
    const track = Object.assign(new EventTarget(), { stop() {}, getSettings: () => ({ deviceId: "classroom-camera" }) });
    media = { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } };
    const pixels = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    const context2d = {
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, clearRect() {}, drawImage() {},
      save() {}, restore() {}, translate() {}, scale() {},
      fillRect() {}, fillText(text) { capturedLabels.push(text); }, getImageData: (_x, _y, w, h) => pixels(w, h), createImageData: pixels, putImageData() {},
    };
    window.Image = class {
      naturalWidth = classroom.uncalibrated ? 640 : 1024;
      naturalHeight = classroom.uncalibrated ? 480 : 512;
      set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
      get src() { return this.url; }
    };
    ids.get("vision-snapshot-canvas").getContext = () => ({ ...context2d,
      drawImage(source) { snapshotPaint.images.push(source.src); snapshotPaint.labels.length = 0; },
      fillText(label) { snapshotPaint.labels.push(label); },
    });
    Object.assign(ids.get("vision-overlay"), { width: 320, height: 240,
      getContext: () => ({ ...context2d,
        clearRect() { previewLabels.length = 0; },
        fillText(text) { previewLabels.push(text); previewLabelHistory.push(text); },
      }),
    });
    Object.assign(ids.get("vision-video"), {
      videoWidth: 640, videoHeight: 480, readyState: 4, play: async () => {},
      requestVideoFrameCallback(cb) { queueMicrotask(cb); return ++videoFramesRequested; }, cancelVideoFrameCallback() {},
    });
    document.createElement = tag => {
      if (tag !== "canvas") return new Control();
      return Object.assign(new Control(), { getContext: () => context2d,
        toDataURL() {
          encodedFrameSizes.push([this.width, this.height]);
          return "data:image/jpeg;base64," + Buffer.from("jpeg" + videoFramesRequested).toString("base64");
        } });
    };
  }
  const robot = { id: "test-bumi", name: "Bumi", rssi: -50 };
  const snapshot = {
    ...(remote ? { remoteMotionVersion: 2, remoteVoiceCommandVersion: 1, remoteVoiceGestures: true,
      remoteVoiceContinue: true, guidedMotionVersion: 1, connectionId: "test-link" } : {}),
    connected: robot, devices: [robot], available: true, walkMode: false, locomotionMode: null,
    moving: false, status: null, battery: null, listening: false, ...initial,
  };
  const actions = [];
  let storedTeachActions = [...(snapshot.teachActions ?? [])];
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
    if (name === "bumi_chat_handoff" && classroom?.handoff) return classroom.handoff(args.request);
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
    if (classroom) {
      if (request.operation === "interpretWalk") return { ...snapshot, walkIntent: await classroom.interpret(request.text) };
      if (request.operation === "locateVision") {
        if (request.inspection?.pulseDirections) {
          classroomRequests.push(JSON.parse(JSON.stringify(request)));
          return { ...snapshot, visionPose: await classroom.pulseDirections(request) };
        }
        if (request.inspection?.directionsOnly) {
          classroomRequests.push(JSON.parse(JSON.stringify(request)));
          const visionPose = { directions: await classroom.directions(request), timingMs: classroom.timingMs };
          if (classroom.directionSteps !== undefined) visionPose.directionSteps = classroom.directionSteps;
          return { ...snapshot, visionPose };
        }
        if (request.walkContinue) {
          classroomRequests.push(JSON.parse(JSON.stringify(request)));
          return { ...snapshot, visionPose: { walkContinue: await classroom.walkContinue(request), timingMs: classroom.timingMs } };
        }
        if (request.walkPath) {
          classroomRequests.push(JSON.parse(JSON.stringify(request)));
          return { ...snapshot, visionPose: { walkPath: await classroom.walkPath(request) } };
        }
        if (request.inspection) {
          classroomRequests.push(JSON.parse(JSON.stringify(request)));
          return { ...snapshot, visionPose: { inspection: await classroom.inspect(request), timingMs: classroom.timingMs } };
        }
        if (!request.sceneTarget) return { ...snapshot, visionPose: { detected: false, confidence: 0 } };
        classroomRequests.push(JSON.parse(JSON.stringify(request)));
        return { ...snapshot, visionPose: { scene: await classroom.observe(request), timingMs: classroom.timingMs } };
      }
      if (["beginClassroom", "classroomStep", "classroomStop", "endClassroom"].includes(request.operation)) {
        classroomRequests.push(JSON.parse(JSON.stringify(request)));
        if (request.operation === "classroomStep") {
          await classroom.step?.(request);
          if (["wave", "handshake"].includes(request.action)) {
            snapshot.walkMode = false;
            snapshot.locomotionMode = null;
          }
        }
        return { ...snapshot, moving: false };
      }
    }
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
      Object.assign(snapshot, { connected: null, walkMode: false, locomotionMode: null, teachRecording: false, teachActions: [], moving: false, status: null });
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
        if (request.voiceId !== undefined) {
          assert.equal(snapshot.remoteVoiceContinue, true, "spoken gait selection requires host support");
          snapshot.status = await readVoiceModeStatus(cmd.action);
          if (snapshot.status !== (cmd.action === "walk" ? 2 : 3)) {
            snapshot.walkMode = false;
            snapshot.locomotionMode = null;
            throw new Error("机器人未确认所选步态。");
          }
        }
      }
      if (["dance", "wave", "handshake", "cheer", "standUp", "standToFall", "startTeach", "stopTeach", "saveTeach", "playTeach"].includes(cmd.action)) {
        snapshot.walkMode = false;
        snapshot.locomotionMode = null;
      }
      if (cmd.action === "startTeach") snapshot.teachRecording = true;
      if (cmd.action === "stopTeach") snapshot.teachRecording = false;
      if (cmd.action === "saveTeach") {
        snapshot.teachRecording = false;
        const nextId = storedTeachActions.reduce((max, item) => Math.max(max, item.id), 0) + 1;
        storedTeachActions.push({ id: nextId, name: cmd.name, duration: null, time: "2026-11-25 14:30" });
      }
      if (cmd.action === "teachList") {
        snapshot.teachActions = readTeachList([...storedTeachActions]);
      }
      if (cmd.action === "deleteTeach") {
        storedTeachActions = storedTeachActions.filter(item => item.id !== cmd.id);
        snapshot.teachActions = (snapshot.teachActions || []).filter(item => item.id !== cmd.id);
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
  const context = vm.createContext({ exports: {}, document, window, navigator: media, Date, TextEncoder, Image: window.Image, setTimeout, clearTimeout,
    require(name) {
      if (name === "@tauri-apps/api/event") return { listen };
      if (classroomModules[name]) { const m = {}; classroomModules[name].runInContext(context)(m); return m; }
      if (name === "./bumi-embodied") { const m = {}; embodiedScript.runInContext(context)(m); return m; }
      if (name === "./bumi-vision") {
        const module = {};
        visionScript.runInContext(context)(module);
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
    captures, captureStops, commandRequests, guidanceRequests, movementRequests, connectionRequests, classroomRequests, robotSnapshot: snapshot,
    previewLabels, previewLabelHistory, capturedLabels, snapshotPaint, encodedFrameSizes, videoFramesRequested: () => videoFramesRequested,
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

function selectStickMode(ui, mode) {
  const option = ui.document.getElementById(`stick-${mode}`);
  option.checked = true;
  option.fire("change");
}

test("lateral stick travel uses vy proportionally, preserves vx, and sends zero on release", async t => {
  const ui = await renderer(t, { remote: true });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  assert.equal(horizontal.disabled, false);
  selectStickMode(ui, "lateral");
  assert.deepEqual(ui.moves, []);
  for (const [dx, dy, expected] of [
    [-30, -40, [51, 0, 38]], [30, 40, [-51, 0, -38]],
    [-100, 0, [0, 0, 127]], [120, -160, [102, 0, -76]],
  ]) {
    const start = ui.moves.length;
    ui.stick("pointerdown");
    assert.equal(horizontal.disabled, true);
    selectStickMode(ui, "yaw");
    assert.equal(ui.document.getElementById("stick-lateral").checked, true);
    assert.equal(ui.document.getElementById("stick-yaw").checked, false);
    ui.stick("pointermove", dx, dy);
    await settle();
    ui.stick("pointerup");
    await settle();
    assert.deepEqual(ui.moves.slice(start), [expected, stopped]);
    assert.equal(horizontal.disabled, false);
  }
  selectStickMode(ui, "yaw");
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
  const stick = ui.document.getElementById("motion-stick");
  selectStickMode(ui, "lateral");
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
  assertDirectionLabels(ui, yawLabels);
  for (const [mode, labels, left, right] of [
    ["lateral", lateralLabels, [0, 0, 80], [0, 0, -80]],
    ["yaw", yawLabels, [0, 80, 0], [0, -80, 0]],
  ]) {
    const beforeChange = ui.moves.length;
    selectStickMode(ui, mode);
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

function pushMenuSample(capture, strafe, ...keys) {
  capture.events.onmessage({ keys, strafe, sampledAt: Date.now() });
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

function assertRemotePaused(ui, reason) {
  const control = id => ui.document.getElementById("remote-shield" + id);
  assert.equal(control("").open, true);
  assert.equal(control("-title").textContent, "遥控已暂停");
  assert.match(control("-status").textContent, reason);
  assert.equal(control("-close").textContent, "返回控制面板");
}

const stopped = [0, 0, 0];
const nonzero = axes => axes.some(value => value !== 0);

function classroomScene(robotX) {
  return { status: "ready", confidence: 0.96, robot: { x: robotX, y: 0.5 },
    headingPoint: { x: robotX + 0.05, y: 0.5 }, target: { x: 0.6, y: 0.5 }, approach: { x: 0.2, y: 0.5 },
    pathClear: true, turnClear: true, rearClear: true };
}
async function classroomRenderer(t, remote, classroom, capabilities = {}, pulseProfile) {
  const ui = await renderer(t, { remote, robotStatus: 2,
    initial: { sceneVisionVersion: 1, connectionId: "test-link", visionVersion: 2, ...capabilities }, classroom });
  for (const [id, value] of Object.entries({ width: 2, height: 2, greeting: 0.8, step: 0.2, turn: 20 })) {
    ui.document.getElementById("class-" + id).value = String(value);
  }
  await click(ui, "vision-toggle");
  if (pulseProfile) {
    const select = ui.document.getElementById("class-pulse-profile");
    assert.ok(select && !select.disabled && !select.hidden);
    select.value = pulseProfile;
    select.fire("change");
  }
  let capture;
  if (remote) {
    capture = await beginRemote(ui);
    pushKeys(capture);
  } else await ui.chooseMode("walk");
  const say = async phrase => {
    if (capture) pushVoice(capture, phrase);
    else {
      ui.document.getElementById("voice-command").value = phrase;
      ui.document.getElementById("voice-run").click();
    }
    await settle();
  };
  const tick = async ms => {
    // A real held remote keeps supplying neutral samples while speech is idle.
    for (let remaining = ms; remaining > 0; remaining -= 200) {
      if (capture) pushKeys(capture);
      await ui.tick(Math.min(remaining, 200));
    }
  };
  return { ...ui, say, capture, tick,
    scenes: () => ui.classroomRequests.filter(r => r.operation === "locateVision"),
    steps: () => ui.classroomRequests.filter(r => r.operation === "classroomStep"),
  };
}

function selectRoute(ui) {
  const field = ui.document.getElementById("class-route-plan");
  assert.ok(!field.checked && !field.disabled);
  assert.equal(ui.document.getElementById("class-route-plan-setting").hidden, false);
  field.checked = true;
  field.fire("change");
}

async function routeRenderer(t, classroom = {}, remote = false) {
  const ui = await classroomRenderer(t, remote, classroom, { singleFrameDirectionsVersion: 1 });
  selectRoute(ui);
  return ui;
}

const executableRouteCapabilities = {
  singleFrameDirectionsVersion: 1, singleFramePulseDirectionsVersion: 1,
};

function pulsePlan(...segments) {
  return {
    directions: [...segments.map(part => part.direction), "stop"],
    directionSteps: [...segments.map(part => part.count), null],
    pulseDirections: segments,
  };
}

function straightRoute() {
  return pulsePlan({ direction: "forward", count: 2 });
}

async function executableRouteRenderer(t, pulseDirections, capabilities = executableRouteCapabilities) {
  const ui = await classroomRenderer(t, false, {
    uncalibrated: true, pulseDirections, directions: () => ["forward", "stop"],
  }, capabilities);
  const button = ui.document.getElementById("class-route-walk");
  const enabledByDefault = capabilities.singleFramePulseDirectionsVersion === 1;
  assert.equal(ui.document.getElementById("class-route-plan").checked, enabledByDefault);
  assert.equal(button.hidden, !enabledByDefault);
  const input = ui.document.getElementById("voice-command");
  input.value = "走到白色垃圾桶旁边";
  input.fire("input");
  for (const id of ["width", "height", "step", "left", "turn"]) ui.document.getElementById("class-" + id).value = "";
  return ui;
}

test("single-photo execution takes one photo and issues every planned pulse once, without replanning", async t => {
  const ui = await executableRouteRenderer(t, straightRoute);
  assert.equal(ui.document.getElementById("voice-run").textContent, "预览走法");
  assert.deepEqual(ui.classroomRequests, []);
  const baseline = ui.videoFramesRequested();
  await click(ui, "class-route-walk");
  ui.document.getElementById("class-route-walk").click();
  await ui.tick(3000);
  assert.equal(ui.videoFramesRequested() - baseline, 1);
  assert.equal(ui.scenes().length, 1);
  const [request] = ui.scenes();
  assert.deepEqual(request.inspection, { target: "白色垃圾桶", calibratedFloor: false, directionsOnly: true, pulseDirections: true });
  assert.equal(request.singleFrameRoute, undefined);
  assert.deepEqual(ui.steps().map(step => [step.action, step.sequence]), [["forward", 1], ["forward", 2]]);
  const begins = ui.classroomRequests.filter(r => r.operation === "beginClassroom");
  assert.equal(begins.length, 1);
  assert.equal(begins[0].connectionId, "test-link");
  assert.ok(ui.steps().every(s => s.taskId === begins[0].taskId));
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

test("preview remains read-only when executable routes are supported", async t => {
  const ui = await executableRouteRenderer(t, straightRoute);
  await click(ui, "voice-run");
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
  assert.equal(ui.scenes()[0].inspection.directionsOnly, true);
});

test("a fresh local preview dispatches its displayed pulses with no second photo or plan", async t => {
  const ui = await executableRouteRenderer(t, straightRoute);
  const command = ui.document.getElementById("voice-command");
  const original = command.value;
  const baseline = ui.videoFramesRequested();
  await click(ui, "voice-run");
  assert.equal(command.value, original);
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
  const [preview] = ui.scenes();
  assert.equal(preview.inspection.pulseDirections, true);
  assert.match(ui.document.getElementById("voice-status").textContent, /直走.*2.*停下/);
  assert.equal(ui.videoFramesRequested() - baseline, 1);
  await click(ui, "class-route-walk");
  await ui.tick(3000);
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.videoFramesRequested() - baseline, 1);
  assert.deepEqual(ui.steps().map(s => s.action), ["forward", "forward"]);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

for (const change of ["timeout", "new target", "new connection", "manual movement", "camera restart", "stop"]) {
  test(`single-photo walking obtains a new plan after ${change} invalidates the preview`, async t => {
    let plans = 0;
    const ui = await executableRouteRenderer(t, () => ++plans === 1
      ? pulsePlan({ direction: "left", count: 1 })
      : pulsePlan({ direction: "right", count: 1 }));
    await click(ui, "voice-run");
    assert.deepEqual(ui.steps(), []);
    if (change === "timeout") await ui.tick(16_000);
    if (change === "new target") {
      const input = ui.document.getElementById("voice-command");
      input.value = "走到讲台旁边";
      input.fire("input");
    }
    if (change === "new connection") {
      ui.robotSnapshot.connectionId = "another-connection";
      await ui.chooseMode("walk");
    }
    if (change === "manual movement") {
      ui.press();
      await settle();
      ui.release();
      await settle();
      assert.ok(ui.moves.some(axes => nonzero(axes)));
    }
    if (change === "camera restart") {
      await click(ui, "vision-toggle");
      await click(ui, "vision-toggle");
    }
    if (change === "stop") await click(ui, "stop-move");
    await click(ui, "class-route-walk");
    await ui.tick(1500);
    assert.equal(ui.scenes().length, 2);
    assert.deepEqual(ui.steps().map(s => s.action), ["right"]);
  });
}

test("single-photo execution consumes the preview once", async t => {
  let plans = 0;
  const ui = await executableRouteRenderer(t, () => ++plans === 1
    ? pulsePlan({ direction: "left", count: 1 })
    : pulsePlan({ direction: "right", count: 1 }));
  await click(ui, "voice-run");
  await click(ui, "class-route-walk");
  await ui.tick(1000);
  await click(ui, "class-route-walk");
  await ui.tick(1000);
  assert.equal(ui.scenes().length, 2);
  assert.deepEqual(ui.steps().map(s => s.action), ["left", "right"]);
});

test("single-photo signals preserve turn and step counts without measured angles or scale", async t => {
  const ui = await executableRouteRenderer(t, () =>
    pulsePlan({ direction: "right", count: 2 }, { direction: "forward", count: 2 }));
  await click(ui, "class-route-walk");
  await ui.tick(4000);
  assert.deepEqual(ui.steps().map(s => s.action), ["right", "right", "forward", "forward"]);
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.scenes()[0].inspection.calibratedFloor, false);
});

for (const floor of ["saved", "partially calibrated"]) {
  test(`a pulse-only host previews and walks from one raw photo on a ${floor} floor`, async t => {
    const ui = await classroomRenderer(t, false, { pulseDirections: straightRoute }, {
      singleFramePulseDirectionsVersion: 1, sceneVisionVersion: undefined,
    });
    if (floor === "partially calibrated") {
      await click(ui, "vision-calibrate");
      const overlay = ui.document.getElementById("vision-overlay");
      overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 240 });
      overlay.fire("click", { clientX: 14, clientY: 18 });
      assert.match(ui.document.getElementById("vision-corner-hint").textContent, /2\/4/);
    }
    ui.document.getElementById("voice-command").value = "走到白色垃圾桶旁边";
    await click(ui, "voice-run");
    assert.deepEqual(ui.steps(), []);
    await click(ui, "class-route-walk");
    await ui.tick(1600);
    assert.deepEqual(ui.encodedFrameSizes, [[640, 480]], "original camera dimensions, without the overhead floor projection");
    assert.equal(ui.scenes().length, 1);
    assert.equal(ui.scenes()[0].inspection.calibratedFloor, false);
    assert.deepEqual(ui.steps().map(r => r.action), ["forward", "forward"]);
  });
}

test("single-photo walking from an onboard camera uses robot-relative directions", async t => {
  const ui = await renderer(t, {
    robotStatus: 2,
    initial: { ...executableRouteCapabilities, sceneVisionVersion: 1, searchViewVersion: 1, connectionId: "test-link" },
    classroom: { uncalibrated: true, pulseDirections: () => pulsePlan({ direction: "left", count: 1 }, { direction: "forward", count: 1 }) },
  });
  const onFrame = await openForwardBoxCamera(ui);
  ui.document.getElementById("voice-command").value = "走到白色垃圾桶旁边";
  await click(ui, "class-route-walk");
  onFrame("frame-1");
  await settle();
  await ui.tick(750);
  await ui.tick(750);
  const queries = ui.classroomRequests.filter(r => r.operation === "locateVision");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].searchView, "dominant");
  assert.equal(queries[0].inspection.calibratedFloor, false);
  assert.deepEqual(ui.classroomRequests.filter(r => r.operation === "classroomStep").map(r => r.action), ["left", "forward"]);
});

for (const version of [undefined, 2]) {
  test(`single-photo execution requires the pulse contract with old or unknown version ${version}`, async t => {
    const ui = await executableRouteRenderer(t, straightRoute, {
      singleFrameDirectionsVersion: 1, singleFrameEstimatedStepVersion: 1,
      singleFrameRouteVersion: 1, singleFramePulseDirectionsVersion: version,
    });
    const button = ui.document.getElementById("class-route-walk");
    assert.ok(button.disabled || button.hidden);
    button.fire("click");
    await settle();
    assert.deepEqual(ui.classroomRequests, []);
    selectRoute(ui);
    await click(ui, "voice-run");
    assert.equal(ui.scenes()[0].inspection.directionsOnly, true);
    assert.equal(ui.scenes()[0].inspection.pulseDirections, undefined);
    assert.deepEqual(ui.steps(), []);
  });
}

for (const invalid of [
  { direction: "faceTarget", count: 1 }, { direction: "forward" },
  { direction: "right", count: 0.5 }, { direction: "forward", count: 10 },
]) {
  test(`a malformed or over-budget single-photo suffix cancels the full route (${JSON.stringify(invalid)})`, async t => {
    const ui = await executableRouteRenderer(t, () => pulsePlan({ direction: "forward", count: 1 }, invalid));
    await click(ui, "class-route-walk");
    await ui.tick(3000);
    assert.equal(ui.scenes().length, 1);
    assert.deepEqual(ui.steps(), []);
  });
}

for (const response of [
  { directions: ["faceTarget", "forward", "stop"], directionSteps: [null, 2, null] },
  { directions: [], directionSteps: [], pulseDirections: [] },
  { directions: ["stop"], directionSteps: [null], pulseDirections: [] },
  { ...straightRoute(), directions: ["left", "stop"] },
]) {
  test(`display-only, unknown and stop-only single-photo results create no motor pulses (${response.directions})`, async t => {
    const ui = await executableRouteRenderer(t, () => response);
    await click(ui, "class-route-walk");
    await ui.tick(2000);
    assert.equal(ui.scenes().length, 1);
    assert.deepEqual(ui.steps(), []);
  });
}

test("stopping single-photo execution between pulses discards the remaining plan", async t => {
  const ui = await executableRouteRenderer(t, straightRoute);
  await click(ui, "class-route-walk");
  assert.deepEqual(ui.steps().map(s => s.action), ["forward"]);
  await click(ui, "classroom-stop");
  await ui.tick(3000);
  assert.deepEqual(ui.steps().map(s => s.action), ["forward"]);
  assert.equal(ui.scenes().length, 1);
  assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

test("a late single-photo execution reply cannot restart a stopped task", async t => {
  let resolvePlan;
  const ui = await executableRouteRenderer(t, () => new Promise(resolve => { resolvePlan = resolve; }));
  await click(ui, "class-route-walk");
  assert.equal(ui.scenes().length, 1);
  await click(ui, "classroom-stop");
  resolvePlan(straightRoute());
  await settle();
  await ui.tick(3000);
  assert.deepEqual(ui.steps(), []);
});

test("single-photo execution abandons remaining pulses after a prolonged delay", async t => {
  const ui = await executableRouteRenderer(t, straightRoute);
  await click(ui, "class-route-walk");
  assert.equal(ui.steps().length, 1);
  t.mock.timers.setTime(Date.now() + 60_000);
  await ui.tick(1000);
  assert.equal(ui.steps().length, 1);
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

test("single-photo execution never starts from an expired initial photograph", async t => {
  let finishPlan;
  const ui = await executableRouteRenderer(t, () => new Promise(resolve => { finishPlan = resolve; }));
  await click(ui, "class-route-walk");
  await ui.tick(15_001);
  finishPlan(straightRoute());
  await settle();
  assert.deepEqual(ui.steps(), []);
  assert.equal(ui.scenes().length, 1);
});

test("a timely single-photo plan can finish all ten pulses without requesting a new picture", async t => {
  const started = [];
  let finishPlan;
  const ui = await classroomRenderer(t, false, {
    uncalibrated: true, pulseDirections: () => new Promise(resolve => { finishPlan = resolve; }),
    step: () => {
      started.push(Date.now());
      return new Promise(resolve => setTimeout(resolve, 800)); // Standard native timed pulse.
    },
  }, { ...executableRouteCapabilities, classroomPulseVersion: 1 }, "standard");
  ui.document.getElementById("voice-command").value = "走到白色垃圾桶旁边";
  const captureTime = Date.now();
  const baseline = ui.videoFramesRequested();
  await click(ui, "class-route-walk");
  await ui.tick(12_000);
  finishPlan(pulsePlan({ direction: "forward", count: 10 }));
  await settle();
  assert.equal(started.length, 1);
  await ui.tick(17_000);
  assert.equal(started.length, 10);
  assert.ok(started.at(-1) - captureTime > 15_000);
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.videoFramesRequested() - baseline, 1);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

test("single-frame directions work from an uncalibrated camera with no robot or gait selected", async t => {
  const ui = await renderer(t, {
    initial: { connected: null, visionVersion: 2, singleFrameDirectionsVersion: 1 },
    classroom: { uncalibrated: true, directions: () => ["left", "forward", "stop"], timingMs: { headers: 330, body: 1980 } },
  });
  await click(ui, "vision-toggle");
  selectRoute(ui);
  ui.document.getElementById("voice-command").value = "走到白色垃圾桶旁边";
  await click(ui, "voice-run");
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
  const [request] = ui.classroomRequests;
  assert.deepEqual(request.inspection, { target: "白色垃圾桶", calibratedFloor: false, directionsOnly: true });
  assert.match(request.imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(ui.document.getElementById("voice-status").textContent, "左转 → 直走 → 停下");
  assert.deepEqual(ui.actions, []);
  assert.deepEqual(ui.guidanceRequests, []);
});

test("remote speech returns single-frame directions without moving a connected robot", async t => {
  const ui = await routeRenderer(t, { directions: () => ["stop"] }, true);
  await ui.say("走到垃圾桶旁边");
  assert.equal(ui.scenes().length, 1);
  assert.deepEqual(ui.scenes()[0].inspection, { target: "垃圾桶", calibratedFloor: true, directionsOnly: true });
  assert.equal(ui.document.getElementById("voice-status").textContent, "停下");
  assert.deepEqual(ui.steps(), []);
  assert.ok(ui.moves.every(axes => !nonzero(axes)));
  assert.deepEqual(ui.guidanceRequests, []);
});

test("single-frame directions use the photographed route's estimated steps independently of manual calibration", async t => {
  const ui = await classroomRenderer(t, false, {
    directions: () => ["left", "forward", "right", "forward", "stop"],
    directionSteps: [6, 3, null, null, null],
  }, { singleFrameDirectionsVersion: 1 });
  const calibration = ui.document.getElementById("class-manual-calibration");
  assert.equal(calibration.tagName, "DETAILS");
  for (const [id, value] of [["class-step", "0.73"], ["class-turn", "58"]]) {
    const input = ui.document.getElementById(id);
    assert.ok(calibration.contains(input), id);
    input.value = value;
  }
  selectRoute(ui);
  assert.equal(calibration.hidden, true);
  await ui.say("走到垃圾桶旁边");
  assert.deepEqual(ui.scenes().map(({ imageDataUrl, ...query }) => query), [{
    operation: "locateVision", inspection: { target: "垃圾桶", calibratedFloor: true, directionsOnly: true },
  }]);
  assert.equal(ui.document.getElementById("voice-status").textContent, "左转 → 直走约 3 步 → 右转 → 直走 → 停下");
  assert.deepEqual(ui.steps(), []);
});

for (const [description, directionSteps] of [["invalid", [-4, 1.5, "2", null]], ["misaligned", [3]]]) {
  test(`${description} forward-step estimates leave the directions readable`, async t => {
    const ui = await routeRenderer(t, {
      directions: () => ["forward", "forward", "forward", "stop"], directionSteps,
    });
    await ui.say("走到垃圾桶旁边");
    assert.equal(ui.document.getElementById("voice-status").textContent, "直走 → 直走 → 直走 → 停下");
    assert.deepEqual(ui.steps(), []);
  });
}

test("single-frame directions use the onboard camera's forward perspective", async t => {
  const ui = await renderer(t, {
    initial: { singleFrameDirectionsVersion: 1, searchViewVersion: 1 },
    classroom: { uncalibrated: true, directions: () => ["right", "forward", "stop"] },
  });
  const onFrame = await openForwardBoxCamera(ui);
  selectRoute(ui);
  ui.document.getElementById("voice-command").value = "走到垃圾桶旁边";
  ui.document.getElementById("voice-run").click();
  await settle();
  onFrame("frame-1");
  await settle();
  const [request] = ui.classroomRequests;
  assert.equal(request.searchView, "dominant");
  assert.equal(request.inspection.calibratedFloor, false);
  assert.equal(ui.document.getElementById("voice-status").textContent, "右转 → 直走 → 停下");
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
});

test("unrecognized direction values cannot appear as extra model text after a valid turn", async t => {
  const ui = await routeRenderer(t, { directions: () => ["left", "请检查桌沿和地面尺度"] });
  await ui.say("走到垃圾桶旁边");
  const note = ui.document.getElementById("voice-status").textContent;
  assert.match(note, /路线/);
  assert.doesNotMatch(note, /左转|桌沿/);
  assert.deepEqual(ui.steps(), []);
});

test("a manual trial after an empty single-frame plan sends one pulse even with automatic continuation enabled", async t => {
  const ui = await classroomRenderer(t, false, { directions: () => [] },
    { singleFrameDirectionsVersion: 1, walkContinueVersion: 1, classroomPulseVersion: 1 });
  selectRoute(ui);
  await ui.say("走到垃圾桶旁边");
  assert.equal(ui.document.getElementById("voice-status").textContent, "未识别到路线");
  assert.deepEqual(ui.steps(), []);
  assert.equal(ui.document.getElementById("class-walk-continue").checked, true);
  const button = ui.document.getElementById("class-trial-step");
  assert.ok(!button.disabled && !button.hidden);
  button.click();
  button.click();
  await settle();
  await ui.tick(2000);
  assert.deepEqual(ui.steps().map(s => s.action), ["forward"]);
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
});

test("a local trial needs walk mode and can run with the camera off and no chat grant", async t => {
  const ui = await renderer(t, {
    initial: { sceneVisionVersion: 1, connectionId: "test-link" },
    classroom: {},
  });
  const trial = ui.document.getElementById("class-trial-step");
  assert.ok(trial.disabled);
  trial.click();
  await ui.chooseMode("walk");
  await click(ui, "class-trial-step");
  await ui.tick(700);
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);
});

for (const interrupt of ["stop", "camera change"]) {
  test(`a late single-frame directions reply is discarded after ${interrupt}`, async t => {
    let finish;
    const ui = await routeRenderer(t, { directions: () => new Promise(resolve => { finish = resolve; }) });
    await ui.say("走到垃圾桶旁边");
    assert.equal(ui.scenes().length, 1);
    if (interrupt === "stop") await ui.say("停下来");
    else await click(ui, "vision-toggle");
    finish(["left", "forward", "stop"]);
    await settle();
    assert.doesNotMatch(ui.document.getElementById("voice-status").textContent, /左转/);
    assert.deepEqual(ui.steps(), []);
  });
}

for (const capabilities of [{}, { singleFrameRouteVersion: 1 }, { singleFrameDirectionsVersion: 2 }, { singleFrameDirectionsVersion: 1 }]) {
  test(`approach without opting into directions keeps using scene observations with ${JSON.stringify(capabilities)}`, async t => {
    const ui = await classroomRenderer(t, false, { observe: () => classroomScene(0.2) }, capabilities);
    assert.equal(ui.document.getElementById("class-route-plan-setting").hidden, capabilities.singleFrameDirectionsVersion !== 1);
    await ui.say("走到垃圾桶旁边");
    assert.deepEqual(ui.scenes().map(r => r.sceneTarget), ["垃圾桶"]);
    assert.equal(ui.scenes()[0].inspection, undefined);
    assert.deepEqual(ui.steps(), []);
  });
}

test("selecting a single-frame route keeps following and greetings on fresh observations", async t => {
  const ui = await routeRenderer(t, { observe: () => classroomScene(0.2) });
  await ui.say("跟着穿粉色上衣的人");
  assert.deepEqual(ui.scenes().map(r => r.sceneTarget), ["穿粉色上衣的人"]);
  await click(ui, "classroom-stop");
  await ui.say("走到穿粉色上衣的人旁边打招呼");
  await ui.tick(300);
  assert.ok(ui.scenes().slice(1).every(r => r.sceneTarget === "穿粉色上衣的人" && !r.inspection));
  assert.deepEqual(ui.steps().map(r => r.action), ["wave", "greet"]);
});

for (const auto of [false, true]) {
  test(`a classroom walk uses the selected joint confidence for ${auto ? "automatic" : "calibrated"} navigation`, async t => {
    const ui = await classroomRenderer(t, false, {
      uncalibrated: auto,
      observe: () => ({
        ...classroomScene(0.1), confidence: 0.63,
        ...(auto ? { distanceM: 1, approachDistanceM: 0.2, turnDeg: 0, atGreeting: false } : {}),
      }),
    }, { sceneConfidenceVersion: 1 });
    assert.equal(ui.document.getElementById("class-confidence-setting").hidden, false);
    const field = ui.document.getElementById("class-confidence-threshold");
    field.value = "0.63";
    field.fire("change");
    await ui.say("走到讲台");
    assert.equal(ui.scenes()[0].sceneScale.minConfidence, 0.63);
    assert.ok(ui.snapshotPaint.labels.includes("目标：讲台"));
    assert.deepEqual(ui.steps().map(s => s.action), ["forward"]);
    assert.equal(ui.scenes().length, 1);
    await ui.tick(700);
    assert.equal(ui.scenes()[1].sceneScale.minConfidence, 0.63);
  });
}

test("a saved custom threshold on an older host can be restored to enable legacy navigation", async t => {
  const storage = new Map([["keepwork.bumi.vision-calibration.v1", JSON.stringify({ minSceneConfidence: 0.63 })]]);
  const ui = await classroomRenderer(t, false, { storage, uncalibrated: true, observe: () => ({
    ...classroomScene(0.2), distanceM: 0.8, approachDistanceM: 0, turnDeg: 0, atGreeting: true,
  }) });
  assert.equal(ui.document.getElementById("class-confidence-setting").hidden, false);
  const field = ui.document.getElementById("class-confidence-threshold");
  assert.equal(Number(field.value), 0.63);
  await ui.say("走到讲台");
  assert.deepEqual(ui.scenes(), []);
  assert.deepEqual(ui.steps(), []);
  field.value = "0.75";
  field.fire("change");
  await ui.say("走到讲台");
  assert.equal(ui.scenes().length, 1);
  assert.ok(ui.scenes().every(request => !Object.hasOwn(request.sceneScale, "minConfidence")));
  assert.match(ui.document.getElementById("voice-status").textContent, /已停在讲台旁/);
});

for (const scenario of ["a raised threshold", "a blocked path", "the default threshold on a legacy host"]) {
  test(`a classroom walk stops before taking a step with ${scenario}`, async t => {
    const legacy = scenario === "the default threshold on a legacy host";
    const blocked = scenario === "a blocked path";
    const ui = await classroomRenderer(t, false, {
      observe: () => ({ ...classroomScene(0.1), confidence: legacy || blocked ? 0.63 : 0.88, pathClear: !blocked }),
    }, legacy ? {} : { sceneConfidenceVersion: 1 });
    assert.equal(ui.document.getElementById("class-confidence-setting").hidden, legacy);
    const threshold = blocked ? 0.60 : 0.90;
    if (!legacy) {
      const field = ui.document.getElementById("class-confidence-threshold");
      field.value = String(threshold);
      field.fire("change");
    }
    await ui.say("走到讲台");
    const { sceneScale } = ui.scenes()[0];
    if (legacy) assert.equal(Object.hasOwn(sceneScale, "minConfidence"), false);
    else assert.equal(sceneScale.minConfidence, threshold);
    await ui.tick(300);
    assert.deepEqual(ui.steps(), []);
    assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
    assert.deepEqual(ui.snapshotPaint.labels, []);
  });
}

// Model the native ticket/receipt transport; the camera, task controller and
// renderer are the production modules, with video and BLE provided by fixtures.
async function authorizedChat(t, vision, capabilities, pulseProfile, walkPath, interpret) {
  const tickets = new Map();
  const receipts = new Map();
  const local = [];
  const ui = await classroomRenderer(t, false, { ...(typeof vision === "function" ? { observe: vision } : vision), walkPath, interpret, handoff(req) {
    local.push(req.operation);
    if (req.operation === "claim") return tickets.get(req.ticket);
    if (req.operation === "reply") receipts.get(req.ticket)(req.result);
  } }, capabilities, pulseProfile);
  const grant = ui.document.getElementById("chat-classroom-grant");
  grant.checked = true;
  grant.fire("change");
  await settle();
  assert.ok(local.includes("enable"));
  function chat(request, document = "main-one") {
    const ticket = String(tickets.size + 1);
    tickets.set(ticket, { request, document, connection: "test-link" });
    const result = new Promise(resolve => receipts.set(ticket, resolve));
    ui.emit("bumi:classroom-request", ticket);
    return result;
  }
  return { ...ui, chat, local };
}
test("stopping and restarting a single-frame route in chat discards the old result and never replays a task ID", async t => {
  const replies = [];
  const ui = await authorizedChat(t, { directions: () => new Promise(resolve => replies.push(resolve)) }, { singleFrameDirectionsVersion: 1 });
  selectRoute(ui);
  const first = { operation: "start", taskId: "route-old", command: "走到垃圾桶旁边" };
  const second = { ...first, taskId: "route-new" };
  const status = taskId => ui.chat({ operation: "status", taskId });
  assert.equal((await ui.chat(first)).status, "running");
  await settle();
  assert.equal((await ui.chat({ operation: "stop", taskId: first.taskId })).status, "stopped");
  assert.equal((await ui.chat(second)).status, "running");
  await settle();
  assert.equal(replies.length, 2);
  replies[0](["stop"]);
  await settle();
  assert.equal((await status(first.taskId)).status, "stopped");
  assert.equal((await status(second.taskId)).status, "running");
  assert.deepEqual(ui.steps(), []);
  replies[1](["left", "forward", "stop"]);
  await settle();
  const receipt = await status(second.taskId);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.message, "左转 → 直走 → 停下");
  assert.equal((await ui.chat(first)).status, "stopped");
  assert.equal((await ui.chat(second)).status, "completed");
  assert.equal(ui.scenes().length, 2);
  assert.deepEqual(ui.steps(), []);
});
test("main classroom camera handoff, inert ambiguity across focus change, explicit resumption and scoped receipts", async t => {
  let ambiguous = true;
  const ui = await authorizedChat(t, () => ambiguous
    ? { ...classroomScene(0.2), status: "ambiguous", reason: "靠门和靠讲台各有一人" }
    : classroomScene(0.2));
  const shot = await ui.chat({ operation: "observe" });
  assert.equal(shot.status, "completed");
  assert.match(shot.imageDataUrl, /^data:image\/jpeg;base64,/);
  const start = { operation: "start", taskId: "one", command: "走到穿粉色上衣的人旁边打招呼" };
  assert.ok(["running", "awaitingChoice"].includes((await ui.chat(start)).status));
  await settle();
  const status = { operation: "status", taskId: "one" };
  assert.equal((await ui.chat(status)).status, "awaitingChoice");
  assert.equal((await ui.chat(status, "main-two")).status, "unavailable");
  ui.window.fire("blur");
  await settle();
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.equal((await ui.chat(status)).status, "awaitingChoice");
  ambiguous = false;
  const choice = await ui.chat({ operation: "clarify", taskId: "one", command: "靠门的那位" });
  assert.equal(choice.status, "running");
  await settle();
  await ui.tick(300);
  assert.deepEqual(ui.steps().map(step => step.action), ["wave", "greet"]);
  assert.ok(ui.scenes().at(-1).sceneTarget.includes("靠门的那位"));
  assert.equal((await ui.chat(status)).status, "completed");
  assert.equal((await ui.chat(start)).status, "completed");
  assert.equal(ui.classroomRequests.filter(r => r.operation === "beginClassroom").length, 2);
});
test("scoped cancellation suppresses a delayed start, preserves the current owner, and explicit global stop writes zero", async t => {
  let release;
  const ui = await authorizedChat(t, () => new Promise(resolve => { release = resolve; }));
  await ui.chat({ operation: "start", taskId: "follow", command: "跟着穿粉色上衣的人" });
  assert.equal((await ui.chat({ operation: "stop", taskId: "overtaken" })).status, "stopped");
  assert.equal(ui.local.includes("stopConnection"), false, "unknown scoped task must not interrupt the foreground owner");
  assert.equal((await ui.chat({ operation: "status", taskId: "follow" })).status, "running");
  assert.equal((await ui.chat({operation: "stop", global: true, taskId: "also-overtaken"})).status, "stopped");
  assert.ok(ui.local.includes("stopConnection"));
  assert.equal((await ui.chat({operation: "start", taskId: "also-overtaken", command: "往前走一步"})).status, "stopped");
  assert.equal((await ui.chat({ operation: "status", taskId: "follow" })).status, "stopped");
  assert.equal((await ui.chat({ operation: "start", taskId: "overtaken", command: "往前走一步" })).status, "stopped");
  release(classroomScene(0.1));
  await ui.tick(1600);
  assert.deepEqual(ui.steps(), []);
  const writes = ui.local.filter(op => op === "stopConnection").length;
  assert.equal((await ui.chat({operation: "stop", taskId: "idle-cancel"})).status, "stopped");
  assert.equal(ui.local.filter(op => op === "stopConnection").length, writes + 1);
  ui.emit("bumi:classroom-revoked", null);
  await settle();
  const start = await ui.chat({operation: "start", taskId: "new", command: "往前走一步"}, "new-document");
  assert.equal(start.status, "failed");
  assert.equal((await ui.chat({operation: "stop"}, "new-document")).status, "stopped");
});
for (const cancel of [false, true]) {
  test(`a main-chat handshake names its own confirmed step and ${cancel ? "is cancelled by stop" : "waits for the pulse and posture confirmation"}`, async t => {
    const ui = await authorizedChat(t, () => classroomScene(0.2));
    const stepping = ui.chat({operation: "start", taskId: "step", command: "往前走一步"});
    await settle();
    assert.deepEqual(ui.steps().map(req => req.action), ["forward"]);
    const followup = {operation: "start", taskId: "greeting", afterTaskId: "step", command: "握个手"};
    assert.equal((await ui.chat(followup, "unrelated-owner")).status, "failed");
    const greeting = ui.chat(followup);
    await settle();
    assert.equal(ui.actions.includes("handshake"), false);
    if (cancel) assert.equal((await ui.chat({operation: "stop", taskId: "greeting", global: true})).status, "stopped");
    await ui.tick(700);
    await stepping;
    assert.equal(ui.actions.includes("handshake"), false);
    await ui.tick(700);
    const result = await greeting;
    assert.ok(cancel ? ["stopping", "stopped"].includes(result.status) : result.status === "completed");
    assert.equal(ui.actions.filter(a => a === "handshake").length, cancel ? 0 : 1);
    assert.equal((await ui.chat(followup)).status, cancel ? "stopped" : "completed");
    assert.equal(ui.actions.filter(a => a === "handshake").length, cancel ? 0 : 1);
  });
}
test("switching the fixed camera after a main chat screenshot requires a fresh preflight for the scene", async t => {
  const ui = await authorizedChat(t, () => classroomScene(0.2));
  await ui.chat({operation: "observe"});
  await click(ui, "vision-toggle");
  await click(ui, "vision-toggle");
  const start = {operation: "start", taskId: "new", command: "走到穿粉色上衣的人旁边"};
  assert.match((await ui.chat(start)).message, /重新拍摄/);
  assert.equal(ui.steps().length, 0);
  assert.equal((await ui.chat({operation: "observe"})).status, "completed");
  assert.equal((await ui.chat(start)).status, "running");
  await settle();
  await ui.tick(300);
  assert.equal((await ui.chat({operation: "status", taskId: "new"})).status, "completed");
});
for (const remote of [false, true]) {
  test(`classroom ${remote ? "remote greeting" : "text handshake"} uses fresh scene frames and waits for the native pulse stop`, async t => {
    let finishPulse;
    let robotX = 0.1;
    const ui = await classroomRenderer(t, remote, {
      observe: () => classroomScene(robotX),
      step: async req => {
        if (req.action === "forward") await new Promise(resolve => { finishPulse = resolve; });
        else assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop" && r.taskId === req.taskId),
          "a stop scoped to this task must precede each gesture");
      },
    });
    await ui.say("走到穿粉色上衣的人旁边" + (remote ? "打招呼" : "握个手"));
    const begin = ui.classroomRequests[0];
    assert.equal(begin?.operation, "beginClassroom", ui.document.getElementById("voice-status").textContent);
    assert.equal(begin.connectionId, "test-link");
    if (remote) {
      assert.equal(begin.captureId, ui.capture.captureId);
      assert.equal(begin.voiceId, ui.capture.lastVoiceId);
    } else assert.equal(Object.hasOwn(begin, "voiceId"), false);
    assert.equal(ui.scenes().length, 1);
    assert.deepEqual(ui.steps().map(r => r.action), ["forward"]);
    await ui.tick(800);
    assert.equal(ui.scenes().length, 1, "no camera-based continuation until the motor reply confirms stop");
    robotX = 0.2;
    finishPulse();
    await settle();
    await ui.tick(699);
    assert.equal(ui.scenes().length, 1);
    await ui.tick(1);
    assert.equal(ui.scenes().length, 2);
    assert.deepEqual(ui.steps().map(r => r.action), ["forward"], "wait for the arrival check before greeting");
    await ui.tick(300);
    const scenes = ui.scenes();
    assert.equal(scenes.length, 3);
    assert.equal(new Set(scenes.map(r => r.imageDataUrl)).size, 3);
    assert.ok(scenes.every(r => r.sceneTarget === "穿粉色上衣的人"));
    assert.deepEqual(scenes[0].sceneScale, { widthM: 2, heightM: 2, greetingM: 0.8, stepM: 0.2 });
    const expected = remote ? ["forward", "wave", "greet"] : ["forward", "handshake"];
    assert.deepEqual(ui.steps().map(r => r.action), expected);
    assert.deepEqual(ui.steps().map(r => r.sequence), expected.map((_, i) => i + 1));
    assert.ok(ui.steps().every(r => r.taskId === begin.taskId));
    assert.deepEqual(ui.classroomRequests.at(-1), { operation: "endClassroom", taskId: begin.taskId });
    assert.match(ui.document.getElementById("voice-status").textContent, /画面确认已停在穿粉色上衣的人旁/);
  });
}

test("a Xiaomi stop during pending classroom scene inference revokes the task and late frames cannot restart it", async t => {
  let answer;
  const ui = await classroomRenderer(t, true, {
    observe: () => new Promise(resolve => { answer = resolve; }),
  });
  await ui.say("跟着穿粉色上衣的人");
  assert.equal(ui.scenes().length, 1);
  await ui.say("停下来");
  const taskId = ui.classroomRequests[0].taskId;
  assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop" && r.taskId === taskId));
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  answer(classroomScene(0.1));
  await settle();
  await ui.tick(1800);
  assert.deepEqual(ui.steps(), []);
  assert.equal(ui.scenes().length, 1);
});

test("camera inspection marks the actual still and partial detections without BLE or map setup", async t => {
  const matches = [{ robot: { x: 0.2, y: 0.8 }, target: { x: 0.8, y: 0.6 } },
    { robot: { x: 0.1, y: 0.8 }, reason: "画面中有两位穿粉色上衣的人。" },
    { target: { x: 0.7, y: 0.8 } }];
  const ui = await renderer(t, {
    initial: { connected: null, visionVersion: 2, sceneInspectionVersion: 1 },
    classroom: { uncalibrated: true, inspect: () => matches.shift() },
  });
  await click(ui, "vision-toggle");
  const field = ui.document.getElementById("voice-command");
  field.value = "穿粉色上衣的人";
  field.fire("input");
  await click(ui, "vision-inspect-classroom");
  const [request] = ui.classroomRequests;
  assert.deepEqual(request.inspection, { target: field.value, calibratedFloor: false });
  assert.equal(ui.snapshotPaint.images.at(-1), request.imageDataUrl);
  assert.ok(ui.snapshotPaint.labels.includes("小布米") && ui.snapshotPaint.labels.includes("目标：穿粉色上衣的人"));
  field.value = "走到穿粉色上衣的人旁边";
  field.fire("input");
  await click(ui, "vision-inspect-classroom");
  assert.equal(ui.classroomRequests[1].inspection.target, "穿粉色上衣的人");
  assert.ok(ui.snapshotPaint.labels.includes("小布米") && !ui.snapshotPaint.labels.includes("目标：穿粉色上衣的人"));
  assert.match(ui.document.getElementById("vision-inspect-status").textContent, /只识别到小布米.*两位/);
  field.value = "看看垃圾桶";
  field.fire("input");
  await click(ui, "voice-run");
  assert.equal(ui.classroomRequests.at(-1).inspection.target, "垃圾桶");
  assert.ok(ui.snapshotPaint.labels.includes("目标：垃圾桶"));
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision", "locateVision", "locateVision"]);
  assert.deepEqual(ui.moves, []);
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.actions, []);
});

for (const interrupt of ["stop", "edited target"]) {
  test(`a disconnected classroom camera discards a late inspection after ${interrupt}`, async t => {
    let finish;
    const ui = await renderer(t, {
      initial: { connected: null, sceneInspectionVersion: 1 },
      classroom: { uncalibrated: true, inspect: () => new Promise(resolve => { finish = resolve; }) },
    });
    await click(ui, "vision-toggle");
    const field = ui.document.getElementById("voice-command");
    field.value = "看看讲台";
    field.fire("input");
    field.fire("keydown", { key: "Enter", isComposing: true });
    field.fire("keydown", { key: "Enter", repeat: true });
    await settle();
    assert.equal(ui.classroomRequests.length, 0);
    field.fire("keydown", { key: "Enter" });
    await settle();
    assert.equal(ui.classroomRequests[0].inspection.target, "讲台");
    if (interrupt === "stop") {
      await click(ui, "classroom-stop");
    } else {
      field.value = "看看椅子";
      field.fire("input");
    }
    finish({ robot: { x: 0.3, y: 0.5 }, target: { x: 0.8, y: 0.6 } });
    await settle();
    assert.equal(ui.snapshotPaint.images.length, 0);
    assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
    assert.deepEqual(ui.moves, []);
    assert.equal(ui.document.getElementById("vision-inspect-classroom").disabled, false);
  });
}

test("the same classroom panel follows the Xiaomi shield, accepts read-only speech, and gives stop priority over late inference", async t => {
  let finishScene;
  const ui = await classroomRenderer(t, true, {
    inspect: () => ({ target: { x: 0.5, y: 0.4 } }),
    observe: () => new Promise(resolve => { finishScene = resolve; }),
  }, { sceneInspectionVersion: 1 });
  const get = id => ui.document.getElementById(id);
  const panel = get("classroom-panel"), field = get("voice-command");
  assert.equal(panel.parentElement, get("classroom-shield"));
  assert.ok(panel.contains(field) && panel.contains(get("vision-video")) && panel.contains(get("classroom-stop")));
  assert.ok(get("manual-controls").contains(get("remote-toggle")));
  assert.ok(get("manual-controls").contains(get("remote-diagnose")));
  await ui.say("看看垃圾桶");
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"]);
  assert.equal(ui.classroomRequests[0].inspection.target, "垃圾桶");
  field.value = "往前走一步";
  field.fire("input");
  await click(ui, "voice-run");
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["locateVision"], "local text cannot borrow an armed remote voice ID");
  await ui.say("走到讲台");
  assert.equal(typeof finishScene, "function");
  assert.equal(ui.scenes().at(-1).sceneTarget, "讲台");
  await click(ui, "classroom-stop");
  assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
  finishScene(classroomScene(0.1));
  await ui.tick(1500);
  assert.deepEqual(ui.steps(), []);
  if (get("remote-shield").open) await click(ui, "remote-shield-close");
  assert.equal(panel.parentElement, get("classroom-home"));
  assert.equal(get("voice-command"), field);
});

test("an older vision host receives no unnegotiated inspection request", async t => {
  const ui = await renderer(t, { initial: { sceneVisionVersion: 1, visionVersion: 2 }, classroom: {} });
  await click(ui, "vision-toggle");
  const field = ui.document.getElementById("voice-command");
  field.value = "垃圾桶";
  field.fire("input");
  assert.equal(ui.document.getElementById("vision-inspect-classroom").disabled, true);
  assert.deepEqual(ui.classroomRequests, []);
});

test("the shared classroom input can ask Bumi to speak without opening the camera or starting a motion task", async t => {
  const ui = await renderer(t);
  const field = ui.document.getElementById("voice-command");
  const accepted = ["你好呀", "你好吗？", "好".repeat(40)];
  for (const [index, message] of accepted.entries()) {
    field.value = (index === 0 ? "说：" : "说") + message;
    field.fire("input");
    await click(ui, "voice-run");
  }
  field.value = "说" + "好".repeat(41);
  field.fire("input");
  await click(ui, "voice-run");
  assert.match(ui.document.getElementById("voice-status").textContent, /120.*字节/);
  assert.deepEqual(ui.commandRequests.map(r => r.command), accepted.map(text => ({ action: "speak", text })));
  assert.deepEqual(ui.classroomRequests, []);
  assert.deepEqual(ui.moves, []);
  assert.equal(ui.calls.includes("locateVision"), false);
});

test("the shared camera controls reject invalid target descriptions before capturing or calling the model", async t => {
  const ui = await renderer(t, { initial: { connected: null, sceneInspectionVersion: 1 },
    classroom: { uncalibrated: true, inspect: () => ({ target: { x: 0.7, y: 0.8 } }) } });
  await click(ui, "vision-toggle");
  const field = ui.document.getElementById("voice-command");
  const video = ui.document.getElementById("vision-video");
  const exposure = t.mock.method(video, "requestVideoFrameCallback");
  for (const target of ["物".repeat(81), "垃圾\u0001桶"]) {
    field.value = target;
    field.fire("input");
    await click(ui, "vision-inspect-classroom");
    assert.match(ui.document.getElementById("vision-inspect-status").textContent, /1 至 80/);
  }
  assert.deepEqual(ui.classroomRequests, []);
  assert.equal(exposure.mock.callCount(), 0);
  field.value = "包".repeat(79) + "🎒";
  field.fire("input");
  await click(ui, "vision-inspect-classroom");
  assert.equal(ui.classroomRequests.length, 1);
  assert.equal(exposure.mock.callCount(), 1);
  assert.equal(ui.classroomRequests[0].inspection.target, field.value);
  assert.deepEqual(ui.moves, []);
});

test("the classroom command paints the recognized robot and named target, with no markers on model frames or after stop", async t => {
  let count = 0, finish;
  const scene = classroomScene(0.2);
  const ui = await classroomRenderer(t, false, {
    observe: () => ++count === 1 ? scene : new Promise(resolve => { finish = resolve; }),
  });
  await ui.say("跟着穿蓝色衣服的人");
  assert.equal(ui.scenes().length, 1);
  await ui.tick(1200);
  assert.equal(typeof finish, "function");
  assert.ok(ui.previewLabels.includes("小布米"));
  assert.ok(ui.previewLabels.includes("目标：穿蓝色衣服的人"));
  assert.equal(ui.snapshotPaint.images.at(-1), ui.scenes()[0].imageDataUrl);
  assert.ok(ui.snapshotPaint.labels.includes("目标：穿蓝色衣服的人"));
  assert.deepEqual(ui.steps(), []);
  assert.ok(!ui.capturedLabels.includes("目标：穿蓝色衣服的人"));
  await ui.say("停下来");
  finish(scene);
  await ui.tick(1500);
  assert.ok(!ui.previewLabels.includes("目标：穿蓝色衣服的人"));
  assert.equal(ui.document.getElementById("vision-snapshot").hidden, true, "a pending result cannot restore a snapshot after stopping");
  assert.deepEqual(ui.steps(), []);
});

test("the text command for one step issues exactly one native pulse, and a handshake uses the existing gesture", async t => {
  const ui = await renderer(t, { initial: { connectionId: "test-link", sceneVisionVersion: 1 }, classroom: {} });
  await ui.chooseMode("walk");
  const input = ui.document.getElementById("voice-command");
  input.value = "往前走一步";
  await click(ui, "voice-run");
  const [begin, pulse] = ui.classroomRequests;
  assert.equal(begin?.operation, "beginClassroom");
  assert.equal(Object.hasOwn(begin, "pulseProfile"), false, "legacy hosts must never receive a profile field");
  assert.deepEqual(pulse, { operation: "classroomStep", taskId: begin.taskId, sequence: 1, action: "forward" });
  await ui.tick(700);
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);
  assert.equal(ui.classroomRequests.at(-1).taskId, begin.taskId);
  input.value = "握个手";
  await click(ui, "voice-run");
  await ui.tick(699);
  assert.deepEqual(ui.actions, ["walk", "move"]);
  assert.deepEqual(ui.moves, [[0, 0]]);
  await ui.tick(1);
  assert.deepEqual(ui.actions, ["walk", "move", "status", "handshake"]);
  assert.equal(ui.classroomRequests.length, 3);
});

for (const entry of ["text", "Xiaomi", "main chat"]) {
  test(`one step through ${entry} uses one negotiated classroom pulse with the chosen profile`, async t => {
    const capabilities = { classroomPulseVersion: 1 };
    const profile = entry === "text" ? undefined : "strong";
    const ui = entry === "main chat" ? await authorizedChat(t, () => classroomScene(0.2), capabilities, profile)
      : await classroomRenderer(t, entry === "Xiaomi", {}, capabilities, profile);
    const task = entry === "main chat" ? ui.chat({ operation: "start", taskId: "step1", command: "往前走一步" })
      : ui.say("往前走一步");
    await settle();
    const [begin, step] = ui.classroomRequests;
    assert.equal(begin?.operation, "beginClassroom");
    assert.equal(begin.pulseProfile, profile ?? "standard");
    assert.deepEqual(step, { operation: "classroomStep", action: "forward", taskId: begin.taskId, sequence: 1 });
    if (entry === "Xiaomi") {
      assert.equal(begin.captureId, ui.capture.captureId);
      assert.equal(begin.voiceId, ui.capture.lastVoiceId);
      assert.deepEqual(ui.guidanceRequests, []);
    }
    await ui.tick(700);
    await task;
    assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);
  });
}

const countedWalkCapabilities = { sceneWalkPathVersion: 1, classroomPulseVersion: 1 };
function floorObservation(x, clear = true) {
  return { robot: { x, y: 0.5 }, headingPoint: { x: x + 0.05, y: 0.5 }, clear };
}

for (const [kind, label] of [["obstacle", "疑似障碍"], ["occluded", "看不清处"], [undefined, undefined]]) {
  test(`a counted walk archives ${kind ?? "legacy"} stop evidence only on the submitted exposure`, async t => {
    const evidence = kind ? { issueKind: kind, issuePoint: { x: 0.49, y: 0.51 } } : {};
    const ui = await classroomRenderer(t, false, {
      walkPath: () => ({ ...floorObservation(0.4, false), reason: "请核对右侧桌腿", ...evidence }),
    }, countedWalkCapabilities);
    await ui.say("前进两步");
    assert.equal(ui.scenes().length, 1);
    assert.deepEqual(ui.steps(), []);
    assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
    assert.equal(ui.snapshotPaint.images.at(-1), ui.scenes()[0].imageDataUrl);
    assert.equal(ui.document.getElementById("vision-snapshot").hidden, false);
    assert.match(ui.document.getElementById("voice-status").textContent, /右侧桌腿/);
    const issueLabels = ["疑似障碍", "看不清处"];
    assert.deepEqual(ui.snapshotPaint.labels.filter(mark => issueLabels.includes(mark)), label ? [label] : []);
    assert.ok(ui.previewLabelHistory.every(mark => !issueLabels.includes(mark)));
  });
}

for (const [scenario, options, expected] of [
  ["a calibrated floor without a measured step", {}, { width: 3.7, depth: 2.1 }],
  ["a host without metric floor support", { legacy: true }, undefined],
  ["an uncalibrated fixed camera", { uncalibrated: true }, undefined],
  ["incomplete dimensions", { depth: "" }, undefined],
  ["out-of-range dimensions", { depth: "1001" }, undefined],
]) {
  test(`counted walk sends applicable floor dimensions with ${scenario}`, async t => {
    const ui = await classroomRenderer(t, false, {
      uncalibrated: options.uncalibrated, walkPath: () => floorObservation(0.4, false),
    }, { ...countedWalkCapabilities, automaticWalkClearanceVersion: 1,
      ...(!options.legacy && { walkFloorScaleVersion: 1 }) });
    ui.document.getElementById("class-width").value = "3.7";
    ui.document.getElementById("class-height").value = options.depth ?? "2.1";
    ui.document.getElementById("class-step").value = "";
    await ui.say("前进两步");
    const [request] = ui.scenes();
    assert.equal(request?.walkPath.calibratedFloor, !options.uncalibrated);
    assert.deepEqual(request.walkPath.floorSizeM, expected);
    assert.equal(Object.hasOwn(request.walkPath, "stepM"), false);
    assert.deepEqual(ui.steps(), []);
  });
}

test("a 9.74-second uncertain classroom result identifies the failed check and retains only its submitted photo", async t => {
  let answer;
  const ui = await classroomRenderer(t, false, { uncalibrated: true, timingMs: { headers: 2510, body: 7150 },
    observe: () => new Promise(resolve => { answer = resolve; }) });
  await ui.say("走到讲台");
  await ui.tick(9740);
  answer({ status: "uncertain", reason: "无法确认小布米双脚中心。", confidence: 0, pathClear: false });
  await settle();
  assert.equal(ui.scenes().length, 1);
  assert.equal(ui.snapshotPaint.images.at(-1), ui.scenes()[0].imageDataUrl);
  assert.equal(ui.document.getElementById("vision-snapshot").hidden, false);
  assert.deepEqual(ui.previewLabels, []);
  assert.deepEqual(ui.snapshotPaint.labels, []);
  assert.deepEqual(ui.steps(), []);
  assert.ok(ui.classroomRequests.some(request => request.operation === "classroomStop"));
  const note = ui.document.getElementById("voice-status").textContent;
  for (const detail of ["9.74 秒", "2.51 秒", "7.15 秒", "双脚中心", "识别原图"]) assert.ok(note.includes(detail), note);
});

for (const kind of ["target navigation", "counted walk"]) {
  test(`${kind} uses an 8.271-second observation without a confirmation exposure or recognition retry`, async t => {
    const target = kind === "target navigation";
    let answer;
    const recognize = () => new Promise(resolve => { answer = resolve; });
    const ui = await classroomRenderer(t, false, { observe: recognize, walkPath: recognize }, countedWalkCapabilities);
    const shutter = t.mock.method(ui.document.getElementById("vision-video"), "requestVideoFrameCallback");
    await ui.say(target ? "走到讲台" : "向前走两步");
    const captureTime = new Date().toISOString();
    await ui.tick(8271);
    assert.deepEqual(ui.steps(), []);
    answer(target ? classroomScene(0.1) : floorObservation(0.1));
    await settle();
    assert.equal(shutter.mock.callCount(), 1);
    assert.equal(ui.scenes().length, 1);
    assert.equal(ui.snapshotPaint.images.at(-1), ui.scenes()[0].imageDataUrl);
    assert.equal(ui.document.getElementById("vision-snapshot-time").datetime, captureTime);
    assert.deepEqual(ui.steps().map(step => step.action), ["forward"]);
    await ui.say("停下来");
  });

  for (const outcome of ["deadline", "stop", "focus loss", "camera close"]) {
    test(`${kind} discards the single recognition result on ${outcome}`, async t => {
      const target = kind === "target navigation";
      let reply;
      const recognize = () => new Promise(resolve => { reply = resolve; });
      const ui = await classroomRenderer(t, false, { observe: recognize, walkPath: recognize }, countedWalkCapabilities);
      const shutter = t.mock.method(ui.document.getElementById("vision-video"), "requestVideoFrameCallback");
      await ui.say(target ? "走到讲台" : "向前走两步");
      await ui.tick(outcome === "deadline" ? 15001 : 8271);
      if (outcome === "stop") await ui.say("停下来");
      if (outcome === "focus loss") ui.window.fire("blur");
      if (outcome === "camera close") await click(ui, "vision-toggle");
      reply(target ? classroomScene(0.1) : floorObservation(0.1));
      await ui.tick(1000);
      assert.deepEqual(ui.steps(), []);
      assert.equal(shutter.mock.callCount(), 1);
      assert.equal(ui.scenes().length, 1);
      assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
      if (outcome === "deadline") {
        assert.match(ui.document.getElementById("voice-status").textContent, /15\s*秒/);
        assert.equal(ui.snapshotPaint.images.at(-1), ui.scenes()[0].imageDataUrl);
        assert.deepEqual(ui.snapshotPaint.labels, []);
        assert.deepEqual(ui.previewLabels, []);
      } else {
        assert.deepEqual(ui.snapshotPaint.images, []);
        assert.equal(ui.document.getElementById("vision-snapshot").hidden, true);
      }
    });
  }

  test(`${kind} stops on an obstructed observation even if the recognition was slow`, async t => {
    let answer;
    const recognize = () => new Promise(resolve => { answer = resolve; });
    const ui = await classroomRenderer(t, false, { observe: recognize, walkPath: recognize }, countedWalkCapabilities);
    const targetNavigation = kind === "target navigation";
    await ui.say(targetNavigation ? "走到讲台" : "向前走两步");
    await ui.tick(5500);
    const blocked = targetNavigation ? { ...classroomScene(0.1), status: "blocked", pathClear: false } : floorObservation(0.1, false);
    answer({ ...blocked, reason: "通路被椅子挡住了" });
    await settle();
    assert.deepEqual(ui.steps(), []);
    assert.equal(ui.scenes().length, 1);
    assert.ok(ui.classroomRequests.some(request => request.operation === "classroomStop"));
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
    assert.match(ui.document.getElementById("voice-status").textContent, /通路被椅子挡住了/);
  });
}

for (const entry of ["text", "Xiaomi", "main chat"]) {
  test(`counted walking through ${entry} checks each landing, including the final one, with one native pulse at a time`, async t => {
    const direction = entry === "text" ? "forward" : "backward";
    const count = entry === "text" ? 3 : 2;
    const command = direction === "forward" ? "向前走三步" : "向后走两步";
    let frame = 0;
    const walkPath = () => {
      const x = direction === "forward" ? 0.2 + 0.1 * frame : 0.65 - 0.1 * frame;
      return floorObservation(x, frame++ < count);
    };
    const ui = entry === "main chat" ? await authorizedChat(t, undefined, countedWalkCapabilities, undefined, walkPath)
      : await classroomRenderer(t, entry === "Xiaomi", { walkPath }, countedWalkCapabilities);
    ui.document.getElementById("class-backward").value = "0.2";
    const request = {operation: "start", taskId: "finite-walk", command};
    if (entry === "main chat") {
      assert.equal((await ui.chat({operation: "observe"})).status, "completed");
      assert.ok(["accepted", "running"].includes((await ui.chat(request)).status));
    } else await ui.say(command);
    await settle();
    const begin = ui.classroomRequests.filter(r => r.operation === "beginClassroom");
    assert.equal(begin.length, 1);
    if (entry === "Xiaomi") {
      assert.equal(begin[0].voiceId, ui.capture.lastVoiceId);
      assert.equal(begin[0].captureId, ui.capture.captureId);
      pushVoice(ui.capture, command, {voiceId: ui.capture.lastVoiceId});
    } else if (entry === "main chat") assert.equal((await ui.chat(request)).status, "running");
    for (let step = 1; step <= count; step++) {
      assert.equal(ui.scenes().length, step, "only a new observation permits a pulse");
      assert.deepEqual(ui.steps().map(r => [r.taskId, r.sequence, r.action]),
        Array.from({length: step}, (_, i) => [begin[0].taskId, i + 1, direction]));
      await ui.tick(699);
      assert.equal(ui.scenes().length, step, "do not observe again before the robot settles");
      await ui.tick(1);
    }
    assert.equal(ui.steps().length, count);
    const exposures = ui.scenes();
    assert.equal(exposures.length, count + 1);
    assert.equal(new Set(exposures.map(r => r.imageDataUrl)).size, count + 1);
    assert.ok(exposures.every(r => r.walkPath.direction === direction && r.walkPath.stepM === 0.2));
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
    if (entry === "main chat") {
      assert.equal((await ui.chat({operation:"status",taskId:request.taskId})).status, "completed");
      assert.equal((await ui.chat(request)).status, "completed");
      assert.equal(ui.steps().length, count, "redelivering the same ticket cannot replay the walk");
    }
    assert.deepEqual(ui.guidanceRequests, []);
    assert.equal(ui.moves.filter(nonzero).length, 0);
  });
}

const aiWalkCapabilities = { ...countedWalkCapabilities, walkIntentVersion: 1 };

for (const entry of ["text", "Xiaomi", "main chat"]) {
  for (const count of [1, 2]) {
    test(`AI confirms ${count} step(s) through ${entry} before the first pulse`, async t => {
      const command = count === 1 ? "往前面挪动一步" : "往前挪一下，一共两步";
      let confirm, frame = 0;
      const transcripts = [];
      const interpret = text => {
        transcripts.push(text);
        return new Promise(resolve => { confirm = resolve; });
      };
      const walkPath = () => floorObservation(0.2 + 0.1 * frame++);
      const ui = entry === "main chat"
        ? await authorizedChat(t, undefined, aiWalkCapabilities, undefined, walkPath, interpret)
        : await classroomRenderer(t, entry === "Xiaomi", { walkPath, interpret }, aiWalkCapabilities);
      const start = { operation: "start", taskId: "ai-steps", command };
      if (count === 1) {
        await click(ui, "vision-toggle");
        ui.document.getElementById("class-step").value = "";
      } else if (entry === "main chat") {
        assert.equal((await ui.chat({ ...start, taskId: "no-preflight" })).status, "failed");
        assert.deepEqual(transcripts, []);
        assert.equal((await ui.chat({ operation: "observe" })).status, "completed");
      }
      if (entry === "main chat") await ui.chat(start);
      else await ui.say(command);
      await settle();
      assert.deepEqual(transcripts, [command]);
      assert.deepEqual(ui.scenes(), []);
      assert.equal(ui.classroomRequests.some(r => r.operation === "beginClassroom"), false);
      assert.deepEqual(ui.steps(), []);
      if (entry === "Xiaomi") pushVoice(ui.capture, command, { voiceId: ui.capture.lastVoiceId });
      if (entry === "main chat") await ui.chat(start);
      confirm({ direction: "forward", count });
      await settle();
      const [begin] = ui.classroomRequests;
      assert.equal(begin.operation, "beginClassroom");
      if (entry === "Xiaomi") {
        assert.equal(begin.voiceId, ui.capture.lastVoiceId);
        assert.equal(begin.captureId, ui.capture.captureId);
      }
      for (let i = 1; i <= count; i++) {
        assert.equal(ui.scenes().length, count === 1 ? 0 : i);
        assert.equal(ui.steps().length, i);
        assert.deepEqual(ui.steps()[i - 1], { operation: "classroomStep", taskId: begin.taskId, sequence: i, action: "forward" });
        await ui.tick(700);
      }
      assert.equal(ui.scenes().length, count === 1 ? 0 : count + 1);
      assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
      if (entry === "main chat") assert.equal((await ui.chat(start)).status, "completed");
      assert.deepEqual(transcripts, [command]);
      assert.equal(ui.steps().length, count);
    });
  }
}

for (const [kind, result] of [
  ["different direction", { direction: "backward", count: 2 }],
  ["different count", { direction: "forward", count: 1 }],
  ["unrecognized", null], ["missing capability", undefined],
]) {
  test(`AI step interpretation leaves the robot still on ${kind}`, async t => {
    const transcripts = [];
    const capability = kind === "missing capability" ? countedWalkCapabilities : aiWalkCapabilities;
    const ui = await classroomRenderer(t, false, { interpret(text) { transcripts.push(text); return result; } }, capability);
    const command = "朝前面挪动两步";
    await ui.say(command);
    assert.deepEqual(transcripts, kind === "missing capability" ? [] : [command]);
    assert.equal(ui.classroomRequests.some(r => r.operation === "beginClassroom"), false);
    assert.deepEqual(ui.steps(), []);
    assert.deepEqual(ui.scenes(), []);
    assert.equal(ui.moves.filter(nonzero).length, 0);
    assert.match(ui.document.getElementById("voice-status").textContent, /AI|方向和步数/);
  });
}

test("a newer remote voice ID supersedes pending AI interpretation without acting on the stale ID", async t => {
  let confirm;
  const ui = await classroomRenderer(t, true, {
    interpret: () => new Promise(resolve => { confirm = resolve; }),
  }, aiWalkCapabilities);
  await ui.say("往前面挪动两步");
  assert.equal(typeof confirm, "function");
  await ui.say("看看讲台");
  confirm({ direction: "forward", count: 2 });
  await ui.tick(700);
  assert.ok(!ui.classroomRequests.some(req => req.operation === "beginClassroom"));
  assert.deepEqual(ui.steps(), []);
});

test("stopping a pending AI analysis settles its main-chat receipt and rejects a late match without replay", async t => {
  let confirm, requests = 0;
  const ui = await authorizedChat(t, undefined, aiWalkCapabilities, undefined, undefined, () => {
    requests++;
    return new Promise(resolve => { confirm = resolve; });
  });
  const start = { operation: "start", taskId: "ai-stop", command: "往前挪一下，一共两步" };
  await ui.chat({ operation: "observe" });
  await ui.chat(start);
  await settle();
  assert.equal(typeof confirm, "function");
  await click(ui, "classroom-stop");
  assert.equal((await ui.chat({ operation: "status", taskId: start.taskId })).status, "stopped");
  confirm({ direction: "forward", count: 2 });
  await ui.tick(1400);
  assert.equal((await ui.chat(start)).status, "stopped");
  assert.equal(requests, 1);
  assert.equal(ui.classroomRequests.some(r => r.operation === "beginClassroom"), false);
  assert.deepEqual(ui.scenes(), []);
  assert.deepEqual(ui.steps(), []);
});

test("a local stop settles the main-chat counted-walk receipt without awaiting its cloud request", async t => {
  let release;
  const ui = await authorizedChat(t, undefined, countedWalkCapabilities, undefined,
    () => new Promise(done => { release = done; }));
  const command = {operation: "start", taskId: "cancel-a-walk", command: "向前走三步"};
  assert.equal((await ui.chat({...command, taskId: "missing-preflight"})).status, "failed",
    "main chat must acquire the classroom camera first");
  assert.deepEqual(ui.classroomRequests, []);
  await ui.chat({operation: "observe"});
  await ui.chat(command);
  await settle();
  assert.equal(typeof release, "function");
  await click(ui, "classroom-stop");
  assert.equal((await ui.chat({operation: "status", taskId: command.taskId})).status, "stopped");
  release(floorObservation(0.2));
  await settle();
  assert.equal((await ui.chat(command)).status, "stopped");
  assert.deepEqual(ui.steps(), []);
});

for (const interruption of ["stop", "blur", "disconnect", "camera", "manual direction"]) {
  test(`a counted walk discards late floor inference after ${interruption} and never starts its next step`, async t => {
    let reply, frames = 0;
    const remote = interruption === "manual direction";
    const ui = await classroomRenderer(t, remote, { walkPath() {
      return ++frames === 1 ? floorObservation(0.25) : new Promise(done => { reply = done; });
    } }, countedWalkCapabilities);
    await ui.say("往前走三步");
    await ui.tick(700);
    assert.equal(typeof reply, "function");
    if (interruption === "stop") await ui.say("停下来");
    if (interruption === "blur") ui.window.fire("blur");
    if (interruption === "disconnect") ui.emit("bumi:disconnected", {connectionId:"test-link",id:"test-bumi"});
    if (interruption === "camera") await click(ui, "vision-toggle");
    if (interruption === "manual direction") pushKeys(ui.capture, "right");
    await settle();
    assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
    reply(floorObservation(0.35));
    await ui.tick(1400);
    assert.deepEqual(ui.steps().map(r => r.action), ["forward"]);
    assert.equal(ui.scenes().length, 2);
  });
}

for (const hazard of ["rear blocked", "lost feet", "no displacement", "wrong direction", "stale observation"]) {
  test(`a backward counted walk stops on ${hazard}`, async t => {
    let frames = 0, delayed;
    const ui = await classroomRenderer(t, false, { walkPath() {
      if (++frames === 1) return floorObservation(0.65);
      if (hazard === "stale observation") return new Promise(done => { delayed = done; });
      if (hazard === "rear blocked") return floorObservation(0.55, false);
      if (hazard === "lost feet") return {clear: true};
      return floorObservation(hazard === "wrong direction" ? 0.75 : 0.65);
    } }, countedWalkCapabilities);
    ui.document.getElementById("class-backward").value = "0.2";
    await ui.say("向后走两步");
    await ui.tick(700);
    if (hazard === "stale observation") {
      assert.equal(frames, 2);
      await ui.tick(16000);
      delayed(floorObservation(0.55));
      await settle();
      assert.equal(frames, 2, "the expired landing observation ends the walk immediately");
    }
    assert.deepEqual(ui.steps().map(r => r.action), ["backward"]);
    assert.ok(ui.classroomRequests.some(r => r.operation === "classroomStop"));
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  });
}

for (const setup of ["missing capability", "missing rear measurement", "camera off", "blocked from the outset"]) {
  test(`a two-step command emits no movement given ${setup}`, async t => {
    const caps = setup === "missing capability" ? {classroomPulseVersion: 1} : countedWalkCapabilities;
    const ui = await classroomRenderer(t, false, {walkPath: () => floorObservation(0.65, false)}, caps);
    if (setup !== "missing rear measurement") ui.document.getElementById("class-backward").value = "0.2";
    if (setup === "camera off") await click(ui, "vision-toggle");
    await ui.say("向后走两步");
    await ui.tick(1000);
    assert.deepEqual(ui.steps(), []);
    assert.deepEqual(ui.guidanceRequests, []);
    assert.equal(ui.moves.filter(nonzero).length, 0);
    if (setup !== "blocked from the outset") assert.deepEqual(ui.scenes(), []);
    else assert.equal(ui.scenes().length, 1);
  });
}

for (const direction of ["forward", "backward"]) {
  test(`an unmeasured ${direction} counted walk checks visual clearance before each pulse`, async t => {
    const command = direction === "forward" ? "向前走两步" : "向后走两步";
    let frame = 0;
    const walkPath = () => floorObservation(0.4 + frame++ * (direction === "forward" ? 0.05 : -0.05));
    const ui = await classroomRenderer(t, false, { walkPath }, {
      ...countedWalkCapabilities, automaticWalkClearanceVersion: 1,
    });
    for (const name of ["step", "backward", "left", "turn"]) ui.document.getElementById("class-" + name).value = "";
    await ui.say(command);
    assert.deepEqual(ui.steps().map(r => r.action), [direction]);
    await ui.tick(700);
    await ui.tick(700);
    assert.deepEqual(ui.steps().map(r => r.action), [direction, direction]);
    assert.equal(ui.scenes().length, 3);
    assert.ok(ui.scenes().every(r => r.walkPath.direction === direction && !Object.hasOwn(r.walkPath, "stepM")));
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  });
}

for (const nativeOutcome of ["acknowledged", "uncertain write"]) {
  test(`a counted walk waits for the native stop acknowledgement and never retries a pulse: ${nativeOutcome}`, async t => {
    let finish, fail, frame = 0;
    const ui = await classroomRenderer(t, false, {
      walkPath: () => floorObservation(0.2 + 0.1 * frame++),
      step: request => request.sequence === 1 && new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
    }, countedWalkCapabilities);
    await ui.say("前进两步");
    assert.equal(typeof finish, "function");
    await ui.tick(1000);
    assert.deepEqual(ui.steps().map(r => r.action), ["forward"]);
    assert.equal(ui.scenes().length, 1);
    if (nativeOutcome === "uncertain write") fail(new Error("停止帧未获确认"));
    else finish();
    await settle();
    await ui.tick(699);
    assert.equal(ui.scenes().length, 1);
    await ui.tick(1);
    assert.equal(ui.steps().length, nativeOutcome === "acknowledged" ? 2 : 1);
    await ui.tick(700);
    assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  });
}

test("a vague stroll, a directionless number, and out-of-range or non-imperative counts do not move", async t => {
  const ui = await classroomRenderer(t, true, {}, countedWalkCapabilities);
  for (const phrase of ["散步", "三步", "向后走零步", "向后走11步", "不要向后走两步", "我该怎么说向后走两步？"]) {
    await ui.say(phrase);
    if (phrase === "散步" || phrase === "三步") assert.match(ui.document.getElementById("voice-status").textContent, /方向|向前|向后/);
  }
  assert.deepEqual(ui.classroomRequests, []);
  assert.deepEqual(ui.guidanceRequests, []);
  assert.equal(ui.moves.filter(nonzero).length, 0);
});

test("averaging a series of pulses uses the selected direction and converts travel to meters", async t => {
  const ui = await classroomRenderer(t, false, {}, { classroomPulseVersion: 1 });
  const field = suffix => ui.document.getElementById("class-" + suffix);
  const expected = { step: "0.2", backward: "", left: "", turn: "20" };
  for (const [direction, count, total, mean] of [
    ["step", 5, 75, 0.15], ["backward", 4, 44, 0.11],
    ["left", 3, 93, 31], ["turn", 4, 90, 22.5],
  ]) {
    const select = field("estimate-direction");
    select.value = direction;
    select.fire("change");
    field("estimate-count").value = String(count);
    field("estimate-total").value = String(total);
    field("estimate-apply").click();
    assert.equal(Number(field(direction).value), mean, direction);
    expected[direction] = field(direction).value;
    for (const [other, value] of Object.entries(expected)) assert.equal(field(other).value, value, other);
  }
  assert.deepEqual(ui.steps(), []);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("invalid pulse samples preserve the existing value and do not issue motion", async t => {
  const ui = await classroomRenderer(t, false, {}, { classroomPulseVersion: 1 });
  const field = suffix => ui.document.getElementById("class-" + suffix);
  field("estimate-direction").value = "turn";
  field("estimate-direction").fire("change");
  for (const [count, total] of [["", "30"], ["0", "30"], ["1.5", "30"], ["2", ""], ["2", "-5"], ["2", "360"]]) {
    field("estimate-count").value = count;
    field("estimate-total").value = total;
    field("estimate-apply").click();
    assert.equal(field("turn").value, "20");
    assert.ok(field("estimate-result").textContent);
  }
  assert.deepEqual(ui.steps(), []);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("changing pulse profile invalidates dependent distance and turn measurements while preserving the room geometry", async t => {
  const ui = await classroomRenderer(t, false, {}, { classroomPulseVersion: 1 });
  const field = suffix => ui.document.getElementById("class-" + suffix);
  for (const id of ["step", "backward", "turn", "left"]) field(id).value = "11";
  const select = field("pulse-profile");
  field("estimate-total").value = "200";
  select.value = "gentle";
  select.fire("change");
  for (const id of ["step", "backward", "turn", "left"]) assert.equal(field(id).value, "", id);
  assert.equal(field("estimate-total").value, "");
  assert.deepEqual(["width", "height", "greeting"].map(key => field(key).value), ["2", "2", "0.8"]);
  assert.deepEqual(ui.steps(), []);
});

test("losing a known classroom pulse capability removes profile controls and measurements before the next one-step command", async t => {
  const ui = await classroomRenderer(t, false, {}, { classroomPulseVersion: 1 }, "strong");
  const field = suffix => ui.document.getElementById("class-" + suffix);
  field("step").value = "0.22";
  ui.robotSnapshot.classroomPulseVersion = 2;
  const status = ui.document.querySelectorAll("[data-query]").find(button => button.dataset.query === "status");
  status.click();
  await settle();
  assert.equal(field("pulse-setting").hidden, true);
  assert.equal(field("pulse-profile").disabled, true);
  assert.equal(field("step").value, "");
  await ui.say("往前走一步");
  assert.equal(ui.classroomRequests[0].operation, "beginClassroom");
  assert.equal(Object.hasOwn(ui.classroomRequests[0], "pulseProfile"), false);
  assert.deepEqual(ui.steps().map(step => step.action), ["forward"]);
  await ui.tick(700);
});

test("an empty calibration form lets the classroom turn left and learn its forward step from fresh frames", async t => {
  const scene = (x, headingY, distanceM, approachDistanceM, turnDeg) => ({
    ...classroomScene(x), headingPoint: { x: x + 0.06, y: headingY },
    approach: { x: 0.4, y: 0.5 }, distanceM, approachDistanceM, turnDeg,
    atGreeting: approachDistanceM === 0,
  });
  const frames = [
    scene(0.2, 0.535, 1.8, 1, -30),
    scene(0.2, 0.5, 1.8, 1, 0),
    scene(0.3, 0.5, 1.3, 0.5, 0),
    scene(0.4, 0.5, 0.8, 0, 0),
  ];
  const ui = await renderer(t, {
    robotStatus: 2, initial: { sceneVisionVersion: 1, connectionId: "auto-link", visionVersion: 2 },
    classroom: { uncalibrated: true, observe: () => frames.shift() },
  });
  for (const name of ["step", "backward", "left", "turn", "width", "height"]) {
    assert.equal(ui.document.getElementById("class-" + name).value, "", name);
  }
  await click(ui, "vision-toggle");
  await ui.chooseMode("walk");
  ui.document.getElementById("voice-command").value = "走到垃圾桶旁边";
  await click(ui, "voice-run");
  const steps = () => ui.classroomRequests.filter(r => r.operation === "classroomStep").map(r => r.action);
  assert.deepEqual(steps(), ["left"]);
  await ui.tick(700);
  assert.deepEqual(steps(), ["left", "forward"]);
  await ui.tick(700);
  assert.deepEqual(steps(), ["left", "forward", "forward"]);
  await ui.tick(700);
  const scenes = ui.classroomRequests.filter(r => r.operation === "locateVision");
  assert.equal(new Set(scenes.map(r => r.imageDataUrl)).size, 4);
  assert.deepEqual(scenes[0].sceneScale, { auto: true, calibratedFloor: false, greetingM: 0.8 });
  assert.equal(scenes.at(-1).sceneScale.stepM, 0.5);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.match(ui.document.getElementById("voice-status").textContent, /已停在垃圾桶旁/);
});

test("classroom navigation with measured pulses needs no floor dimensions or camera calibration", async t => {
  let step = 0;
  const ui = await renderer(t, {
    robotStatus: 2,
    initial: { sceneVisionVersion: 1, connectionId: "auto-link", visionVersion: 2 },
    classroom: {
      uncalibrated: true,
      observe: () => {
        if (step === 0) {
          return {
            status: "ready", confidence: 0.92,
            robot: { x: 0.3, y: 0.7 }, headingPoint: { x: 0.35, y: 0.68 },
            target: { x: 0.6, y: 0.4 }, approach: { x: 0.5, y: 0.48 },
            distanceM: 1.0, approachDistanceM: 0.2, turnDeg: 28, atGreeting: false,
            pathClear: true, turnClear: true, rearClear: true,
          };
        }
        if (step === 1) {
          return {
            status: "ready", confidence: 0.92,
            robot: { x: 0.3, y: 0.7 }, headingPoint: { x: 0.36, y: 0.64 },
            target: { x: 0.6, y: 0.4 }, approach: { x: 0.5, y: 0.48 },
            distanceM: 1.0, approachDistanceM: 0.2, turnDeg: 4, atGreeting: false,
            pathClear: true, turnClear: true, rearClear: true,
          };
        }
        return {
          status: "ready", confidence: 0.94,
          robot: { x: 0.38, y: 0.62 }, headingPoint: { x: 0.43, y: 0.58 },
          target: { x: 0.6, y: 0.4 }, approach: { x: 0.38, y: 0.62 },
          distanceM: 0.82, approachDistanceM: 0.0, turnDeg: 2, atGreeting: true,
          pathClear: true, turnClear: true, rearClear: true,
        };
      },
      step: async req => {
        if (req.action === "right" || req.action === "forward") step++;
      },
    },
  });
  ui.document.getElementById("class-step").value = "0.15";
  ui.document.getElementById("class-turn").value = "20";
  await click(ui, "vision-toggle");
  await ui.chooseMode("walk");
  ui.document.getElementById("voice-command").value = "走到穿粉色上衣的人旁边打招呼";
  await click(ui, "voice-run");
  for (let i = 0; i < 12; i++) await ui.tick(300);
  const scenes = ui.classroomRequests.filter(r => r.operation === "locateVision");
  const steps = ui.classroomRequests.filter(r => r.operation === "classroomStep");
  assert.equal(scenes.length, 4, "one observation per turn and forward pulse, then check arrival before waving");
  assert.deepEqual(scenes[0].sceneScale, { auto: true, calibratedFloor: false, greetingM: 0.8, stepM: 0.15 });
  assert.deepEqual(steps.map(r => r.action), ["right", "forward", "wave", "greet"]);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.match(ui.document.getElementById("voice-status").textContent, /画面确认已停在穿粉色上衣的人旁/);
});

test("older hosts keep ordinary gestures available and receive no classroom IPC for scene or following commands", async t => {
  const ui = await renderer(t, { initial: { connectionId: "legacy" } });
  await ui.chooseMode("walk");
  const input = ui.document.getElementById("voice-command");
  const previous = ui.calls.length;
  for (const phrase of ["跟着穿粉色上衣的人", "走到穿粉色上衣的人旁边打招呼"]) {
    input.value = phrase;
    await click(ui, "voice-run");
    assert.match(ui.document.getElementById("voice-status").textContent, /桌面宿主.*课堂/);
  }
  assert.equal(ui.calls.length, previous);
  input.value = "握个手";
  await click(ui, "voice-run");
  await ui.tick(700);
  assert.deepEqual(ui.actions, ["walk", "move", "status", "handshake"]);
});

for (const outcome of ["settled", "stop", "blur", "disconnect", "failed step"]) {
  test(`a handshake spoken during one classroom step awaits that step's result: ${outcome}`, async t => {
    let finish, fail;
    const ui = await renderer(t, { initial: { connectionId: "step-link", sceneVisionVersion: 1 },
      classroom: { step: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) } });
    await ui.chooseMode("walk");
    const say = async phrase => {
      ui.document.getElementById("voice-command").value = phrase;
      await click(ui, "voice-run");
    };
    await say("往前走一步");
    await say("握个手");
    await ui.tick(1000);
    assert.deepEqual(ui.actions, ["walk"]);
    if (outcome === "stop") await say("停下来");
    if (outcome === "blur") ui.window.fire("blur");
    if (outcome === "disconnect") ui.emit("bumi:disconnected", { connectionId: "step-link", id: "test-bumi" });
    if (outcome === "failed step") fail(new Error("BLE 写入失败"));
    else finish();
    await settle();
    await ui.tick(700);
    assert.equal(ui.actions.includes("handshake"), false);
    await ui.tick(700);
    assert.equal(ui.actions.filter(action => action === "handshake").length, outcome === "settled" ? 1 : 0);
  });
}

test("an older host confirms the end of its timed jog before a requested handshake", async t => {
  let finishStop;
  const ui = await renderer(t, {
    beforeMove() {
      if (!finishStop && ui.moves.at(-1).every(axis => axis === 0)) {
        return new Promise(resolve => { finishStop = resolve; });
      }
    },
  });
  await ui.chooseMode("walk");
  const input = ui.document.getElementById("voice-command");
  input.value = "往前走一步";
  await click(ui, "voice-run");
  input.value = "握个手";
  await click(ui, "voice-run");
  await ui.tick(800);
  assert.equal(ui.actions.includes("handshake"), false);
  finishStop();
  await settle();
  await ui.tick(700);
  assert.equal(ui.actions.filter(action => action === "handshake").length, 1);
  assert.ok(ui.moves.at(-1).every(axis => axis === 0));
});

for (const abort of [false, true]) {
  test(`Xiaomi handshake during a spoken step waits for its native stop and respects takeover=${abort}`, async t => {
    let finish;
    const ui = await renderer(t, { remote: true, robotStatus: 2,
      beforeGuide: req => req.direction ? undefined : new Promise(resolve => { finish = resolve; }),
    });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    pushVoice(capture, "往前走一步");
    await settle();
    pushVoice(capture, "握个手");
    await settle();
    assert.equal(ui.guidanceRequests.at(-1).direction, undefined);
    assert.equal(ui.actions.includes("handshake"), false);
    if (abort) { pushKeys(capture, "up"); pushKeys(capture); }
    finish();
    await settle();
    await ui.tick(350);
    pushKeys(capture);
    await ui.tick(350);
    assert.equal(ui.actions.filter(action => action === "handshake").length, abort ? 0 : 1);
  });
}

for (const outcome of ["operator stop", "lost focus", "robot not ready", "unconfirmed zero"]) {
  test(`single handshake never plays after ${outcome}`, async t => {
    const ui = await renderer(t, {
      robotStatus: outcome === "robot not ready" ? 26 : 1,
      beforeMove() { if (outcome === "unconfirmed zero") throw new Error("写入超时"); },
    });
    const input = ui.document.getElementById("voice-command");
    input.value = "握个手";
    await click(ui, "voice-run");
    if (outcome === "operator stop") {
      input.value = "停下来";
      await click(ui, "voice-run");
    } else if (outcome === "lost focus") ui.window.fire("blur");
    await ui.tick(800);
    assert.equal(ui.actions.includes("handshake"), false);
    assert.ok(ui.moves.length > 0 && ui.moves.every(axes => !nonzero(axes)));
  });
}

const spokenPostures = [
  ["跳舞", "dance"], ["挥手", "wave"], ["握手", "handshake"], ["欢呼", "cheer"],
];

test("Xiaomi voice steps work without a route and stop after 400 ms for each direction", async t => {
  const ui = await renderer(t, {
    remote: true, robotStatus: 2, initial: { remoteVoiceStepDirections: true },
  });
  const capture = await beginRemote(ui);
  for (const [phrase, direction] of [
    ["向前走一步", "forward"], ["后退一步", "backward"],
    ["向左移一步", "strafeLeft"], ["向右移一步", "strafeRight"],
    ["向左转一下", "left"], ["向右转一下", "right"],
  ]) {
    const before = ui.guidanceRequests.length;
    pushKeys(capture);
    pushVoice(capture, phrase + "。");
    await settle();
    const first = ui.guidanceRequests[before];
    assert.equal(first?.direction, direction, phrase);
    assert.equal(first.voiceId, capture.lastVoiceId);
    assert.equal(first.captureId, capture.captureId);
    assert.ok(first.pressId > 0);
    await ui.tick(399);
    const writes = ui.guidanceRequests.slice(before);
    assert.ok(writes.every(req => req.direction === direction && req.pressId === first.pressId &&
      req.voiceId === first.voiceId && req.captureId === first.captureId));
    await ui.tick(1);
    assert.deepEqual(ui.guidanceRequests.at(-1), {
      operation: "guide", captureId: first.captureId, pressId: first.pressId,
    });
    const stoppedAt = ui.guidanceRequests.length;
    pushKeys(capture);
    pushVoice(capture, phrase, { voiceId: first.voiceId });
    await ui.tick(100);
    assert.equal(ui.guidanceRequests.length, stoppedAt);
    assert.equal(ui.document.getElementById("remote-shield").open, true);
    assert.deepEqual(ui.captureStops, []);
  }
  assert.deepEqual(ui.moves, [], "a spoken step never uses a free-running move");
});

test("Xiaomi step commands require a complete imperative, fresh speech, and released directions", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  for (const phrase of ["不要向前走一步", "向前走一步？", "向前走一步再后退", "向前走十步"]) {
    pushVoice(capture, phrase);
  }
  pushVoice(capture, "向前走一步", { sampledAt: Date.now() - 2_000 });
  pushKeys(capture, "up");
  await settle();
  pushVoice(capture, "向前走一步");
  pushKeys(capture);
  await settle();
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.moves, [[80, 0, 0], stopped]);
});

test("a failed spoken step keeps the native error visible after revoking the capture", async t => {
  const ui = await renderer(t, {
    remote: true, robotStatus: 2,
    beforeGuide: request => { if (request.direction) throw new Error("GATT write failed"); },
  });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushVoice(capture, "向前走一步");
  await settle();
  assert.deepEqual(ui.captureStops, [capture.captureId]);
  capture.events.onmessage({ keys: [], sampledAt: Date.now(), error: "方向键监听已停止。" });
  pushVoice(capture, "向前走一步");
  await ui.tick(500);
  assertRemotePaused(ui, /GATT write failed/);
  assert.equal(ui.guidanceRequests.filter(request => request.direction).length, 1);
});

for (const interruption of ["blur", "direction key", "spoken stop"]) {
  test(`an in-progress Xiaomi voice step stops immediately on ${interruption}`, async t => {
    const ui = await renderer(t, { remote: true, robotStatus: 2 });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    pushVoice(capture, "向前走一步");
    await settle();
    assert.equal(ui.guidanceRequests[0]?.direction, "forward");
    if (interruption === "blur") ui.window.fire("blur");
    if (interruption === "direction key") pushKeys(capture, "left");
    if (interruption === "spoken stop") pushVoice(capture, "停止");
    await settle();
    assert.deepEqual(ui.guidanceRequests.at(-1), {
      operation: "guide", captureId: capture.captureId, pressId: ui.guidanceRequests[0].pressId,
    });
    const stoppedAt = ui.guidanceRequests.length;
    await ui.tick(450);
    assert.equal(ui.guidanceRequests.length, stoppedAt);
    assert.deepEqual(ui.moves.filter(nonzero), []);
  });
}

test("Xiaomi steps negotiate the host's supported directions independently of the remote keys", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  for (const phrase of ["后退一步", "向左移一步", "向右移一步"]) pushVoice(capture, phrase);
  await settle();
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.moves, []);
  pushVoice(capture, "向前走一步");
  await settle();
  assert.equal(ui.guidanceRequests[0]?.direction, "forward");
  await ui.tick(400);
  pushKeys(capture, "down");
  await settle();
  pushKeys(capture);
  await settle();
  assert.deepEqual(ui.moves, [[-80, 0, 0], stopped]);
});

test("Xiaomi steps are unavailable without guided motion and leave key control available", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { guidedMotionVersion: undefined } });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushVoice(capture, "向前走一步");
  await settle();
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.moves, []);
  pushKeys(capture, "up");
  await settle();
  assert.deepEqual(ui.moves, [[80, 0, 0]]);
});

for (const [phrase, action] of spokenPostures) {
  test(`a final Xiaomi ${action} command clears the gait and keeps listening in the same remote`, async t => {
    const ui = await renderer(t, { remote: true, robotStatus: 2 });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    assert.equal(capture.voiceCommands, true);
    pushVoice(capture, phrase + "。");
    pushVoice(capture, phrase + "。", { voiceId: 1 });
    await settle();
    if (action === "handshake") {
      await ui.tick(350);
      pushKeys(capture);
      await ui.tick(350);
    }
    const issued = ui.commandRequests.filter(request => request.voiceId !== undefined);
    assert.deepEqual(issued, [{
      operation: "send", command: { action }, remoteCaptureId: capture.captureId, voiceId: 1,
    }]);
    assert.equal(ui.robotSnapshot.locomotionMode, null);
    assert.equal(ui.document.getElementById("remote-shield-close").textContent, "关闭遥控");
    assert.equal(ui.document.getElementById("remote-shield-voice").hidden, false);
    pushKeys(capture, "up");
    await settle();
    pushKeys(capture);
    pushVoice(capture, "向前走一步");
    await settle();
    assert.deepEqual(ui.guidanceRequests, []);
    assert.deepEqual(ui.moves.filter(nonzero), []);
    const preparation = action === "handshake" ? ["move", "status"] : [];
    assert.deepEqual(ui.actions, ["walk", "status", ...preparation, action], "a step never implicitly restores the gait");

    pushVoice(capture, "握手");
    await settle();
    await ui.tick(350);
    pushKeys(capture);
    await ui.tick(350);
    assert.deepEqual(ui.commandRequests.at(-1), {
      operation: "send", command: { action: "handshake" }, remoteCaptureId: capture.captureId, voiceId: capture.lastVoiceId,
    });
    assert.deepEqual(ui.captureStops, []);
    assert.equal(ui.captures.length, 1);
    assert.equal(ui.document.getElementById("remote-shield").open, true);
  });
}

for (const [phrase, mode] of [["进入行走模式", "walk"], ["进入全身行走模式", "run"]]) {
  test(`the operator can select ${mode} by voice after waving and then send a fresh step`, async t => {
    const ui = await renderer(t, { remote: true, robotStatus: 2 });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    pushVoice(capture, "挥手");
    await settle();
    pushVoice(capture, phrase);
    await settle();
    assert.deepEqual(ui.commandRequests.at(-1), {
      operation: "send", command: { action: mode }, remoteCaptureId: capture.captureId, voiceId: capture.lastVoiceId,
    });
    const before = ui.commandRequests.length;
    pushVoice(capture, phrase, { voiceId: capture.lastVoiceId });
    pushVoice(capture, "向前走一步");
    await settle();
    assert.equal(ui.commandRequests.length, before);
    assert.equal(ui.guidanceRequests[0]?.direction, "forward");
    assert.equal(ui.guidanceRequests[0].voiceId, capture.lastVoiceId);
    assert.equal(ui.guidanceRequests[0].captureId, capture.captureId);
    await ui.tick(400);
    assert.equal(ui.guidanceRequests.at(-1).direction, undefined);
    assert.deepEqual(ui.captureStops, []);
  });
}

test("a slow, unconfirmed spoken gait never drives with the previous gait or replays queued input", async t => {
  let report;
  const reading = new Promise(resolve => { report = resolve; });
  const ui = await renderer(t, { remote: true, robotStatus: 2, readVoiceModeStatus: () => reading });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushVoice(capture, "进入全身行走模式");
  await settle();
  assert.equal(ui.commandRequests.at(-1).command.action, "run");
  pushVoice(capture, "向前走一步");
  pushKeys(capture, "up");
  pushKeys(capture);
  report(26);
  await settle();
  pushKeys(capture, "up");
  pushKeys(capture);
  pushVoice(capture, "向前走一步");
  await settle();
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("an older voice host never receives unsupported spoken gait changes", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteVoiceContinue: undefined } });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushVoice(capture, "进入全身行走模式");
  await settle();
  pushVoice(capture, "挥手");
  await settle();
  assert.equal(ui.document.getElementById("remote-shield-close").textContent, "关闭遥控");
  pushVoice(capture, "握手");
  await settle();
  pushVoice(capture, "进入行走模式");
  await settle();
  assert.deepEqual(ui.actions, ["walk", "status", "wave"]);
  assert.match(ui.document.getElementById("voice-status").textContent, /步态|行走模式/);
  assert.deepEqual(ui.captureStops, []);
});

test("negated, questioning, and compound Xiaomi gesture phrases keep the robot idle", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  const before = ui.actions.length;
  for (const phrase of ["不要挥手", "握手？", "挥手再欢呼"]) {
    pushVoice(capture, phrase);
    await settle();
  }
  assert.deepEqual(ui.actions.slice(before), []);
  assert.deepEqual(ui.moves.filter(nonzero), []);
  assert.equal(ui.document.getElementById("remote-shield").open, true);
});

test("Xiaomi voice on a host without the gesture capability still supports dance", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteVoiceGestures: undefined } });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  const before = ui.actions.length;
  for (const phrase of ["挥手", "握手", "欢呼"]) {
    pushVoice(capture, phrase);
    await settle();
  }
  assert.deepEqual(ui.actions.slice(before), []);
  assert.equal(ui.document.getElementById("remote-shield").open, true);
  pushVoice(capture, "跳个舞");
  await settle();
  assert.deepEqual(ui.actions.slice(before), ["dance"]);
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
  pushVoice(capture, "挥手");
  pushVoice(capture, "走到讲台");
  await settle();
  assert.equal(ui.document.getElementById("remote-shield").open, true);
  assert.equal(ui.actions.includes("dance"), false);
  assert.equal(ui.actions.includes("wave"), false);
  assert.deepEqual(ui.moves, [[0, 80, 0]]);
  pushVoice(capture, "停止");
  pushKeys(capture, "right");
  finish();
  await settle();
  assert.deepEqual(ui.moves, [[0, 80, 0], stopped]);
  pushKeys(capture, "right");
  pushVoice(capture, "挥手");
  await settle();
  assert.equal(ui.actions.includes("wave"), false);
  assert.deepEqual(ui.moves, [[0, 80, 0], stopped]);
  pushKeys(capture);
  pushVoice(capture, "挥手");
  await settle();
  assert.equal(ui.actions.at(-1), "wave");
  assert.deepEqual(ui.captureStops, []);
  assert.equal(ui.captures.length, 1);
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
  assertRemotePaused(ui, /前台|焦点/);
  await click(ui, "remote-shield-close");
  assert.equal(ui.document.getElementById("remote-shield").open, false);
  await click(ui, "remote-toggle");
  const active = ui.captures[2];
  await ui.tick(0); // The previous dialog's queued close event arrives after reopening.
  assert.equal(ui.document.getElementById("remote-shield").open, true);
  assert.ok(!ui.captureStops.includes(active.captureId));
  pushKeys(active);
  pushVoice(previous, "跳舞");
  active.events.onmessage({ keys: [], sampledAt: Date.now(), voiceId: 1, voiceError: "无法确认遥控器来源。" });
  assert.match(ui.document.getElementById("voice-status").textContent, /来源/);
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
  assertRemotePaused(ui, /超时/);
  assert.deepEqual(ui.captureStops, [capture.captureId]);
  pushVoice(capture, "跳舞");
  assert.equal(ui.actions.includes("dance"), false);
});

test("retired route commands and replayed Xiaomi samples cannot issue movement or confirm arrival", async t => {
  const ui = await classroomRenderer(t, true, {}, { classroomPulseVersion: 1 });
  for (const phrase of ["执行本段", "已到位", "下一段", "不要向前走一步"]) await ui.say(phrase);
  assert.deepEqual(ui.classroomRequests, []);
  assert.deepEqual(ui.guidanceRequests, []);
  assert.deepEqual(ui.moves, []);
  await ui.say("往前走一步");
  await ui.tick(700);
  pushVoice(ui.capture, "往前走一步", { voiceId: ui.capture.lastVoiceId });
  await settle();
  assert.deepEqual(ui.steps().map(r => r.action), ["forward"]);
});

test("a failed Xiaomi step stop pauses the remote and blocks the old capture's next gesture", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2,
    beforeGuide: request => { if (!request.direction) throw new Error("stop not confirmed"); },
  });
  const capture = await beginRemote(ui);
  pushKeys(capture);
  pushVoice(capture, "向前走一步");
  await settle();
  await ui.tick(400);
  assertRemotePaused(ui, /停止未确认/);
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

test("driving opens a shield that swallows remote keyboard events and closes on explicit dismissal", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteMenuSwitch: true } });
  const shield = ui.document.getElementById("remote-shield");
  assert.equal(shield.open, false);
  await ui.chooseMode("walk");
  ui.document.getElementById("remote-diagnose").click();
  await settle();
  assert.equal(shield.open, false, "key check does not cover the page");
  ui.window.fire("blur");
  await settle();
  assert.equal(shield.open, false, "interrupting a diagnostic does not show a paused drive");
  await ui.chooseMode("walk");
  await click(ui, "remote-toggle");
  assert.equal(shield.open, true);
  for (const key of ["Enter", "ContextMenu"]) {
    const event = new Event("keydown", { cancelable: true });
    event.key = key;
    ui.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  const contextMenu = new Event("contextmenu", { cancelable: true });
  shield.dispatchEvent(contextMenu);
  assert.equal(contextMenu.defaultPrevented, true);
  ui.document.getElementById("remote-shield-close").click();
  await settle();
  assert.equal(shield.open, false);
  assert.equal(ui.captures.length, 2);
  assert.equal(ui.captureStops.length, 2);
});

test("remote diagnostics display the direction and menu keys without connecting or sending motion", async t => {
  const ui = await renderer(t, { remote: true, initial: { remoteMenuSwitch: true, connected: null, devices: [] } });
  await click(ui, "remote-diagnose");
  const capture = ui.captures[0];
  assert.equal(capture.menuSwitch, true);
  pushMenuSample(capture, false);
  pushMenuSample(capture, false, "left");
  await settle();
  assert.match(ui.document.getElementById("remote-status").textContent, /左|left/i);
  pushMenuSample(capture, false);
  pushMenuSample(capture, true, "menu");
  await settle();
  assert.match(ui.document.getElementById("remote-status").textContent, /菜单/);
  pushMenuSample(capture, true);
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
  assert.equal(ui.document.getElementById("remote-shield").open, false, "an unconfirmed gait never armed driving");
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

test("a host without menu switching keeps remote left and right on yaw even with the screen stick set to lateral", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2 });
  await ui.chooseMode("walk");
  const horizontal = ui.document.getElementById("stick-horizontal");
  assert.equal(horizontal.disabled, false);
  selectStickMode(ui, "lateral");
  await click(ui, "remote-toggle");
  assert.equal(horizontal.disabled, true);
  assert.equal(ui.document.getElementById("stick-lateral").checked, true);
  const capture = ui.captures[0];
  assert.ok(!capture.menuSwitch);
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

test("the Xiaomi menu switches only the horizontal axis, keeps a held menu stationary and switches back", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteMenuSwitch: true } });
  const capture = await beginRemote(ui);
  assert.equal(capture.menuSwitch, true);
  pushMenuSample(capture, false);
  for (const strafe of [true, false]) {
    const beforeMenu = ui.moves.length;
    pushMenuSample(capture, strafe, "menu");
    for (let i = 0; i < 3; i++) {
      await ui.tick(100);
      pushMenuSample(capture, strafe, "menu");
    }
    pushMenuSample(capture, strafe);
    await settle();
    assert.deepEqual(ui.moves.slice(beforeMenu), []);
    assert.match(ui.document.getElementById("remote-shield-status").textContent,
      strafe ? /平移|侧移/ : /转向|旋转/);
    for (const [key, vector] of [
      ["left", strafe ? [0, 0, 80] : [0, 80, 0]],
      ["right", strafe ? [0, 0, -80] : [0, -80, 0]],
      ["up", [80, 0, 0]], ["down", [-80, 0, 0]],
    ]) {
      const start = ui.moves.length;
      pushMenuSample(capture, strafe, key);
      await settle();
      assert.equal(ui.movementRequests.at(-1).remoteCaptureId, capture.captureId);
      pushMenuSample(capture, strafe);
      await settle();
      assert.deepEqual(ui.moves.slice(start), [vector, stopped]);
    }
  }
});

test("a Xiaomi menu and direction chord stops motion and requires full release before a new turn", async t => {
  const ui = await renderer(t, { remote: true, robotStatus: 2, initial: { remoteMenuSwitch: true } });
  const capture = await beginRemote(ui);
  pushMenuSample(capture, false);
  pushMenuSample(capture, false, "left");
  await settle();
  pushMenuSample(capture, false, "left", "menu");
  await settle();
  pushMenuSample(capture, false, "left");
  await ui.tick(250);
  assert.deepEqual(ui.moves, [[0, 80, 0], stopped]);
  pushMenuSample(capture, false);
  pushMenuSample(capture, false, "right");
  await settle();
  assert.deepEqual(ui.moves.at(-1), [0, -80, 0]);
});

for (const end of ["blur", "device removal", "close remote", "page hidden"]) {
  test(end + " queues stop behind an in-flight remote write and rejects stale input", async t => {
    let finish;
    const busy = new Promise(resolve => { finish = resolve; });
    const ui = await renderer(t, { remote: true, robotStatus: 2, beforeMove: count => count === 1 ? busy : undefined });
    const capture = await beginRemote(ui);
    pushKeys(capture);
    pushKeys(capture, "up");
    if (end === "blur") ui.window.fire("blur");
    if (end === "device removal") capture.events.onmessage({ keys: [], sampledAt: Date.now(), error: "RC003 disconnected" });
    if (end === "close remote") ui.document.getElementById("remote-shield-close").click();
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
  selectStickMode(ui, "lateral");
  delete ui.robotSnapshot.remoteMotionVersion;
  const status = ui.document.querySelectorAll("[data-query]").find(button => button.dataset.query === "status");
  status.click();
  await settle();
  assert.equal(horizontal.disabled, true);
  assert.equal(ui.document.getElementById("stick-yaw").checked, true);
  assert.equal(ui.document.getElementById("stick-lateral").checked, false);
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
  selectStickMode(ui, "lateral");
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
  assert.equal(ui.document.getElementById("remote-shield").open, false, "no ready capture to pause");
  assert.deepEqual(ui.moves.filter(nonzero), []);
});

test("disconnecting and reconnecting a robot requires a new remote session and a fresh press", async t => {
  const robot = { id: "test-bumi", name: "Bumi", rssi: -50 };
  const ui = await renderer(t, { remote: true, robotStatus: 2, scanDevices: [robot] });
  const old = await beginRemote(ui);
  pushKeys(old);
  pushKeys(old, "up");
  await settle();
  await click(ui, "remote-shield-close");
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

test("opening a camera with saved grid data remains local until a named visual task starts", async t => {
  const oldMap = JSON.stringify(Array.from({ length: 25 }, (_, i) =>
    ({ terrain: "floor", name: i === 1 ? "讲台" : "" })));
  const stored = new Map([["keepwork.bumi.floor-map.v1", oldMap]]);
  let seen = 0;
  const ui = await classroomRenderer(t, false, { storage: stored, observe: () => ++seen === 1
    ? classroomScene(0.1) : classroomScene(0.2) });
  await ui.tick(8000);
  assert.equal(ui.calls.includes("locateVision"), false);
  assert.deepEqual(ui.moves, []);
  await ui.say("走到讲台");
  await ui.tick(700);
  assert.deepEqual(ui.steps().map(r => r.action), ["forward"]);
  const scenes = ui.scenes();
  assert.equal(scenes.length, 2);
  assert.equal(new Set(scenes.map(r => r.imageDataUrl)).size, 2);
  assert.ok(scenes.every(r => r.sceneTarget === "讲台" && !Object.hasOwn(r, "gridSize") && !Object.hasOwn(r, "goalCell")));
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.equal(stored.get("keepwork.bumi.floor-map.v1"), oldMap);
  assert.deepEqual(ui.guidanceRequests, []);
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
  assertRemotePaused(ui, /停止状态未知/);
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

test("legacy hosts without teachVersion hide the teach panel and keep ordinary actions working", async t => {
  const ui = await renderer(t);
  assert.equal(ui.document.getElementById("teach-panel").hidden, true);
  const wave = ui.document.querySelectorAll("[data-command]").find(item => item.dataset.command === "wave");
  assert.equal(wave.disabled, false);
  wave.click();
  await settle();
  assert.deepEqual(ui.actions, ["wave"]);
});

test("teach recording locks motion, counts down, saves the name, refreshes, plays, and deletes custom actions", async t => {
  const ui = await renderer(t, { initial: { teachVersion: 1, teachActions: [] } });
  const doc = ui.document;
  assert.equal(doc.getElementById("teach-panel").hidden, false);
  await ui.chooseMode("run");
  assert.equal(ui.forward.disabled, false);

  doc.getElementById("teach-start").click();
  await settle();
  assert.equal(ui.actions.at(-1), "startTeach");
  assert.equal(doc.getElementById("teach-start").hidden, true);
  assert.equal(doc.getElementById("teach-stop").hidden, false);
  assert.equal(doc.getElementById("teach-timer").hidden, false);
  assert.equal(doc.getElementById("teach-timer").textContent, "录制中 · 剩余 60 秒");
  assert.equal(ui.forward.disabled, true);
  assert.equal(doc.getElementById("walk-mode").disabled, true);
  assert.equal(doc.getElementById("run-mode").disabled, true);

  await ui.tick(5000);
  assert.equal(doc.getElementById("teach-timer").textContent, "录制中 · 剩余 55 秒");

  doc.getElementById("teach-stop").click();
  await settle();
  assert.equal(ui.actions.at(-1), "startTeach", "naming leaves the recording available to save");
  assert.equal(ui.robotSnapshot.teachRecording, true);
  assert.equal(doc.getElementById("walk-mode").disabled, true);
  assert.equal(doc.getElementById("run-mode").disabled, true);
  assert.equal(doc.getElementById("teach-save-box").hidden, false);
  assert.equal(doc.getElementById("teach-save").disabled, true);

  const nameInput = doc.getElementById("teach-name");
  nameInput.value = "左摆臂";
  nameInput.fire("input");
  assert.equal(doc.getElementById("teach-save").disabled, false);

  nameInput.fire("keydown", { key: "Enter", isComposing: true });
  await settle();
  assert.equal(ui.actions.at(-1), "startTeach", "confirming an IME candidate keeps the recording open");
  nameInput.fire("keydown", { key: "Enter", isComposing: false });
  await settle();
  assert.deepEqual(ui.actions.slice(-2), ["saveTeach", "teachList"]);
  assert.equal(ui.actions.includes("stopTeach"), false);
  assert.deepEqual(ui.commandRequests.at(-2).command, { action: "saveTeach", name: "左摆臂" });
  assert.equal(doc.getElementById("teach-save-box").hidden, true);

  const list = doc.getElementById("teach-list");
  assert.equal(list.children.length, 1);
  const buttons = list.children[0].children[1].children;
  const playBtn = buttons[0];
  const deleteBtn = buttons[1];
  assert.equal(playBtn.dataset.teachPlay, "1");
  assert.equal(deleteBtn.dataset.teachDelete, "1");

  await ui.chooseMode("walk");
  playBtn.click();
  await settle();
  assert.deepEqual(ui.commandRequests.at(-1).command, { action: "playTeach", id: 1 });
  assert.equal(ui.forward.disabled, true, "playing a custom teach action clears the selected gait");

  let confirmed = false;
  ui.window.confirm = () => { confirmed = true; return false; };
  deleteBtn.click();
  await settle();
  assert.equal(confirmed, true);
  assert.equal(ui.actions.includes("deleteTeach"), false);

  ui.window.confirm = () => true;
  deleteBtn.click();
  await settle();
  assert.deepEqual(ui.commandRequests.at(-1).command, { action: "deleteTeach", id: 1 });
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].textContent, /暂无已加载的自定义动作/);
});

test("consecutive recordings keep both Chinese names when the second save takes another list read to appear", async t => {
  let secondReady = false;
  const ui = await renderer(t, {
    initial: { teachVersion: 1, teachActions: [] },
    readTeachList: actions => secondReady ? actions : actions.slice(0, 1),
  });
  const control = id => ui.document.getElementById("teach-" + id);
  const names = () => control("list").children.map(row => row.children[0].children[0].textContent);
  for (const name of ["测试", "挥手"]) {
    control("start").click();
    await settle();
    await ui.tick(4000);
    control("stop").click();
    await settle();
    assert.equal(ui.robotSnapshot.teachRecording, true);
    assert.equal(control("save-box").hidden, false);
    control("name").value = name;
    control("name").fire("input");
    control("save").click();
    await settle();
    assert.deepEqual(ui.commandRequests.at(-2).command, { action: "saveTeach", name });
    assert.equal(ui.actions.at(-1), "teachList");
    assert.deepEqual(names(), ["测试"]);
  }
  assert.match(control("status").textContent, /未|尚|暂|稍后/);

  secondReady = true;
  control("refresh").click();
  await settle();
  assert.deepEqual(names(), ["测试", "挥手"]);
  assert.match(control("status").textContent, /挥手.*#2/);
  control("list").children[1].children[1].children[0].click();
  await settle();
  assert.deepEqual(ui.commandRequests.at(-1).command, { action: "playTeach", id: 2 });
  assert.equal(ui.actions.filter(action => action === "saveTeach").length, 2);
});

test("discard while naming sends the stop command and releases the teaching lock", async t => {
  const ui = await renderer(t, { initial: { teachVersion: 1, teachActions: [] } });
  const control = id => ui.document.getElementById("teach-" + id);
  control("start").click();
  await settle();
  control("stop").click();
  await settle();
  control("discard").click();
  await settle();
  assert.deepEqual(ui.actions, ["startTeach", "stopTeach"]);
  assert.equal(control("save-box").hidden, true);
  assert.equal(control("start").disabled, false);
  assert.equal(ui.document.getElementById("walk-mode").disabled, false);
});

test("the 60-second limit still stops an active recording while it is being named", async t => {
  const ui = await renderer(t, { initial: { teachVersion: 1, teachActions: [] } });
  const control = id => ui.document.getElementById("teach-" + id);
  control("start").click();
  await settle();
  await ui.tick(58_000);
  control("stop").click();
  await settle();
  assert.deepEqual(ui.actions, ["startTeach"]);
  control("name").value = "招手";
  control("name").fire("input");
  await ui.tick(2000);
  assert.deepEqual(ui.actions, ["startTeach", "stopTeach"]);
  assert.equal(control("save-box").hidden, false);
  assert.equal(control("name").value, "招手");
  assert.equal(control("save").disabled, false);
  control("save").click();
  await settle();
  assert.deepEqual(ui.actions, ["startTeach", "stopTeach", "saveTeach", "teachList"]);
  assert.deepEqual(ui.commandRequests.at(-2).command, { action: "saveTeach", name: "招手" });
});

test("teach recording auto-stops at 60 seconds and voice box supports teach commands", async t => {
  const ui = await renderer(t, { initial: { teachVersion: 1, teachActions: [{ id: 2, name: "招手", duration: 4, time: null }] } });
  const doc = ui.document;
  doc.getElementById("voice-command").value = "开始示教";
  doc.getElementById("voice-run").click();
  await settle();
  assert.equal(ui.actions.at(-1), "startTeach");
  await ui.tick(60_000);
  assert.equal(ui.actions.at(-1), "stopTeach");
  assert.equal(doc.getElementById("teach-save-box").hidden, false);
  doc.getElementById("teach-discard").click();
  await settle();
  assert.equal(ui.actions.filter(action => action === "stopTeach").length, 1);
  assert.equal(doc.getElementById("teach-save-box").hidden, true);

  doc.getElementById("voice-command").value = "回放招手";
  doc.getElementById("voice-run").click();
  await settle();
  assert.deepEqual(ui.commandRequests.at(-1).command, { action: "playTeach", id: 2 });
});

test("after a forward step with the classroom camera open, AI inspects a fresh frame and continues until it says stop", async t => {
  const replies = [
    { continue: true, reason: "前方地面畅通" },
    { continue: false, reason: "前方出现课桌" },
  ];
  const ui = await classroomRenderer(t, false, {
    walkContinue: () => replies.shift(),
  }, { walkContinueVersion: 1, classroomPulseVersion: 1 });
  assert.equal(ui.document.getElementById("class-walk-continue-setting").hidden, false);
  assert.equal(ui.document.getElementById("class-walk-continue").checked, true);

  await ui.say("向前走一步");
  assert.deepEqual(ui.steps().map(s => s.action), ["forward"]);
  assert.equal(ui.scenes().length, 0, "the first step runs before the post-step frame check");

  await ui.tick(700);
  assert.equal(ui.scenes().length, 1);
  assert.deepEqual(ui.scenes()[0].walkContinue, { calibratedFloor: true, stepM: 0.2 });
  assert.equal(Object.hasOwn(ui.scenes()[0], "searchView"), false, "fixed classroom camera uses passive view");
  assert.deepEqual(ui.steps().map(s => s.action), ["forward", "forward"]);

  await ui.tick(700);
  assert.equal(ui.scenes().length, 2);
  assert.notEqual(ui.scenes()[0].imageDataUrl, ui.scenes()[1].imageDataUrl);
  assert.deepEqual(ui.steps().map(s => s.action), ["forward", "forward"]);
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.match(ui.document.getElementById("voice-status").textContent, /已前进 2 步，AI 判断停止继续行走（前方出现课桌）/);
});

async function openForwardBoxCamera(ui) {
  let onBoxFrame;
  ui.window.__keepworkBoxCamera = {
    current: () => ({ label: "xiaozhi-box" }),
    open(onFrame) {
      onBoxFrame = onFrame;
      return Promise.resolve(() => {});
    },
  };
  ui.window.__keepworkBoxCameraNotify({ label: "xiaozhi-box" });
  await settle();
  ui.document.getElementById("vision-device").value = "xiaozhi-box";
  await click(ui, "vision-toggle");
  onBoxFrame("frame-0");
  await settle();
  await ui.chooseMode("walk");
  return onBoxFrame;
}

for (const supported of [true, false]) {
  test(`counted walking with the box camera ${supported ? "tracks a forward ground reference" : "requires a fixed camera on an older host"}`, async t => {
    let frames = 0;
    const ui = await renderer(t, {
      robotStatus: 2,
      initial: { ...countedWalkCapabilities, sceneVisionVersion: 1, automaticWalkClearanceVersion: 1,
        walkFloorScaleVersion: 1, ...(supported && { searchViewVersion: 1 }), connectionId: "test-link", visionVersion: 2 },
      classroom: { uncalibrated: true, walkPath() {
        const y = 0.6 + 0.04 * frames++;
        return { robot: { x: 0.5, y }, headingPoint: { x: 0.5, y: y - 0.1 },
          clear: frames === 1, reason: "下一步内有椅腿" };
      } },
    });
    const onBoxFrame = await openForwardBoxCamera(ui);
    ui.document.getElementById("voice-command").value = "向前走两步";
    ui.document.getElementById("voice-run").click();
    await settle();
    onBoxFrame("frame-1");
    await settle();
    const scenes = () => ui.classroomRequests.filter(r => r.operation === "locateVision");
    const steps = () => ui.classroomRequests.filter(r => r.operation === "classroomStep");
    if (!supported) {
      assert.deepEqual(scenes(), []);
      assert.deepEqual(steps(), []);
      assert.match(ui.document.getElementById("voice-status").textContent, /固定/);
      return;
    }
    assert.equal(scenes().length, 1);
    assert.equal(scenes()[0].searchView, "dominant");
    assert.deepEqual(scenes()[0].walkPath, { direction: "forward", calibratedFloor: false });
    assert.equal(ui.snapshotPaint.images.at(-1), scenes()[0].imageDataUrl);
    assert.deepEqual(ui.snapshotPaint.labels, []);
    assert.deepEqual(ui.previewLabels, []);
    assert.deepEqual(steps().map(step => step.action), ["forward"]);
    await ui.tick(700);
    onBoxFrame("frame-2");
    await settle();
    assert.equal(scenes().length, 2);
    assert.equal(scenes()[1].searchView, "dominant");
    assert.deepEqual(scenes()[1].walkPath.priorAnchor, { x: 0.5, y: 0.6 });
    assert.equal(steps().length, 1);
    assert.match(ui.document.getElementById("voice-status").textContent, /下一步内有椅腿/);
  });
}

test("after a forward step with the built-in forward box camera open, AI captures from the box camera using dominant view", async t => {
  const replies = [
    { continue: true, reason: "正前方空旷" },
    { continue: false, reason: "前方靠近墙面" },
  ];
  const ui = await renderer(t, {
    robotStatus: 2,
    initial: { sceneVisionVersion: 1, walkContinueVersion: 1, searchViewVersion: 1, classroomPulseVersion: 1, connectionId: "test-link", visionVersion: 2 },
    classroom: { uncalibrated: true, walkContinue: () => replies.shift() },
  });
  const onBoxFrame = await openForwardBoxCamera(ui);

  ui.document.getElementById("voice-command").value = "前进";
  ui.document.getElementById("voice-run").click();
  await settle();
  assert.deepEqual(ui.classroomRequests.filter(r => r.operation === "classroomStep").map(s => s.action), ["forward"]);

  const settleFirst = ui.tick(700);
  await settle();
  onBoxFrame("frame-1");
  await settleFirst;
  await settle();
  const visions1 = ui.classroomRequests.filter(r => r.operation === "locateVision");
  assert.equal(visions1.length, 1);
  assert.equal(visions1[0].searchView, "dominant", "built-in forward camera automatically uses dominant forward prompt");
  assert.deepEqual(visions1[0].walkContinue, { calibratedFloor: false });
  assert.deepEqual(ui.classroomRequests.filter(r => r.operation === "classroomStep").map(s => s.action), ["forward", "forward"]);

  const settleSecond = ui.tick(700);
  await settle();
  onBoxFrame("frame-2");
  await settleSecond;
  await settle();
  const visions2 = ui.classroomRequests.filter(r => r.operation === "locateVision");
  assert.equal(visions2.length, 2);
  assert.equal(visions2[1].searchView, "dominant");
  assert.equal(ui.classroomRequests.at(-1).operation, "endClassroom");
  assert.match(ui.document.getElementById("voice-status").textContent, /已前进 2 步，AI 判断停止继续行走（前方靠近墙面）/);
});

test("walk-continue check respects its toggle, ignores non-forward steps, and stays hidden on legacy hosts", async t => {
  const ui = await classroomRenderer(t, false, {
    walkContinue: () => { throw new Error("should not call walkContinue"); },
  }, { walkContinueVersion: 1, classroomPulseVersion: 1 });
  // Non-forward steps do not invoke walkContinue even when enabled.
  await ui.say("后退一步");
  await ui.tick(700);
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);

  // Unchecking the toggle restores single-step forward without vision calls.
  ui.classroomRequests.length = 0;
  const toggle = ui.document.getElementById("class-walk-continue");
  toggle.checked = false;
  toggle.fire("change");
  await ui.say("向前走一步");
  await ui.tick(700);
  assert.deepEqual(ui.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);
});

test("legacy hosts without walkContinueVersion hide the walk-continue toggle and keep single-step behavior unchanged", async t => {
  const legacyUi = await classroomRenderer(t, false, {}, { classroomPulseVersion: 1 });
  assert.equal(legacyUi.document.getElementById("class-walk-continue-setting").hidden, true);
  await legacyUi.say("向前走一步");
  await legacyUi.tick(700);
  assert.deepEqual(legacyUi.classroomRequests.map(r => r.operation), ["beginClassroom", "classroomStep", "endClassroom"]);
});
