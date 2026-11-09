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

test("versions across package.json, Cargo.toml, and tauri.conf.json are synchronized", () => {
  assert.equal(pkg.version, tauriConf.version);
  assert.match(cargoToml, new RegExp(`version = "${pkg.version}"`));
  assert.equal(tauriConf.identifier, "com.keepwork.aichat-desktop");
  assert.equal(tauriConf.productName, "Keepwork");
  assert.equal(tauriWinConf.productName, "KeepWork 第二大脑");
});

test("packaging scripts target macOS universal and Windows x64 + ARM64", () => {
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
