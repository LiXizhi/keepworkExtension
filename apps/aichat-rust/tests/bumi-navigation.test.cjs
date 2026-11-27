const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../bumi-control.html"), "utf8");

test("the classroom workspace contains the preview, shared command field, inspection, execution and stop", () => {
  const panel = html.match(/<section\b[^>]*id="classroom-panel"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(panel);
  for (const id of [
    "vision-video", "vision-overlay", "vision-snapshot", "vision-toggle", "voice-command",
    "voice-run", "classroom-stop", "vision-inspect-classroom",
  ]) {
    const token = 'id="' + id + '"';
    assert.ok(panel.includes(token), id);
    assert.equal(html.split(token).length - 1, 1, id);
  }
  assert.match(panel, /<label\s+for="voice-command">/);
  assert.match(panel, /<canvas[^>]+id="vision-snapshot-canvas"[^>]+role="img"/);
  assert.doesNotMatch(panel, /\bid="remote-(?:toggle|diagnose)"/);
  assert.match(html, /<dialog\b[^>]*id="remote-shield"[\s\S]*?id="classroom-shield"[\s\S]*?<\/dialog>/);
});

test("section navigation reaches each control group and offers one stop without changing the window URL", () => {
  const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav);
  assert.deepEqual(Array.from(nav.matchAll(/<button\b[^>]*\bdata-bumi-target="([^"]+)"/g), m => m[1]),
    ["manual-controls", "classroom-home", "robot-actions", "device-tools"]);
  assert.doesNotMatch(nav, /\bhref="#/);
  assert.match(html, /<\/nav>\s*<button\b[^>]*\bid="stop-move"/);
  for (const id of ["manual-controls", "classroom-home", "robot-actions", "device-tools", "stop-move"]) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1, id);
  }
});

test("the shipped control page has no grid editor, grid controls or duplicate recognition field", () => {
  assert.doesNotMatch(html, /\bid="(?:nav-[^"]+|vision-(?:engine|locate-now|auto-replan|auto-confirm|inspect-target|target-name|find-target|confirm-target|sync-goal))"/);
  assert.doesNotMatch(html, /5\s*[×x]\s*5|10\s*[×x]\s*10|执行本段|确认到位|讲台在[A-J]\d/);
});
