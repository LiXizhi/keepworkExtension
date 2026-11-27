const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const filename = path.join(__dirname, "../src/bumi-embodied.ts");
const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const controller = {};
vm.runInNewContext(js, { exports: controller, Date });
const tick = () => new Promise(resolve => setImmediate(resolve));
const task = { mode: "approach", target: "穿粉色上衣的人" };
function view(robot = 0.2, target = 0.6, overrides = {}) {
  return {
    status: "ready", robot: { x: robot, y: 0.5 }, headingPoint: { x: robot + 0.04, y: 0.5 },
    target: { x: target, y: 0.5 }, approach: { x: target - 0.2, y: 0.5 },
    pathClear: true, turnClear: true, rearClear: true, confidence: 0.88, ...overrides,
  };
}
function setup(frames, extra) {
  const actions = [], notes = [], observations = [];
  const runner = controller.createEmbodiedController({
    calibration: () => ({ widthM: 5, heightM: 3, stepM: 0.5, backwardM: 0.5, turnDeg: 90, leftDeg: 90, greetingM: 1 }),
    observe(target) {
      observations.push(target);
      if (!frames.length) return new Promise(() => {});
      return Promise.resolve(frames.shift());
    },
    pulse: async d => { actions.push(d); }, stop: () => actions.push("stop"),
    gesture: async g => { actions.push(g); }, greet: async () => { actions.push("你好呀！"); },
    say: text => notes.push(text), wait: async () => {}, ended: () => actions.push("end"), ...extra,
  });
  return { actions, notes, observations, runner };
}

test("counted-walk speech recognizes explicit direction and bounded counts while ambiguous transcripts stay inert", () => {
  for (const [phrase, direction, count] of [
    ["向前走一步", "forward", 1], ["往后走两步。", "backward", 2], ["前进三步吧", "forward", 3],
    ["向后走散步", "backward", 3], ["往前走１０步", "forward", 10],
    ["向前三步", "forward", 3], ["请让小布米往前迈上三小步", "forward", 3],
    ["机器人，麻烦你朝后面迈出两步吧", "backward", 2], ["请帮我前进 ２ 步", "forward", 2],
    ["后退十步", "backward", 10], ["向后退 2 步", "backward", 2],
  ]) {
    const result = controller.parseCountedWalk(phrase);
    assert.deepEqual({ ...result }, { direction, count }, phrase);
  }
  for (const phrase of ["散步", "三步", "走两步", "往前走零步", "向后走十一步", "向后退００步", "前进100步",
    "机器人向前N步", "往后走几步", "请往前迈上若干小步"]) {
    assert.equal(typeof controller.parseCountedWalk(phrase), "string", phrase);
  }
  for (const phrase of ["不要向后走两步", "可以向前走三步吗？", "向前走三步再向后走一步", "我想散步", "停止"]) {
    assert.equal(controller.parseCountedWalk(phrase), null, phrase);
  }
});

test("AI counted-walk candidates require one affirmative command, an explicit direction and a bounded count", () => {
  for (const [phrase, direction, count] of [
    ["朝前挪动一下总共走三步", "forward", 3], ["往前挪一下，一共三步", "forward", 3],
    ["麻烦你往前面挪动三步吧", "forward", 3],
    ["小布米，朝后挪个２小步", "backward", 2],
  ]) {
    assert.equal(controller.parseCountedWalk(phrase), null, phrase);
    assert.deepEqual({ ...controller.walkIntentCandidate(phrase) }, { direction, count }, phrase);
  }
  for (const phrase of ["不要朝前挪三步", "能朝前挪三步吗？", "假如小布米朝前挪三步", "他说“朝前挪三步”",
    "例如往前走三步", "往前挪三步再走五步", "往前挪三步然后挥手", "先朝前再朝后挪三步",
    "往前挪", "挪三步", "往前挪十一步", "向前挪N步", "往前走三到五步", "向后进三步",
    "向前走三步半", "往前跳三步", "停，往前两步", "向前三步？"]) {
    assert.equal(controller.parseCountedWalk(phrase), null, phrase);
    assert.equal(controller.walkIntentCandidate(phrase), null, phrase);
  }
  assert.equal(controller.parseEmbodiedTask("去向前走三步"), null);
});

test("a motion observation stays usable through 15 seconds from its only capture", () => {
  const capture = 100_000;
  for (const age of [0, 5001, 8271, 15000]) {
    assert.equal(controller.usableMotionFrame(capture, capture + age), true);
  }
  for (const age of [-1, 15001, NaN, Infinity]) {
    assert.equal(controller.usableMotionFrame(capture, capture + age), false);
  }
  assert.equal(controller.usableMotionFrame(NaN, capture), false);
});

test("classroom requests distinguish arrival gestures, following, and questions or unrelated commands", () => {
  const parse = raw => JSON.parse(JSON.stringify(controller.parseEmbodiedTask(raw)));
  assert.deepEqual(parse("走到穿粉色上衣的人旁边，和他握个手"), { ...task, gesture: "handshake" });
  assert.deepEqual(parse("走到穿粉色上衣的人旁边打个招呼"), { ...task, gesture: "wave" });
  assert.deepEqual(parse("跟着穿粉色上衣的人"), { ...task, mode: "follow" });
  for (const text of ["别去讲台", "可以去讲台吗？", "去讲台吗", "握个手", "走到讲台然后跳舞"]) assert.equal(parse(text), null);
});

test("reobserve after each settled pulse, update to target's new position, then wave and greet once", async () => {
  const f = [view(), view(0.3, 0.5), view(0.3, 0.5)];
  let settle;
  const harness = setup(f, { pulse: d => { harness.actions.push(d); return new Promise(resolve => { settle = resolve; }); } });
  harness.runner.start({ ...task, gesture: "wave" });
  await tick();
  assert.deepEqual(harness.actions, ["forward"]);
  assert.equal(harness.observations.length, 1);
  settle();
  await tick();
  assert.deepEqual(harness.actions, ["forward", "stop", "wave", "你好呀！", "end"]);
  assert.equal(harness.observations.length, 3);
  assert.match(harness.notes.at(-1), /实测前进 0.50 米/);
});

test("decide right and left from the robot's chest heading, independently of the camera", async () => {
  for (const [headY, expected] of [[0.58, "left"], [0.42, "right"]]) {
    const scene = view(0.2, 0.6, { headingPoint: { x: 0.2, y: headY } });
    const h = setup([scene, view()]);
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, [expected, "forward"]);
    assert.match(h.notes.at(-1), /90°/);
  }
});

test("do not back up into unobserved space; only a clear rear permits the calibrated adjustment", async () => {
  for (const rearClear of [false, true]) {
    const scene = view(0.4, 0.5, { rearClear });
    const h = setup([scene]);
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, rearClear ? ["backward"] : ["stop", "end"]);
  }
});

test("stop on loss, blocked path, unclear heading, stale frames and missing motion", async () => {
  for (const scene of [view(0.2, 0.6, { status: "lost" }), view(0.2, 0.6, { pathClear: false }),
    view(0.2, 0.6, { headingPoint: { x: 0.2, y: 0.5 } }), view(0.2, 0.6, { capturedAt: 100 })]) {
    const h = setup([scene]);
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, ["stop", "end"]);
  }
  const h = setup([view(), view()]);
  h.runner.start(task);
  await tick();
  assert.deepEqual(h.actions, ["forward", "stop", "end"]);
  assert.match(h.notes.at(-1), /实测|标定/);
});

test("slow recognition, invalid camera times and repeated frame IDs report distinct causes without moving", async t => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const [offset, latency, frameId, reason] of [
    [0, 15500, 2, /视觉识别返回已用 15\.5 秒/],
    [-1, 0, 2, /拍摄时间异常/],
    [1, 0, 2, /拍摄时间异常/],
    [0, 0, 1, /画面序号没有更新/],
  ]) {
    let frames = 0;
    const ui = setup([], { observe() {
      if (++frames === 1) return view(0.4, 0.6, { capturedAt: now, frameId: 1 });
      const capturedAt = now + offset;
      now += latency;
      return view(0.2, 0.6, { capturedAt, frameId });
    } });
    ui.runner.start({ ...task, gesture: "wave" });
    await tick();
    assert.deepEqual(ui.actions, ["stop", "end"]);
    assert.equal(frames, 2);
    assert.match(ui.notes.at(-1), reason);
  }
});

test("ask for disambiguation once, resume observation using the operator's choice", async () => {
  const ambiguous = view(0.2, 0.6, { status: "ambiguous", reason: "两人穿粉色上衣，一位在门口，一位在讲台附近。" });
  const h = setup([ambiguous, view()]);
  h.runner.start(task);
  await tick();
  assert.deepEqual(h.actions, ["stop"]);
  assert.match(h.notes.at(-1), /靠门的那位，还是靠讲台的那位？/);
  assert.equal(h.runner.clarify("靠讲台的那位"), true);
  await tick();
  assert.deepEqual(h.actions, ["stop", "forward"]);
  assert.match(h.observations.at(-1), /穿粉色上衣的人.*靠讲台的那位/);
});

test("follow waits while stationary, jogs after a receding target and waits again after it stops", async () => {
  const h = setup([view(), view(), view(), view(0.2, 0.7), view(0.3, 0.7), view(0.3, 0.7)]);
  h.runner.start({ ...task, mode: "follow" });
  await tick();
  assert.deepEqual(h.actions, ["forward"]);
  assert.equal(h.runner.isActive(), true);
  assert.match(h.notes.at(-1), /等候/);
  h.runner.stop();
  assert.deepEqual(h.actions, ["forward", "stop", "end"]);
});

test("operator stop during capture, pulse, or gesture prevents every later motion and greeting", async () => {
  for (const blocked of ["observe", "pulse", "gesture"]) {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = setup(blocked === "gesture" ? [view(0.4), view(0.4)] : [view(), view()], {
      [blocked]: () => { h.actions.push(blocked); return pending; },
    });
    h.runner.start({ ...task, gesture: "wave" });
    await tick();
    assert.equal(h.actions.at(-1), blocked);
    h.runner.stop();
    const actions = [...h.actions];
    release(view());
    await tick();
    assert.deepEqual(h.actions, actions);
    assert.equal(h.runner.isActive(), false);
  }
});

test("arrival needs two frames at greeting distance; predicted travel cannot extend past the confirmed corridor", async () => {
  const h = setup([view(0.4, 0.6)]);
  h.runner.start({ ...task, gesture: "handshake" });
  await tick();
  assert.deepEqual(h.actions, []);
  assert.match(h.notes.at(-1), /新画面确认/);
  const shortCorridor = view(0.2, 0.7, { approach: { x: 0.25, y: 0.5 } });
  const k = setup([shortCorridor]);
  k.runner.start(task);
  await tick();
  assert.deepEqual(k.actions, ["stop", "end"]);
  assert.match(k.notes.at(-1), /通路不足/);
});

test("follow also notices recession over successive sightings, then waits", async () => {
  for (const sequence of [[0.6, 0.6, 0.67], [0.6, 0.61, 0.62, 0.624, 0.626]]) {
    const finalTarget = sequence.at(-1);
    const h = setup([...sequence.map(x => view(0.2, x)), view(0.3, finalTarget), view(0.3, finalTarget)]);
    h.runner.start({ ...task, mode: "follow" });
    await tick();
    assert.deepEqual(h.actions, ["forward"]);
    assert.match(h.notes.at(-1), /正在等候/);
  }
});

test("reject a target switch before greeting or after a pulse", async () => {
  const jump = view(0.3, 0.93);
  for (const [frames, actions] of [[[view(0.4), jump], []], [[view(), jump], ["forward"]]]) {
    const h = setup(frames);
    h.runner.start({ ...task, gesture: "wave" });
    await tick();
    assert.deepEqual(h.actions, [...actions, "stop", "end"]);
    assert.match(h.notes.at(-1), /同一个目标/);
  }
});

test("same greeting distance on the wrong side of a person does not trigger a handshake", async () => {
  const scene = view(0.4, 0.6, { approach: { x: 0.8, y: 0.5 } });
  const h = setup([scene]);
  h.runner.start({ ...task, gesture: "handshake" });
  await tick();
  assert.deepEqual(h.actions, ["stop", "end"]);
  assert.match(h.notes.at(-1), /过于靠近/);
});

test("stop on sideways slip, reversed translation, or large unexpected yaw during a forward pulse", async () => {
  for (const pose of [
    { robot: { x: 0.3, y: 0.7 }, headingPoint: { x: 0.34, y: 0.7 } },
    { robot: { x: 0.1, y: 0.5 }, headingPoint: { x: 0.14, y: 0.5 } },
    { robot: { x: 0.3, y: 0.5 }, headingPoint: { x: 0.3, y: 0.54 } },
  ]) {
    const after = view(0.3, 0.6, pose);
    const h = setup([view(), after]);
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, ["forward", "stop", "end"]);
    assert.match(h.notes.at(-1), /行进方向或位移/);
  }
});

test("metric navigation can start with missing directional measurements and still uses explicit ones", async () => {
  const base = { widthM: 5, heightM: 3, stepM: 0.5, turnDeg: 90, greetingM: 1 };
  const back = view(0.4, 0.5);
  const left = view(0.2, 0.6, { headingPoint: { x: 0.2, y: 0.58 } });
  for (const [scene, settings, actions, report] of [
    [view(), base, ["forward"], /0.50 米/],
    [view(), { widthM: 5, heightM: 3, greetingM: 1, stepM: 0.5 }, ["forward"], /前进/],
    [back, base, ["backward"], /后退/],
    [left, base, ["left"], /左转/],
    [back, { ...base, backwardM: 0.25 }, ["backward"], /0.25 米/],
    [left, { ...base, leftDeg: 30 }, ["left"], /30°/],
  ]) {
    const h = setup([scene], { calibration: () => settings });
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, actions);
    assert.match(h.notes.at(-1), report);
  }
  const invalid = setup([left], { calibration: () => ({ ...base, leftDeg: NaN }) });
  invalid.runner.start(task);
  await tick();
  assert.equal(invalid.runner.isActive(), false);
  assert.ok(!invalid.actions.includes("left"));
});

test("check measured left rotation and backward travel against their own calibrations", async () => {
  const settings = { widthM: 5, heightM: 3, stepM: 0.5, backwardM: 0.2, turnDeg: 90, leftDeg: 30, greetingM: 1 };
  const left = view(0.2, 0.6, { headingPoint: { x: 0.2, y: 0.58 } });
  for (const [direction, initial, after] of [
    ["left", left, view()], ["backward", view(0.4, 0.5), view(0.25, 0.5)],
  ]) {
    const h = setup([initial, after], { calibration: () => settings });
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, [direction, "stop", "end"]);
    assert.match(h.notes.at(-1), /不符/);
  }
});

test("wait for a confirmed stop before a gesture or asking which target; rejection never claims arrival", async () => {
  for (const ambiguous of [false, true]) {
    let rejectStop;
    const pending = new Promise((_, reject) => { rejectStop = reject; });
    const scene = ambiguous ? view(0.4, 0.6, { status: "ambiguous", reason: "一位靠窗，一位在走廊。" }) : view(0.4);
    const h = setup([scene, scene], { stop: () => { h.actions.push("stop"); return pending; } });
    h.runner.start({ ...task, gesture: "handshake" });
    await tick();
    assert.deepEqual(h.actions, ["stop"]);
    assert.equal(h.runner.clarify("靠窗的"), false);
    assert.doesNotMatch(h.notes.at(-1), /哪一位|确认已停/);
    rejectStop(new Error("BLE stop timeout"));
    await tick();
    assert.equal(h.runner.isActive(), false);
    assert.equal(h.actions.includes("handshake"), false);
    assert.match(h.notes.at(-1), /停步指令未获确认.*BLE stop timeout/);
  }
});

test("a late stop acknowledgement cannot re-enable clarification or run a greeting after cancellation", async () => {
  for (const ambiguous of [false, true]) {
    let resolveStop;
    const pending = new Promise(resolve => { resolveStop = resolve; });
    const scene = ambiguous ? view(0.4, 0.6, { status: "ambiguous" }) : view(0.4);
    const h = setup([scene, scene], { stop: () => pending });
    h.runner.start({ ...task, gesture: "wave" });
    await tick();
    h.runner.stop();
    assert.equal(h.runner.isActive(), false);
    assert.deepEqual(h.actions, ["end"]);
    resolveStop();
    await tick();
    assert.deepEqual(h.actions, ["end"]);
    assert.equal(h.runner.clarify("靠门"), false);
  }
});

function autoView(distanceM, turnDeg, overrides = {}) {
  const approachDistanceM = Math.max(0, distanceM - 0.8);
  return {
    status: "ready",
    robot: { x: 0.3, y: 0.7 },
    headingPoint: { x: 0.35, y: 0.68 },
    target: { x: 0.6, y: 0.4 },
    approach: { x: 0.5, y: 0.48 },
    distanceM,
    approachDistanceM,
    turnDeg,
    atGreeting: Math.abs(distanceM - 0.8) <= 0.12 && approachDistanceM <= 0.12,
    pathClear: true,
    turnClear: true,
    rearClear: true,
    confidence: 0.9,
    ...overrides,
  };
}

test("dominant main vision turns to search and accepts a step when the robot body stays out of frame", async () => {
  const lost = {
    status: "lost", searchView: "dominant", turnClear: true, pathClear: false, rearClear: false, confidence: 0.9,
    reason: "不在主视觉内",
  };
  const searching = setup([lost, lost, lost, lost, lost], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  searching.runner.start(task);
  await tick();
  assert.deepEqual(searching.actions.filter(action => action === "right"), ["right", "right", "right", "right"]);
  assert.ok(searching.actions.includes("stop"));
  assert.match(searching.notes.join("\n"), /主导视角已转身寻找/);

  const passive = setup([{ status: "lost", pathClear: false, rearClear: false, turnClear: true, confidence: 0, reason: "未找到目标" }]);
  passive.runner.start(task);
  await tick();
  assert.equal(passive.actions.includes("right"), false);
  assert.ok(passive.actions.includes("stop"));

  const ego = (range, turn, x, y) => autoView(range, turn, { searchView: "dominant", target: { x, y } });
  const moving = setup([
    ego(2.0, 35, 0.72, 0.40), ego(2.0, 7, 0.50, 0.40), ego(1.73, 6, 0.50, 0.50),
  ], {
    calibration: () => ({ auto: true, greetingM: 0.8 }),
  });
  moving.runner.start(task);
  await tick();
  assert.deepEqual(moving.actions, ["right", "forward", "forward"]);
  assert.ok(moving.notes.some(note => /画面估算右转约 28°/.test(note)));
  assert.match(moving.notes.at(-1), /画面估算前进约 0\.27 米/);
  moving.runner.stop();

  assert.throws(() => controller.verifyDominantGroundShift("forward",
    { robot: { x: 0.4, y: 0.7 }, headingPoint: { x: 0.4, y: 0.5 } },
    { robot: { x: 0.4, y: 0.7 }, headingPoint: { x: 0.4, y: 0.5 } }), /地面参照/);
  assert.doesNotThrow(() => controller.verifyDominantGroundShift("forward",
    { robot: { x: 0.4, y: 0.7 }, headingPoint: { x: 0.4, y: 0.5 } },
    { robot: { x: 0.41, y: 0.82 }, headingPoint: { x: 0.41, y: 0.6 } }));
});

test("an ordinary approach finishes on the first valid arrival observation", async () => {
  const manual = setup([view(0.4)]);
  const auto = setup([autoView(0.8, 0)], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  for (const h of [manual, auto]) {
    h.runner.start(task);
    await tick();
    assert.equal(h.observations.length, 1);
    assert.deepEqual(h.actions, ["stop", "end"]);
    assert.match(h.notes.at(-1), /确认已停在/);
  }
});

test("without floor calibration, measured pulses are checked against new frames before waving and greeting", async () => {
  const turn1 = autoView(1.0, 30);
  const aligned = autoView(1.0, 4, { headingPoint: { x: 0.36, y: 0.65 } });
  const arrived = autoView(0.82, 2, {
    robot: { x: 0.38, y: 0.62 },
    headingPoint: { x: 0.43, y: 0.58 },
    approachDistanceM: 0.02,
    atGreeting: true,
  });
  const h = setup([turn1, aligned, arrived, arrived], {
    calibration: () => ({ auto: true, greetingM: 0.8, turnDeg: 24, stepM: 0.17 }),
  });
  h.runner.start({ ...task, gesture: "wave" });
  await tick();
  assert.deepEqual(h.actions, ["right", "forward", "stop", "wave", "你好呀！", "end"]);
  assert.ok(h.notes.some(n => /右前方/.test(n)));
  assert.ok(h.notes.some(n => /画面估算右转约 26°/.test(n)));
  assert.match(h.notes.at(-1), /画面估算前进约 0\.18 米.*画面确认已停在穿粉色上衣的人旁/);
});

test("auto follow waits after a turn if the person stopped, and moves once when the person walks away again", async () => {
  const still = autoView(1.2, 5);
  const far = autoView(1.8, 28, { target: { x: 0.72, y: 0.32 } });
  const turned = autoView(1.8, 3, { target: { x: 0.72, y: 0.32 }, headingPoint: { x: 0.37, y: 0.65 } });
  const farther = autoView(2.15, 3, { target: { x: 0.8, y: 0.27 }, headingPoint: turned.headingPoint });
  const caught = autoView(1.95, 2, {
    robot: { x: 0.42, y: 0.56 },
    headingPoint: { x: 0.48, y: 0.51 },
    target: farther.target,
  });
  const frames = [still, far, turned];
  let wake;
  const h = setup(frames, {
    calibration: () => ({ auto: true, greetingM: 0.8, stepM: 0.2, turnDeg: 24 }),
    wait: ms => ms === 1200 ? new Promise(resolve => { wake = resolve; }) : Promise.resolve(),
  });
  h.runner.start({ ...task, mode: "follow" });
  await tick();
  assert.deepEqual(h.actions, []);
  wake();
  await tick();
  assert.deepEqual(h.actions, ["right"]);
  assert.match(h.notes.at(-1), /正在等候/);
  frames.push(farther, caught);
  wake();
  await tick();
  assert.deepEqual(h.actions, ["right", "forward"]);
  assert.equal(h.runner.isActive(), true);
  assert.match(h.notes.at(-1), /正在等候/);
  h.runner.stop();
  assert.deepEqual(h.actions, ["right", "forward", "stop", "end"]);
});

test("auto navigation learns each pulse from consecutive camera frames with all four measurements blank", async () => {
  const move = dx => ({
    robot: { x: 0.3 + dx, y: 0.7 }, headingPoint: { x: 0.35 + dx, y: 0.68 },
  });
  for (const [direction, field, before, after, measured] of [
    ["forward", "stepM", autoView(2.4, 0), autoView(2.12, 0, move(0.08)), 0.28],
    ["backward", "backwardM", autoView(0.3, 0), autoView(0.51, 0, move(-0.06)), 0.21],
    ["right", "turnDeg", autoView(2.4, 80), autoView(2.4, 49, { headingPoint: { x: 0.35, y: 0.71 } }), 31],
    ["left", "leftDeg", autoView(2.4, -82), autoView(2.4, -57, { headingPoint: { x: 0.33, y: 0.67 } }), 25],
  ]) {
    const frames = [before, after];
    const snapshots = [];
    const h = setup([], {
      calibration: () => ({ auto: true, greetingM: 0.8 }),
      observe(_target, calibration) {
        snapshots.push({ ...calibration });
        return frames.length ? Promise.resolve(frames.shift()) : new Promise(() => {});
      },
    });
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, [direction, direction], h.notes.join("\n"));
    assert.equal(snapshots.length, 3);
    assert.ok(Math.abs(snapshots[2][field] - measured) < 1e-6, `${field} ${snapshots[2][field]}`);
    for (const other of ["stepM", "backwardM", "turnDeg", "leftDeg"].filter(key => key !== field)) {
      assert.equal(snapshots[2][other], undefined);
    }
  }
  const arrived = autoView(0.8, 1);
  const h = setup([arrived, arrived], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  h.runner.start({ ...task, gesture: "handshake" });
  await tick();
  assert.deepEqual(h.actions, ["stop", "handshake", "end"]);
});

test("auto mode stops when motion stalls twice, rear clearance is missing, or relative estimates are absent", async () => {
  const stalled = autoView(2.0, 0);
  const h1 = setup([stalled, stalled, stalled, stalled], {
    calibration: () => ({ auto: true, greetingM: 0.8 }),
  });
  h1.runner.start(task);
  await tick();
  assert.deepEqual(h1.actions, ["forward", "forward", "stop", "end"]);
  assert.ok(h1.notes.some(note => /点动可能没有发出，重试一次/.test(note)));
  assert.match(h1.notes.at(-1), /未检测到有效移动/);

  const tooClose = autoView(0.4, 0, { rearClear: false, atGreeting: false });
  const h2 = setup([tooClose, tooClose], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  h2.runner.start(task);
  await tick();
  assert.deepEqual(h2.actions, ["stop", "end"]);
  assert.match(h2.notes.at(-1), /身后/);

  const incomplete = { ...autoView(1.2, 0), turnDeg: undefined };
  const h3 = setup([incomplete, incomplete], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  h3.runner.start(task);
  await tick();
  assert.deepEqual(h3.actions, ["stop", "end"]);
  assert.match(h3.notes.at(-1), /距离和偏转角度/);
});

test("uncalibrated first pulses still require enough visible room to move or turn", async () => {
  for (const scene of [
    autoView(1.1, 0, { approachDistanceM: 0.25 }),
    autoView(2.0, -60, { turnClear: false }),
    autoView(2.0, 0, { pathClear: false }),
  ]) {
    const h = setup([scene], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, ["stop", "end"]);
  }
});

test("auto navigation stops when the frame after a pulse is lost, reversed or contradicts the order", async () => {
  const lost = { status: "lost", searchView: "dominant", turnClear: true, confidence: 0.9 };
  const forward = autoView(2.2, 0);
  const left = autoView(2.2, -70);
  const backwardPose = { robot: { x: 0.21, y: 0.7 }, headingPoint: { x: 0.26, y: 0.68 } };
  for (const [direction, before, after] of [
    ["forward", forward, lost],
    ["forward", forward, autoView(2.4, 0, backwardPose)],
    ["left", left, autoView(2.2, -100, { headingPoint: { x: 0.35, y: 0.71 } })],
    ["left", left, left],
    ["left", left, autoView(2.2, -42)],
    ["left", { ...left, searchView: "dominant" }, autoView(2.2, -42, { searchView: "dominant" })],
  ]) {
    const h = setup([before, after], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
    h.runner.start(task);
    await tick();
    assert.deepEqual(h.actions, [direction, "stop", "end"], h.notes.join("\n"));
    assert.equal(h.observations.length, 2);
  }
});

test("an unmeasurable probe keeps the class walking on the conservative reserve instead of aborting", async () => {
  const start = autoView(2.2, 0);
  // The person shifts while the robot steps, so neither frame can attribute the
  // pulse to robot travel alone.
  const shifted = autoView(1.9, 0, {
    robot: { x: 0.38, y: 0.7 }, headingPoint: { x: 0.43, y: 0.68 }, target: { x: 0.69, y: 0.4 },
  });
  const shiftedAgain = autoView(1.62, 0, {
    robot: { x: 0.46, y: 0.7 }, headingPoint: { x: 0.51, y: 0.68 }, target: { x: 0.78, y: 0.4 },
  });
  const h = setup([start, shifted, shiftedAgain], { calibration: () => ({ auto: true, greetingM: 0.8 }) });
  h.runner.start(task);
  await tick();
  assert.deepEqual(h.actions, ["forward", "forward", "forward"]);
  assert.equal(h.runner.isActive(), true);
  assert.ok(h.notes.some(note => /步幅还没估出来，下一次点动后再核算/.test(note)), h.notes.join("\n"));
  assert.ok(h.notes.some(note => /连续 2 次点动都估不出步幅，改为按保守幅度/.test(note)), h.notes.join("\n"));
  assert.ok(h.notes.some(note => /幅度按保守值估算/.test(note)), h.notes.join("\n"));
  h.runner.stop();
  assert.deepEqual(h.actions, ["forward", "forward", "forward", "stop", "end"]);
});

test("spoken clarification follows a confirmed stop; cancellation during speech discards the question", async () => {
  let acknowledge, finishQuestion;
  const states = [];
  const ambiguous = view(0.2, 0.6, { status: "ambiguous", reason: "一位靠门，一位靠讲台" });
  const h = setup([ambiguous], {
    stop: () => new Promise(resolve => { acknowledge = resolve; }),
    ask: doorAndLectern => {
      assert.equal(doorAndLectern, true);
      h.actions.push("question");
      return new Promise(resolve => { finishQuestion = resolve; });
    },
    state: status => states.push(status),
  });
  h.runner.start(task);
  await tick();
  assert.deepEqual(h.actions, []);
  acknowledge();
  await tick();
  assert.deepEqual(h.actions, ["question"]);
  h.runner.stop();
  acknowledge();
  finishQuestion();
  await tick();
  assert.deepEqual(states, ["running", "stopped"]);
  assert.equal(h.runner.clarify("靠门的"), false);
});

test("a receding person cannot conceal a stalled robot turn", async () => {
  const before = autoView(1.8, 40);
  const after = autoView(2.1, 38, { target: { x: 0.7, y: 0.32 } });
  const h = setup([before, after], {
    calibration: () => ({ auto: true, greetingM: 0.8, turnDeg: 20 }),
  });
  h.runner.start(task);
  await tick();
  assert.deepEqual(h.actions, ["right", "stop", "end"]);
  assert.match(h.notes.at(-1), /无法确认机器人按指令转向/);
});
