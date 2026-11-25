const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("Bumi IPC is limited to its bundled local control window", () => {
  const capability = JSON.parse(read("src-tauri/capabilities/bumi-control.json"));
  assert.deepEqual(capability.windows, ["bumi-control"]);
  assert.equal(capability.local, true);
  assert.equal(Object.hasOwn(capability, "remote"), false);
  assert.deepEqual(capability.permissions.toSorted(), [
    "allow-bumi-control", "core:event:allow-listen", "core:event:allow-unlisten",
  ]);

  const permissions = read("src-tauri/permissions/desktop-commands.toml").split("[[permission]]");
  const own = permissions.find(part => part.includes('identifier = "allow-bumi-control"'));
  const main = permissions.find(part => part.includes('identifier = "allow-desktop-commands"'));
  assert.ok(own && main);
  for (const command of ["bumi_control", "bumi_remote_input"]) {
    assert.ok(own.includes(`"${command}"`));
    assert.equal(main.includes(`"${command}"`), false);
    assert.equal((read("src/bridge.ts") + read("src-tauri/src/bridge.rs")).includes(command), false);
  }

  const host = read("src-tauri/src/app/bumi.rs");
  assert.match(host, /fn trusted_page\(label: &str, url: &Url\)/);
  assert.ok(host.includes("trusted_page(window.label(), &url)"));
  assert.match(host, /NewWindowResponse::Deny/);
});

test("Bumi control is available from every desktop menu and packaged as a local page", () => {
  const menu = read("src-tauri/src/menu.rs");
  const hostMenu = read("src-tauri/src/app/host_menu.rs");
  assert.ok(menu.includes('"bumi-control",'));
  assert.ok(menu.includes('{ "id": "bumi-control", "label": "Bumi 机器人…" }'));
  assert.ok(hostMenu.includes('"bumi-control" => super::bumi::open(app).await?'));
  assert.ok(hostMenu.includes('MenuItem::with_id(app, "bumi-control"'));
  assert.ok(read("src/bridge.ts").includes('"bumi-control"'));
  assert.ok(read("src/menuChrome.js").includes('"bumi-control": "Bumi Robot…"'));
  assert.ok(read("vite.config.ts").includes('"bumi-control.html"'));

  const bluetooth = read("src-tauri/src/app/bumi/bluetooth.rs");
  assert.ok(bluetooth.includes('name.contains("bumi") || name.starts_with("ntxb")'));
  assert.ok(bluetooth.includes("const SCAN_WINDOW_SECONDS: u64 = 20;"));
  assert.ok(bluetooth.includes("sleep(Duration::from_secs(SCAN_WINDOW_SECONDS))"));
  const html = read("bumi-control.html");
  const renderer = read("src/bumi-control.ts");
  assert.match(html, /NTXB/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /src="\/src\/bumi-control\.ts"/);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)="https?:\/\//);
  for (const action of ["dance", "wave", "handshake", "cheer"]) {
    assert.ok(html.includes(`data-command="${action}" disabled`));
  }
  assert.ok(html.includes('data-command="standUp" disabled'));
  assert.ok(html.includes('data-command="standToFall" disabled'));
  assert.match(html, /一键收纳/);
  assert.match(renderer, /action === "standToFall" && !window\.confirm/);
  assert.match(html, /3m × 3m/);
  assert.match(renderer, /action === "standUp" && !window\.confirm/);
  for (const direction of ["forward", "backward", "left", "right"]) {
    assert.ok(html.includes(`data-move="${direction}"`));
  }
  assert.ok(html.includes('id="stop-move"'));
  assert.ok(html.includes('id="walk-mode"'));
  assert.ok(html.includes('id="run-mode"'));
  assert.ok(html.includes('id="motion-stick"'));
  assert.ok(html.includes('id="direction-pad"'));
  assert.match(html, /id="device-choice"[^>]*\bhidden\b/);
  assert.match(html, /id="connect"/);
  assert.match(html, /src="\/src\/assets\/bumi-robot\.png"/);
  assert.ok(fs.existsSync(path.join(root, "src/assets/bumi-robot.png")));
  assert.match(html, /id="voice-command"/);
  assert.match(html, /mi-remote-voice/);
  assert.match(html, /20 秒/);
  assert.doesNotMatch(html, /id="scan"/);
  assert.match(renderer, /请等待约 20 秒/);
  assert.ok(html.includes('id="speech-text"'));
  assert.match(html, /<section\b[^>]*aria-labelledby="speech-title"[^>]*\bhidden\b/);
  assert.ok(html.includes('id="listen-toggle"'));
  assert.ok(html.includes('id="message-log"'));
  assert.ok(html.includes('id="clear-messages"'));
  assert.match(renderer, /messages\.length > 200/);
  assert.doesNotMatch(renderer, /localStorage|writeFile|innerHTML/);
  assert.match(bluetooth, /Request::Listen \{ enabled \}/);
  assert.match(bluetooth, /app\.emit_to\(super::LABEL, "bumi:message"/);
  assert.match(bluetooth, /size\.min\(1024\)/);
  assert.match(renderer, /"pointerup", "pointercancel", "lostpointercapture"/);
  assert.match(renderer, /window\.addEventListener\("blur"/);
  assert.match(renderer, /window\.addEventListener\("pagehide"/);
  assert.match(renderer, /action: "move", vx: 0, vyaw: 0/);
  for (const query of ["battery", "status"]) {
    assert.ok(html.includes(`data-query="${query}" disabled`));
  }
});

test("Bumi window follows the desktop theme and disconnects with its owner", () => {
  const host = read("src-tauri/src/app/bumi.rs");
  assert.match(host, /\.theme\(Some\(theme\.native\(\)\)\)/);
  assert.match(host, /\.background_color\(theme\.background\(\)\)/);
  assert.match(host, /\.initialization_script\(&theme\.document_theme_script\(\)\)/);
  assert.match(host, /WindowEvent::Destroyed/);
  assert.match(read("src-tauri/src/app/commands.rs"), /\["remote-voice", "updates", "bumi-control"\]/);
  const css = read("src/bumi-control.css");
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;/);
});
