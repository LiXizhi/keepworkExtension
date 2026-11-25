const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function transpile(relative) {
  return ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const visionJs = transpile("src/bumi-vision.ts");
const embodied = {};
vm.runInNewContext(transpile("src/bumi-embodied.ts"), { exports: embodied });

function loadVision(globals = {}) {
  const exports = {};
  vm.runInNewContext(visionJs, { exports, require(name) { assert.equal(name, "./bumi-embodied"); return embodied; }, ...globals });
  return exports;
}

class MockElement extends EventTarget {
  children = [];
  dataset = {};
  style = {};
  value = "";
  checked = false;
  width = 320;
  height = 240;
  readyState = 4;
  videoWidth = 320;
  videoHeight = 240;
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  fire(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields)); }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
  play() { return Promise.resolve(); }
}

function createIntegratedHarness({ storage = new Map(), timers } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new MockElement());
    return elements.get(id);
  };
  const mockCtx = {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {},
    fill() {},
    fillRect() {},
    fillText() {},
    drawImage() {},
    getImageData(_x, _y, width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {},
  };
  // Keep only the annotations currently painted on the preview. The JPEG
  // canvases used to query the model use a separate context.
  const overlayPaint = { labels: [], circles: [] };
  const overlayCtx = {
    ...mockCtx,
    clearRect() { overlayPaint.labels.length = overlayPaint.circles.length = 0; },
    arc(x, y) { overlayPaint.circles.push([x, y]); },
    fillText(label) { overlayPaint.labels.push(label); },
  };
  el("vision-overlay").getContext = () => overlayCtx;
  const snapshotPaint = { images: [], labels: [], circles: [], scales: [] };
  const snapshotCtx = {
    ...mockCtx, save() {}, restore() {}, translate() {},
    scale(x, y) { snapshotPaint.scales.push([x, y]); },
    drawImage(...args) {
      snapshotPaint.images.push(args);
      snapshotPaint.labels.length = snapshotPaint.circles.length = 0;
    },
    arc(x, y) { snapshotPaint.circles.push([x, y]); },
    fillText(label) { snapshotPaint.labels.push(label); },
  };
  el("vision-snapshot-canvas").getContext = () => snapshotCtx;
  el("vision-snapshot").hidden = true;
  const decoding = [];
  class Image {
    constructor() { decoding.push(this); }
    finish(width, height) { this.naturalWidth = width; this.naturalHeight = height; this.onload(); }
  }

  const document = Object.assign(new MockElement(), {
    hidden: false,
    hasFocus: () => true,
    getElementById: el,
    createElement: tag => {
      const node = new MockElement();
      if (tag === "canvas") {
        node.getContext = () => mockCtx;
        node.toDataURL = () => "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      }
      return node;
    },
  });
  const window = Object.assign(new MockElement(), {
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 2; }, clearInterval() {},
    ...timers,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });

  const stoppedTracks = [];
  const navigator = {
    mediaDevices: {
      async enumerateDevices() {
        return [{ kind: "videoinput", deviceId: "mac-facetime", label: "FaceTime HD Camera" }];
      },
      async getUserMedia() {
        return {
          getTracks() {
            return [{
              stop() { stoppedTracks.push("stopped"); },
            }];
          },
        };
      },
    },
  };

  const inspectCalls = [];
  const { createBumiVision } = loadVision({ document, window, navigator, Date, Image });
  const camera = createBumiVision({
    inspectionTarget: () => "讲台",
    canInspectClassroom: () => true,
    async inspectClassroom(_camera, target) { inspectCalls.push(target); return "已识别"; },
  });

  return {
    el,
    camera,
    window,
    document,
    overlayPaint,
    snapshotPaint,
    decoding,
    inspectCalls,
    mediaDevices: navigator.mediaDevices,
    stoppedTracks,
  };
}

test("old camera calibration preserves the physical floor corners and mirror preference without selecting an obsolete grid engine", () => {
  const key = "keepwork.bumi.vision-calibration.v1";
  const calibration = {
    engine: "color",
    futureOption: { preset: "school" },
    mirror: true,
    quad: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.9, y: 0.8 }, { x: 0.05, y: 0.9 }],
  };
  const legacy = {
    vlmPreset: "custom",
    vlmEndpoint: "https://old.example.invalid/v1/chat/completions",
    vlmModel: "old-vision",
    apiKey: "unused-fixture-key",
  };
  const storage = new Map([[key, JSON.stringify({ ...calibration, ...legacy })]]);
  const vision = loadVision({ window: { localStorage: {
    getItem: name => storage.get(name),
    setItem: (name, value) => storage.set(name, value),
  } } });
  const config = vision.loadVisionConfig();
  assert.equal(Object.hasOwn(config, "engine"), false);
  assert.equal(config.mirror, calibration.mirror);
  assert.deepEqual(Array.from(config.quad, corner => ({ ...corner })), calibration.quad);
  for (const field of Object.keys(legacy)) assert.equal(Object.hasOwn(config, field), false, field);
  vision.saveVisionConfig(config);
  const saved = JSON.parse(storage.get(key));
  assert.deepEqual(saved.quad, calibration.quad);
  assert.equal(saved.mirror, calibration.mirror);
  assert.equal(saved.engine, "color");
  assert.deepEqual(saved.futureOption, calibration.futureOption);
  for (const field of Object.keys(legacy)) assert.equal(Object.hasOwn(saved, field), false, field);
});

test("classroom confidence persists valid edits across restarts and keeps invalid edits out of saved calibration", () => {
  const key = "keepwork.bumi.vision-calibration.v1";
  const storage = new Map([[key, JSON.stringify({ mirror: true, minSceneConfidence: "invalid" })]]);
  const ui = createIntegratedHarness({ storage });
  const field = ui.el("class-confidence-threshold");
  assert.equal(field.value, "0.75");
  field.value = "0.63";
  field.fire("change");
  assert.equal(ui.camera.readConfidenceThreshold(), 0.63);
  assert.equal(JSON.parse(storage.get(key)).mirror, true);
  for (const invalid of ["", "0", "0.001", "1.01", "NaN"]) {
    field.value = invalid;
    field.fire("change");
    assert.throws(() => ui.camera.readConfidenceThreshold(), /置信度阈值/);
  }
  assert.equal(createIntegratedHarness({ storage }).camera.readConfidenceThreshold(), 0.63);
});

test("an older classroom host allows restoring a saved custom threshold while a busy task locks the field", () => {
  const ui = createIntegratedHarness();
  const field = ui.el("class-confidence-threshold");
  const setting = ui.el("class-confidence-setting");
  ui.camera.syncConfidenceField(false, false);
  assert.equal(setting.hidden, true);
  ui.camera.syncConfidenceField(true, true);
  assert.equal(setting.hidden, false);
  assert.equal(field.disabled, true);
  ui.camera.syncConfidenceField(true, false);
  assert.equal(field.disabled, false);
  field.value = "0.63";
  field.fire("change");
  ui.camera.syncConfidenceField(false, false);
  assert.equal(setting.hidden, false);
  assert.equal(ui.el("class-confidence-legacy").hidden, false);
  field.value = "0.75";
  field.fire("change");
  ui.camera.syncConfidenceField(false, false);
  assert.equal(setting.hidden, true);
});

test("a late camera permission grant after hiding the window releases its tracks and keeps the preview closed", async () => {
  const ui = createIntegratedHarness();
  let grant;
  let requests = 0;
  ui.mediaDevices.getUserMedia = () => {
    requests++;
    return new Promise(resolve => { grant = resolve; });
  };
  const toggle = ui.el("vision-toggle");
  toggle.fire("click");
  toggle.fire("click");
  assert.equal(requests, 1);
  assert.equal(toggle.disabled, true);
  assert.equal(ui.el("vision-stage").hidden, true);
  ui.document.hidden = true;
  ui.document.fire("visibilitychange");
  let stopped = false;
  grant({ getTracks: () => [{ stop() { stopped = true; } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(toggle.disabled, false);
  assert.equal(ui.el("vision-stage").hidden, true);
  assert.equal(ui.inspectCalls.length, 0);
  ui.document.hidden = false;
  ui.document.fire("visibilitychange");
  assert.match(ui.el("vision-status").textContent, /窗口隐藏时关闭.*开启摄像头/);
  assert.equal(requests, 1);
});

const settleVision = () => new Promise(resolve => setImmediate(resolve));

test("the default camera reports the device actually opened, using only the matching camera label", async () => {
  for (const [trackLabel, deviceId, expected] of [
    ["USB 教室摄像头", "external", "正在使用「USB 教室摄像头」。"],
    ["", "mac-facetime", "正在使用「FaceTime HD Camera」。"],
    ["", "unknown-camera", "摄像头已开启。"],
  ]) {
    const ui = createIntegratedHarness();
    const track = Object.assign(new EventTarget(), { label: trackLabel, getSettings: () => ({ deviceId }), stop() {} });
    ui.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
    ui.el("vision-toggle").fire("click");
    await settleVision();
    assert.equal(ui.el("vision-status").textContent, expected);
    ui.camera.stop();
  }
});

for (const calibrated of [false, true]) {
  for (const mirror of [false, true]) {
    test(`classroom preview places both feet markers on the video: calibrated=${calibrated}, mirror=${mirror}`, async () => {
      const corners = [[0.3, 0.2], [0.7, 0.2], [0.9, 0.8], [0.1, 0.8]];
      const calibration = {
        mirror, quad: (mirror ? [1, 0, 3, 2] : [0, 1, 2, 3]).map(i => ({ x: corners[i][0], y: corners[i][1] })),
        ...(calibrated && { calibratedCamera: { deviceId: "fixture", width: 320, height: 240 } }),
      };
      const storage = new Map([["keepwork.bumi.vision-calibration.v1", JSON.stringify(calibration)]]);
      const ui = createIntegratedHarness({ storage });
      const track = Object.assign(new EventTarget(), { stop() {}, getSettings: () => ({ deviceId: "fixture" }) });
      ui.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
      ui.el("vision-toggle").fire("click");
      await settleVision();
      const camera = ui.camera.acquireClassroomCamera(assert.fail);
      assert.equal(camera.calibrated, calibrated);
      const scene = {
        status: "ready", confidence: 0.92, robot: { x: 0.25, y: 0 }, target: { x: 0.875, y: 1 },
        approach: { x: 0.64, y: 0.6 }, headingPoint: { x: 0.29, y: 0.12 },
        pathClear: true, turnClear: true, rearClear: true, frameId: 1, capturedAt: Date.now(),
      };
      const jpeg = "data:image/jpeg;base64,c2FtZS1leHBvc3VyZQ==";
      camera.showObservation("蓝色书包", scene, jpeg);
      const normalized = calibrated ? [[0.4, 0.2], [0.8, 0.8]] : [[0.25, 0], [0.875, 1]];
      const canvas = ui.el("vision-overlay");
      for (const [x, y] of normalized) {
        const px = (mirror ? 1 - x : x) * canvas.width, py = y * canvas.height;
        assert.ok(ui.overlayPaint.circles.some(([cx, cy]) => Math.hypot(cx - px, cy - py) < 1),
          `expected a marker at ${px}, ${py}; got ${JSON.stringify(ui.overlayPaint.circles)}`);
      }
      for (const label of ["小布米", "目标：蓝色书包", "停靠点"]) assert.ok(ui.overlayPaint.labels.includes(label));
      camera.release();
      assert.ok(!ui.overlayPaint.labels.includes("目标：蓝色书包"));
      const [image] = ui.decoding;
      assert.equal(image.src, jpeg);
      image.finish(calibrated ? 1024 : 320, calibrated ? 512 : 240);
      assert.equal(ui.el("vision-snapshot").hidden, false, "a finished camera task leaves its annotated exposure visible");
      assert.equal(ui.el("vision-snapshot-time").textContent, new Date(scene.capturedAt).toLocaleTimeString("zh-CN", { hour12: false }));
      const [frame] = ui.snapshotPaint.images;
      assert.equal(frame[0], image, "archiving the submitted camera JPEG must not sample the live video again");
      assert.deepEqual(frame.slice(1, 5), calibrated ? [0, 64, 512, 384] : [0, 0, 320, 240]);
      assert.deepEqual(ui.snapshotPaint.scales, mirror ? [[-1, 1]] : []);
      const sheet = ui.el("vision-snapshot-canvas");
      for (const [x, y] of normalized) {
        const px = (mirror ? 1 - x : x) * sheet.width, py = y * sheet.height;
        assert.ok(ui.snapshotPaint.circles.some(([cx, cy]) => Math.hypot(cx - px, cy - py) < 1));
      }
      for (const label of ["小布米", "目标：蓝色书包", "停靠点"]) assert.ok(ui.snapshotPaint.labels.includes(label));
      ui.camera.stop();
    });
  }
}

test("late JPEG decoding cannot replace a newer recognition or restore an invalidated snapshot", async () => {
  const ui = createIntegratedHarness();
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const camera = ui.camera.acquireClassroomCamera(assert.fail);
  const scene = { status: "ready", confidence: 0.95, capturedAt: Date.now(), pathClear: true,
    robot: { x: 0.2, y: 0.3 }, target: { x: 0.6, y: 0.3 }, headingPoint: { x: 0.3, y: 0.3 } };
  const submit = name => {
    camera.showObservation(name, scene, "data:image/jpeg;base64," + Buffer.from(name).toString("base64"));
    return ui.decoding.at(-1);
  };
  const first = submit("椅子"), second = submit("蓝色书包");
  second.finish(320, 240);
  first.finish(320, 240);
  assert.deepEqual(ui.snapshotPaint.images.map(([source]) => source), [second]);
  assert.ok(ui.snapshotPaint.labels.includes("目标：蓝色书包"));
  const third = submit("垃圾桶");
  camera.showObservation("垃圾桶", { ...scene, status: "lost" });
  third.finish(320, 240);
  assert.equal(ui.el("vision-snapshot").hidden, true);
  const last = submit("讲台");
  camera.clearObservation(true);
  camera.release();
  last.finish(320, 240);
  assert.equal(ui.el("vision-snapshot").hidden, true);
  assert.equal(ui.snapshotPaint.images.length, 1);
  ui.camera.stop();
});

test("both read-only and navigation results label the original exposure after 8.271 seconds without marking the live preview", async () => {
  const ui = createIntegratedHarness();
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const camera = ui.camera.acquireClassroomCamera(assert.fail);
  const sample = { capturedAt: Date.now() - 8271, robot: { x: 0.3, y: 0.7 }, target: { x: 0.8, y: 0.6 } };
  const jpeg = "data:image/jpeg;base64,b2xkLWZyYW1l";
  camera.showInspection("书包", sample, jpeg);
  ui.decoding.at(-1).finish(320, 240);
  assert.equal(ui.el("vision-snapshot").hidden, false);
  assert.deepEqual(new Set(ui.snapshotPaint.labels), new Set(["小布米", "目标：书包"]));
  assert.equal(ui.el("vision-snapshot-time").textContent, new Date(sample.capturedAt).toLocaleTimeString("zh-CN", { hour12: false }));
  assert.ok(!ui.overlayPaint.labels.includes("目标：书包"));
  camera.showObservation("书包", { ...sample, headingPoint: { x: 0.3, y: 0.55 }, status: "ready", confidence: 0.95, pathClear: true }, jpeg);
  const raw = ui.decoding.at(-1);
  assert.equal(raw.src, jpeg);
  raw.finish(320, 240);
  assert.equal(ui.el("vision-snapshot-label").textContent, "最近识别画面");
  assert.deepEqual(new Set(ui.snapshotPaint.labels), new Set(["小布米", "目标：书包"]));
  assert.equal(ui.el("vision-snapshot-time").textContent, new Date(sample.capturedAt).toLocaleTimeString("zh-CN", { hour12: false }));
  assert.ok(!ui.overlayPaint.labels.includes("目标：书包"));
  camera.release();
  ui.camera.stop();
});

test("a failed classroom result shows the complete model input with its exposure time and no inferred points", async () => {
  const config = { mirror: true, quad: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
    calibratedCamera: { deviceId: "fixture", width: 320, height: 240 } };
  const storage = new Map([["keepwork.bumi.vision-calibration.v1", JSON.stringify(config)]]);
  const ui = createIntegratedHarness({ storage });
  const track = Object.assign(new EventTarget(), { stop() {}, getSettings: () => ({ deviceId: "fixture" }) });
  ui.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const camera = ui.camera.acquireClassroomCamera(assert.fail);
  assert.ok(camera.calibrated);
  const jpeg = "data:image/jpeg;base64,bW9kZWwtaW5wdXQ=";
  const capturedAt = Date.now() - 9740;
  camera.showObservation("书包", { capturedAt, status: "uncertain", confidence: 0.1, robot: { x: 0.6, y: 0.4 } }, jpeg);
  const image = ui.decoding.at(-1);
  camera.release();
  image.finish(1024, 512);
  assert.equal(image.src, jpeg);
  assert.deepEqual(ui.snapshotPaint.images[0].slice(1, 5), [0, 0, 1024, 512]);
  assert.deepEqual(ui.snapshotPaint.scales, []);
  assert.deepEqual(ui.snapshotPaint.labels, []);
  assert.deepEqual(ui.overlayPaint.labels, []);
  assert.equal(ui.el("vision-snapshot-label").textContent, "本次识别原图");
  assert.equal(ui.el("vision-snapshot-time").textContent, new Date(capturedAt).toLocaleTimeString("zh-CN", { hour12: false }));
  ui.camera.stop();
});

test("decoding a diagnostic exposure cannot restore it after blur, camera closure, new ownership or revocation", async () => {
  const ui = createIntegratedHarness();
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const jpeg = "data:image/jpeg;base64,c291cmNl";
  const capture = () => {
    const camera = ui.camera.acquireClassroomCamera(() => {});
    camera.showInputFrame(jpeg, Date.now());
    camera.release();
    return ui.decoding.at(-1);
  };
  const first = capture();
  ui.window.fire("blur");
  first.finish(320, 240);
  const second = capture();
  const third = capture();
  second.finish(320, 240);
  ui.camera.resetTracking();
  third.finish(320, 240);
  const last = capture();
  ui.document.hidden = true;
  ui.document.fire("visibilitychange");
  last.finish(320, 240);
  assert.equal(ui.el("vision-snapshot").hidden, true);
  assert.deepEqual(ui.snapshotPaint.images, []);
});

test("unreliable, expired, lost and cancelled observations remove the classroom markers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1700000000000 });
  const ui = createIntegratedHarness({ timers: { setTimeout, clearTimeout, setInterval, clearInterval } });
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const camera = ui.camera.acquireClassroomCamera(() => {});
  const ready = (overrides = {}) => ({ status: "ready", confidence: 0.95, capturedAt: Date.now(),
    robot: { x: 0.2, y: 0.4 }, target: { x: 0.8, y: 0.4 }, approach: { x: 0.6, y: 0.4 },
    headingPoint: { x: 0.25, y: 0.4 }, pathClear: true, turnClear: true, rearClear: true, ...overrides });
  const hasMarker = () => ui.overlayPaint.labels.includes("目标：椅子");
  camera.showObservation("椅子", ready({ confidence: 0.63 }), undefined, 0.63);
  assert.equal(hasMarker(), true);
  camera.showObservation("椅子", ready({ confidence: 0.63 }), undefined, 0.64);
  assert.equal(hasMarker(), false);
  camera.showObservation("椅子", ready({ pathClear: false }), undefined, 0.01);
  assert.equal(hasMarker(), false);
  for (const bad of [{ status: "lost" }, { status: "ambiguous" }, { confidence: 0.2 }, { target: { x: 2, y: 0.3 } },
    { capturedAt: Date.now() - 5100 }, { capturedAt: Date.now() + 31000 }]) {
    camera.showObservation("椅子", ready());
    assert.equal(hasMarker(), true);
    camera.showObservation("椅子", ready(bad));
    assert.equal(hasMarker(), false);
  }
  camera.showObservation("椅子", ready());
  t.mock.timers.tick(5500);
  assert.equal(hasMarker(), false, "a stalled next model request cannot leave an old marker on live video");
  camera.showObservation("椅子", ready());
  camera.release();
  camera.showObservation("椅子", ready());
  assert.equal(hasMarker(), false, "the previous camera lease cannot restore the marker");
  ui.camera.stop();
});

test("classroom shots support zero-config auto mode and camera-bound calibrated mode with fresh frames and exclusive access", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  const ui = createIntegratedHarness({ timers: { setTimeout, clearTimeout, setInterval, clearInterval } });
  const video = ui.el("vision-video");
  let decoded = 1;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: decoded });
  const track = Object.assign(new EventTarget(), { stop() {}, getSettings: () => ({ deviceId: "fixed-camera" }) });
  ui.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const invalidations = [];
  const acquire = () => ui.camera.acquireClassroomCamera(reason => invalidations.push(reason));
  const autoCamera = acquire();
  assert.equal(autoCamera.calibrated, false);
  const autoShot = autoCamera.captureFreshFrame();
  decoded++;
  t.mock.timers.tick(40);
  assert.match(await autoShot, /^data:image\/jpeg;base64,/);
  autoCamera.release();
  ui.el("vision-calibrate").fire("click");
  assert.throws(acquire, /标定/);
  for (const [clientX, clientY] of [[10, 10], [310, 10], [310, 230], [10, 230]]) {
    ui.el("vision-overlay").fire("click", { clientX, clientY });
  }
  await settleVision();
  const camera = acquire();
  assert.equal(camera.calibrated, true);
  assert.throws(acquire, /正在执行/);
  const first = camera.captureFreshFrame();
  await assert.rejects(camera.captureFreshFrame(), /截图尚未完成/);
  decoded++;
  t.mock.timers.tick(40);
  assert.match(await first, /^data:image\/jpeg;base64,/);
  const frozen = camera.captureFreshFrame();
  video.currentTime = 5;
  t.mock.timers.tick(2050);
  await assert.rejects(frozen, /新帧/);
  assert.deepEqual(ui.inspectCalls, [], "capturing a fresh exposure never starts a second model request");
  const cancelled = camera.captureFreshFrame();
  track.dispatchEvent(new Event("mute"));
  await assert.rejects(cancelled, /取消/);
  assert.equal(camera.isCurrent(), false);
  assert.equal(invalidations.length, 1);
  camera.release();
  ui.camera.stop();
  track.getSettings = () => ({ deviceId: "other-camera" });
  ui.el("vision-toggle").fire("click");
  await settleVision();
  const other = acquire();
  assert.equal(other.calibrated, false, "switching cameras must not reuse another camera's quad");
  other.release();
  ui.camera.stop();
});

test("auto classroom frame preserves aspect ratio without manual corner calibration", () => {
  const vision = loadVision();
  let drawn;
  const ctx = { drawImage(_v, x, y, w, h) { drawn = [x, y, w, h]; } };
  const canvas = { getContext: () => ctx, toDataURL: () => "data:image/jpeg;base64,YQ==" };
  const jpeg = vision.composeAutoClassroomFrame({ videoWidth: 1280, videoHeight: 720 }, canvas);
  assert.equal(jpeg, "data:image/jpeg;base64,YQ==");
  assert.deepEqual([canvas.width, canvas.height], [768, 432]);
  assert.deepEqual(drawn, [0, 0, 768, 432]);
});

test("the rectified classroom floor preserves physical left/right with a mirrored calibration preview", () => {
  const vision = loadVision();
  const corners = [{ x: 0.8, y: 0.2 }, { x: 0.2, y: 0.2 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  let projected;
  const overlayLines = [];
  const ctx = {
    fillRect() {}, drawImage() {}, beginPath() {}, stroke() {},
    moveTo(x, y) { overlayLines.push([x, y]); }, lineTo(x, y) { overlayLines.push([x, y]); },
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        data[(y * w + x) * 4] = x * 255 / (w - 1);
        data[(y * w + x) * 4 + 1] = y * 255 / (h - 1);
      }
      return { data };
    },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(output, x, y) { assert.deepEqual([x, y], [512, 0]); projected = output.data; },
  };
  const canvas = { getContext: () => ctx, toDataURL: () => "data:image/jpeg;base64,YQ==" };
  vision.composeClassroomFrame({ videoWidth: 640, videoHeight: 480 }, canvas, corners);
  assert.deepEqual([canvas.width, canvas.height], [1024, 512]);
  const point = (x, y) => [...projected.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 2)];
  assert.deepEqual(point(0, 0), [51, 51]);
  assert.deepEqual(point(511, 0), [204, 51]);
  assert.deepEqual(point(511, 511), [255, 255]);
  assert.ok(overlayLines.every(([x]) => x <= 512), "the rectified model input must have no grid lines over the classroom floor");
});

test("crossed calibration corners keep the last valid floor mapping", async () => {
  const storage = new Map();
  const ui = createIntegratedHarness({ storage });
  ui.el("vision-toggle").fire("click");
  await settleVision();
  ui.el("vision-calibrate").fire("click");
  for (const [clientX, clientY] of [[10, 10], [280, 10], [10, 220], [280, 220]]) {
    ui.el("vision-overlay").fire("click", { clientX, clientY });
  }
  assert.match(ui.el("vision-status").textContent, /恢复上次标定/);
  assert.equal(storage.has("keepwork.bumi.vision-calibration.v1"), false);
  ui.camera.stop();
});
