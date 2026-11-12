const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8")
);
const tauriWinConf = JSON.parse(
  fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.windows.conf.json"), "utf8")
);
const cargoToml = fs.readFileSync(
  path.join(appRoot, "src-tauri", "Cargo.toml"),
  "utf8"
);
const cargoLock = fs.readFileSync(
  path.join(appRoot, "src-tauri", "Cargo.lock"),
  "utf8"
);
const capabilityConf = JSON.parse(
  fs.readFileSync(
    path.join(appRoot, "src-tauri", "capabilities", "default.json"),
    "utf8"
  )
);

test("does not depend on Electron and uses Tauri 2 + Rust architecture", () => {
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  assert.equal("electron" in allDeps, false, "must not depend on electron");
  assert.equal(
    "electron-builder" in allDeps,
    false,
    "must not depend on electron-builder"
  );
  assert.equal(
    "electron-updater" in allDeps,
    false,
    "must not depend on electron-updater"
  );
  assert.ok("@tauri-apps/api" in allDeps, "must include @tauri-apps/api");
  assert.ok("@tauri-apps/cli" in allDeps, "must include @tauri-apps/cli");
  assert.equal(tauriConf.app.withGlobalTauri, false, "must not expose global __TAURI__");
  assert.deepEqual(
    tauriConf.app.windows,
    [],
    "tauri.conf.json windows must be empty because setup() creates 'main' with initialization_script"
  );
  assert.equal(
    tauriConf.app.macOSPrivateApi,
    true,
    "macOSPrivateApi must be enabled for transparent floating pet window"
  );
  assert.match(cargoToml, /macos-private-api/);
});

test("versions across package.json, Cargo.toml, Cargo.lock, and tauri.conf.json are synchronized", () => {
  assert.equal(pkg.version, tauriConf.version);
  assert.match(cargoToml, new RegExp(`version = "${pkg.version}"`));
  assert.ok(
    cargoLock.replace(/\r\n/g, "\n").includes(`name = "aichat-rust"\nversion = "${pkg.version}"`),
    "Cargo.lock must match the app version"
  );
  assert.equal(tauriConf.identifier, "com.keepwork.aichat-desktop");
  assert.equal(tauriConf.productName, "Keepwork");
  assert.equal(tauriWinConf.productName, "Keepwork");
});

test("main window navigation accepts same-origin tool iframes", () => {
  const lib = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "lib.rs"),
    "utf8"
  );
  const security = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "security.rs"),
    "utf8"
  );
  assert.match(lib, /\.on_navigation\(/);
  assert.match(
    lib,
    /allowed_navigation\(url_str/,
    "on_navigation must use allowed_navigation so /api/raw tool iframes stay in-app"
  );
  assert.match(security, /pub fn allowed_navigation\(/);
  assert.match(security, /fn is_keepwork_cdn\(/);
  assert.match(security, /cdn\.keepwork\.com/);
  assert.match(
    security,
    /SENSITIVE_QUERY_KEYS/,
    "external links carrying a token must never open in the system browser"
  );
});

test("iframe navigation cannot clear pet voice readiness or close workspace terminals", () => {
  const lib = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "lib.rs"),
    "utf8"
  );
  const navigation = lib.match(/\.on_navigation\(move\s+\|[^|]*\|\s*\{([\s\S]*?)\n\s*\}\)/)?.[1];
  assert.ok(navigation, "main window must retain its navigation policy");
  assert.doesNotMatch(
    navigation,
    /reset_state\s*\(|close_all\s*\(/,
    "the navigation policy also receives iframe URLs and must preserve the owning page's state"
  );

  const pageLoad = lib.match(/\.on_page_load\(move\s+\|[^|]*\|\s*\{([\s\S]*?)\n\s*\}\)/)?.[1];
  assert.ok(pageLoad, "main document loads must own lifecycle cleanup");
  assert.match(pageLoad, /if\s+handle_main_page_load\s*\(/);
  assert.match(pageLoad, /\.event\s*\(\s*\)/);
  assert.match(
    pageLoad,
    /broadcast_pet_state\s*\(/,
    "pets must receive the unavailable state after a main document load clears its owner"
  );
});

test("main window opens login providers as in-app popups and external links in browser", () => {
  const lib = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "lib.rs"),
    "utf8"
  );
  const security = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "security.rs"),
    "utf8"
  );
  assert.match(lib, /\.on_new_window\(/);
  assert.match(lib, /allowed_in_app_popup\(url/);
  assert.match(lib, /NewWindowResponse::Deny/);
  assert.match(security, /pub fn allowed_in_app_popup\(/);
  assert.match(security, /fn is_login_iframe\(/);
});

test("MCP runtime bootstraps from bundle or launcher and follows published feed names", () => {
  const lib = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "lib.rs"),
    "utf8"
  );
  const runtime = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "runtime.rs"),
    "utf8"
  );
  assert.match(runtime, /pub fn mcp_feed_platform\(/);
  assert.match(lib, /mcp_feed_platform\(\)/);
  assert.match(lib, /resolve_bundled_mcp_dir/);
  assert.match(lib, /launcher_mcp_runtime/);
  assert.match(
    lib,
    /ensure_started\(true\)/,
    "start MCP before the webview's first health probe"
  );
});

test("packaging scripts target macOS universal and Windows x64 + ARM64", () => {
  for (const [script, target] of [
    ["make:mac", "universal-apple-darwin"],
    ["make:win:x64", "x86_64-pc-windows-msvc"],
    ["make:win:arm64", "aarch64-pc-windows-msvc"],
  ]) {
    assert.match(pkg.scripts[script], /bundle-mcp-rust\.cjs/, `${script} must package apps/mcp-rust`);
    assert.ok(pkg.scripts[script].includes(`--target ${target}`), `${script} must stage its matching Rust target`);
    assert.doesNotMatch(pkg.scripts[script], /bundle-mcp-runtime\.cjs/, `${script} cannot silently package Node`);
  }
  assert.match(
    pkg.scripts["make:mac"],
    /--target universal-apple-darwin/,
    "macOS packaging must build universal-apple-darwin single package"
  );
  assert.match(
    pkg.scripts["make:win:x64"],
    /--target x86_64-pc-windows-msvc --bundles nsis/,
    "Windows x64 packaging must target x86_64-pc-windows-msvc NSIS"
  );
  assert.match(
    pkg.scripts["make:win:arm64"],
    /--target aarch64-pc-windows-msvc --bundles nsis/,
    "Windows ARM64 packaging must target aarch64-pc-windows-msvc NSIS"
  );
  assert.deepEqual(tauriWinConf.bundle.targets, ["nsis"]);
});

test("default runtime commands choose Rust and preserve explicit Node compatibility entry points", () => {
  assert.match(pkg.scripts["bundle:mcp"], /bundle-mcp-rust\.cjs/);
  assert.match(pkg.scripts["bundle:mcp-node"], /bundle-mcp-runtime\.cjs/);
  assert.match(pkg.scripts["dev:node"], /tauri\.cjs --mcp-node dev/);
  assert.match(pkg.scripts["dev:rust"], /tauri\.cjs --mcp-rust dev/);
  assert.match(pkg.scripts.tauri, /tauri\.cjs/);

  const taskSource = fs.readFileSync(path.join(appRoot, "..", "..", ".vscode", "tasks.json"), "utf8");
  const task = taskSource.match(/\{\s*"label":\s*"keepwork Rust Desktop: Start"[\s\S]*?"runOptions"/)?.[0];
  assert.ok(task, "VS Code must retain the Rust desktop start task");
  assert.match(task, /"command":\s*"pnpm"/);
  assert.match(task, /"args":\s*\["tauri",\s*"dev"\]/);
  assert.doesNotMatch(task, /--mcp-node|"AICHAT_MCP_ENGINE":\s*"node"/);
  assert.match(task, /apps\/mcp-rust/);
});

test("frontend checks never stage a Node runtime as an implicit fallback", () => {
  const buildSource = fs.readFileSync(path.join(appRoot, "scripts", "build.mjs"), "utf8");
  assert.doesNotMatch(buildSource, /require\(["']\.\/bundle-mcp-runtime\.cjs["']\)\.bundle/);
  assert.doesNotMatch(buildSource, /bundle-mcp-runtime\.cjs/);
});

test("macOS Info.plist and entitlements include microphone permission for voice/call", () => {
  const infoPlist = fs.readFileSync(
    path.join(appRoot, "src-tauri", "Info.plist"),
    "utf8"
  );
  const entitlements = fs.readFileSync(
    path.join(appRoot, "src-tauri", "entitlements.mac.plist"),
    "utf8"
  );
  assert.match(infoPlist, /NSMicrophoneUsageDescription/);
  assert.match(infoPlist, /<string>Keepwork<\/string>/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
});

test("capabilities restrict remote IPC to keepwork.com/chat and loopback dev servers", () => {
  assert.deepEqual(capabilityConf.windows, ["main", "pet", "updates"]);
  const urls = capabilityConf.remote.urls;
  assert.ok(urls.includes("https://keepwork.com/chat"));
  assert.ok(urls.some((u) => u.startsWith("http://127.0.0.1:")));
  assert.equal(
    urls.some((u) => u === "*" || u === "https://*"),
    false,
    "must not allow wildcard remote origins"
  );
});
