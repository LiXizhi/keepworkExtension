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
    "voice-run", "classroom-stop", "vision-inspect-classroom", "remote-toggle", "remote-diagnose",
  ]) {
    const token = 'id="' + id + '"';
    assert.ok(panel.includes(token), id);
    assert.equal(html.split(token).length - 1, 1, id);
  }
  assert.match(panel, /<label\s+for="voice-command">/);
  assert.match(panel, /<canvas[^>]+id="vision-snapshot-canvas"[^>]+role="img"/);
  assert.match(html, /<div\s+id="classroom-home">\s*<section\s+id="classroom-panel"/);
  assert.match(html, /<dialog\b[^>]*id="remote-shield"[\s\S]*?id="classroom-shield"[\s\S]*?<\/dialog>/);
});

test("the shipped control page has no grid editor, grid controls or duplicate recognition field", () => {
  assert.doesNotMatch(html, /\bid="(?:nav-[^"]+|vision-(?:engine|locate-now|auto-replan|auto-confirm|inspect-target|target-name|find-target|confirm-target|sync-goal))"/);
  assert.doesNotMatch(html, /5\s*[×x]\s*5|10\s*[×x]\s*10|执行本段|确认到位|讲台在[A-J]\d/);
});
