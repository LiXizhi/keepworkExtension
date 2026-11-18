const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/petNarration.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function playback() {
  const spoken = [], ended = [], timers = new Map();
  let nextTimer = 0;
  const voice = {localService: true, lang: "zh-CN"};
  const speech = {
    getVoices: () => [{localService: false, lang: "zh-CN"}, voice],
    speak(u) { spoken.push(u); },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    cancel() { this.cancelled = true; },
  };
  const window = {
    speechSynthesis: speech,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout(f) { timers.set(++nextTimer, f); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const api = vm.runInNewContext(javascript + "\nexports", { exports: {}, window });
  return { api, window, speech, voice, spoken, ended, timers,
    start: text => api.startPetNarration(text, result => ended.push(result)) };
}

test("legacy reply narration extracts prose and visible link labels", () => {
  const { api } = playback();
  const input = [
    "## 看看 **这张图**。 ![camera](https://example.org/image.png)",
    "[说明](https://example.org) 和 <audio src='data:audio/wav;base64,123'>秘密</audio>。",
    "```json", '{"tool":"read"}', "```", "最后一句。",
  ].join("\n");
  assert.equal(api.petSpokenText(input).replace(/\s+/g, ""), "看看这张图。说明和。最后一句。");
  assert.equal(api.petSpokenText('The answer.\n{"tool":"noop"}'), "The answer.");
  for (const value of ['[{"type":"image"}]', "![pic][asset]\n[asset]: https://example.org/a",
    "<video>字幕</video>", "<think>reasoning</think><tool_call>file list</tool_call>", "```\nunterminated", "<img src='icon.png'>"]) {
    assert.equal(api.petSpokenText(value), "");
  }
});

test("long replies use the matching local voice, preserve all text, and finish once", () => {
  const p = playback();
  const text = "这是一个很长的答案。".repeat(80);
  const narration = p.start(text);
  assert.ok(narration);
  const first = p.spoken[0];
  assert.equal(first.voice, p.voice);
  narration.pause();
  assert.equal(p.speech.paused, true);
  assert.equal(p.timers.size, 0);
  narration.resume();
  for (const part of p.spoken) {
    assert.ok(Array.from(part.text).length <= 180);
    part.onstart();
    part.onend();
  }
  assert.equal(p.spoken.map(part => part.text).join(""), text);
  assert.deepEqual(p.ended, [true]);
  assert.equal(p.timers.size, 0);
});

test("silent fallback handles missing or stalled engines, and cancel releases a paused voice", () => {
  const p = playback();
  p.window.speechSynthesis = undefined;
  assert.equal(p.start("hello"), null);
  p.window.speechSynthesis = p.speech;
  p.start("hello");
  [...p.timers.values()][0]();
  assert.deepEqual(p.ended, [false]);
  const next = p.start("next");
  const late = p.spoken.at(-1).onend;
  next.pause();
  next.cancel();
  late();
  assert.equal(p.speech.paused, false);
  assert.deepEqual(p.ended, [false]);
});
