const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");

test("window.aichatDesktop v1 bridge and shared custom titlebar contracts are preserved", () => {
  const bridgeTs = fs.readFileSync(path.join(appRoot, "src", "bridge.ts"), "utf8");
  const titlebarTs = fs.readFileSync(path.join(appRoot, "src", "titlebar.ts"), "utf8");
  const rustBridge = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "bridge.rs"),
    "utf8"
  );

  for (const src of [bridgeTs, rustBridge]) {
    assert.ok(src.includes("aichat.desktop-menu.v1"));
    assert.match(src, /if \(window !== window\.top\) return/);
    assert.match(src, /Object\.freeze/);
    for (const cap of [
      "files: true",
      "terminal: true",
      "defaultBrainFolder: true",
      "gitSetup: true",
      "floatingPet: true",
      "startupSignIn: true",
    ]) {
      assert.ok(src.includes(cap), `missing capability ${cap}`);
    }
    for (const method of [
      "reportStartupSignIn",
      "publishPetState",
      "petResult",
      "onPetCommand",
      "checkGit",
      "installGit",
      "roots",
      "pickFolder",
      "defaultBrainFolder",
      "revokeFolder",
      "file",
      "terminal",
      "status",
      "checkUpdates",
      "installUpdate",
      "onUpdateStatus",
      "runMenuCommand",
      "onFolderSelected",
    ]) {
      assert.ok(src.includes(method), `missing bridge method ${method}`);
    }
  }

  for (const src of [titlebarTs, rustBridge]) {
    assert.ok(src.includes("keepwork-desktop-titlebar"));
    assert.match(src, /attachShadow\(\{\{?\s*mode:\s*"closed"\s*\}\}?\)/);
    assert.ok(src.includes("height:34px") || src.includes("height: 34px"));
    assert.ok(src.includes("calc(100vh - 34px) !important"));
  }
});

test("desktop menu protocol matches aichat-desktop page/host command routing", () => {
  const menuRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "menu.rs"),
    "utf8"
  );
  const libRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "app", "commands.rs"),
    "utf8"
  );
  const bridgeRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "bridge.rs"),
    "utf8"
  );
  const bridgeTs = fs.readFileSync(path.join(appRoot, "src", "bridge.ts"), "utf8");

  // 页面命令集合（与 apps/aichat-desktop 的 PAGE_COMMANDS 一致）。
  assert.ok(menuRs.includes("pub const PAGE_COMMANDS"));
  for (const id of [
    "new-chat",
    "toggle-sidebar",
    "toggle-files",
    "open-settings",
    "experience-simple",
    "experience-professional",
    "theme-light",
    "theme-dark",
  ]) {
    assert.ok(menuRs.includes(`"${id}"`), `menu.rs missing page command ${id}`);
    assert.ok(bridgeTs.includes(`"${id}"`), `bridge.ts missing page command ${id}`);
  }
  assert.ok(menuRs.includes("pub fn is_allowed_page_command"));
  assert.ok(menuRs.includes("pub fn canonical_host_command"));
  assert.ok(menuRs.includes('"file:open-folder", "open-folder"'));
  assert.ok(menuRs.includes('"view:reload", "reload"'));

  // 菜单载荷：桌面版形状 + 冗余兼容字段。
  assert.ok(menuRs.includes('"menuId": menu_id'));
  assert.ok(menuRs.includes('"menu": {'));
  assert.ok(bridgeRs.includes('"pageCommands": PAGE_COMMANDS'));
  assert.ok(bridgeRs.includes('"hostCommands": HOST_COMMANDS'));

  const openMenu = libRs.slice(
    libRs.indexOf("fn desktop_open_menu"),
    libRs.indexOf("fn desktop_titlebar_action")
  );
  assert.ok(openMenu.includes('payload["anchor"]'));
  assert.ok(openMenu.includes('payload["x"]'));
  assert.ok(openMenu.includes('payload["y"]'));

  const runCommand = libRs.slice(
    libRs.indexOf("async fn desktop_run_menu_command"),
    libRs.indexOf("fn desktop_open_menu")
  );
  assert.ok(runCommand.includes("is_allowed_page_command"));
  assert.ok(runCommand.includes('"type": "command"'));
  assert.ok(runCommand.includes("Unsupported menu command"));

  // 未知 id 不再兜底广播。
  const hostMenu = fs.readFileSync(path.join(appRoot, "src-tauri/src/app/host_menu.rs"), "utf8");
  assert.ok(hostMenu.includes('Err(format!("Unsupported menu command: {other}"))'));
});

test("shell-owned menus return the shared payload while omitted render mode preserves legacy callers", () => {
  const lib = fs.readFileSync(path.join(appRoot, "src-tauri/src/app/commands.rs"), "utf8");
  const openMenu = lib.slice(lib.indexOf("async fn desktop_open_menu"), lib.indexOf("fn desktop_titlebar_action"));
  assert.ok(openMenu.includes("verify_main_sender(&window, &state)?"));
  assert.ok(openMenu.includes("render_mode: Option<String>"));
  assert.ok(openMenu.includes("Unsupported menu render mode"));
  assert.ok(openMenu.includes("Unsupported menu:"));
  assert.ok(openMenu.includes('payload["anchor"]'));
  const shell = openMenu.indexOf('if render_mode.as_deref() == Some("shell")');
  const legacy = openMenu.indexOf('broadcast_to_main(&app, "menu-message", &payload)');
  assert.ok(shell >= 0 && legacy > shell);
  assert.ok(openMenu.slice(shell, legacy).includes("return Ok(payload)"), "shell rendering cannot also broadcast a duplicate popup");
  assert.ok(openMenu.slice(legacy).includes("Ok(json!(true))"), "legacy callers still receive their boolean result");
  const titlebar = fs.readFileSync(path.join(appRoot, "src/titlebar.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(appRoot, "src-tauri/src/bridge.rs"), "utf8");
  const renderer = fs.readFileSync(path.join(appRoot, "src/menuChrome.js"), "utf8");
  assert.ok(titlebar.includes('from "./menuChrome.js"'));
  assert.ok(bridge.includes('include_str!("../../src/menuChrome.js")'));
  assert.ok(titlebar.includes("mountDesktopMenus("));
  assert.ok(bridge.includes("mountDesktopMenus("));
  assert.ok(renderer.includes('renderMode: "shell"'));
  assert.ok(renderer.includes('invoke("desktop_run_menu_command", { id })'));
  assert.ok(!renderer.includes("window.postMessage"), "rows use the host command gateway for exactly-once dispatch");
  const startup = fs.readFileSync(path.join(appRoot, "src-tauri/src/app/startup.rs"), "utf8");
  assert.ok(startup.includes("main_builder.decorations(false)"));
  assert.ok(!startup.includes("main_win.set_menu("), "Windows no longer adds a second OS menu bar");
});

test("self-update and automatic update flows are preserved for both MCP and Desktop app", () => {
  const runtimeRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "runtime.rs"),
    "utf8"
  );
  const manifest = fs.readFileSync(path.join(appRoot, "src-tauri/src/runtime/manifest.rs"), "utf8");
  const archive = fs.readFileSync(path.join(appRoot, "src-tauri/src/runtime/archive.rs"), "utf8");
  const stagedUpdate = fs.readFileSync(path.join(appRoot, "src-tauri/src/runtime/staged_update.rs"), "utf8");
  const updatesRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "updates.rs"),
    "utf8"
  );
  const updatesHtml = fs.readFileSync(path.join(appRoot, "updates.html"), "utf8");
  const updatesTs = fs.readFileSync(path.join(appRoot, "src", "updates.ts"), "utf8");

  // MCP runtime self-update checks
  assert.ok(runtimeRs.includes("https://cdn.keepwork.com/keepwork/mcp-stable"));
  assert.ok(stagedUpdate.includes("validate_update_manifest"));
  assert.ok(manifest.includes("fn validate_update_manifest"));
  assert.ok(stagedUpdate.includes("extract_zip_archive"));
  assert.ok(archive.includes("fn extract_zip_archive"));
  assert.ok(runtimeRs.includes("apply_staged_update"));

  // Desktop self-update checks
  assert.ok(updatesRs.includes("https://cdn.keepwork.com/keepwork/aichat-desktop"));
  assert.ok(updatesRs.includes("latest-client.json"));
  assert.ok(updatesRs.includes("update-metadata.json") || updatesRs.includes("PersistedDesktopUpdateMeta"));
  assert.ok(updatesRs.includes("prepare_desktop_install"));
  assert.ok(updatesRs.includes("launch_desktop_installer"));

  // Updates window UI checks
  assert.ok(updatesHtml.includes("检查更新"));
  assert.ok(updatesHtml.includes("分别更新本地 MCP 服务和桌面应用。"));
  assert.ok(updatesTs.includes("更新 MCP"));
  assert.ok(updatesTs.includes("更新桌面应用"));
});

test("floating pet window preserves click stability, screenshot permission bubble, and exit prompt", () => {
  const petHtml = fs.readFileSync(path.join(appRoot, "pet.html"), "utf8");
  const petCss = fs.readFileSync(path.join(appRoot, "src", "pet.css"), "utf8");
  const petTs = fs.readFileSync(path.join(appRoot, "src", "pet.ts"), "utf8");
  const petRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "pet.rs"),
    "utf8"
  );

  assert.ok(petHtml.includes('id="permission-bubble"'));
  assert.ok(petHtml.includes("允许截取主屏幕？"));
  assert.ok(petHtml.includes('id="exit-bubble"'));
  assert.ok(petHtml.includes("完全退出？"));
  assert.ok(
    petCss.includes(
      "https://cdn.keepwork.com/maisi/magichaqi/pet/dragon_green_20260528090748.webp"
    )
  );
  assert.ok(petTs.includes("permission-choice"));
  assert.ok(petTs.includes("exit-confirm"));
  assert.match(
    petTs,
    /api\.action\("drag-start", \{ screenX: event\.screenX, screenY: event\.screenY(?:, [^}]+)? \}\)/
  );
  assert.match(petTs, /state = \{ \.\.\.state, \.\.\.\(snap as PetSnapshot\) \}/);
  assert.match(petTs, /requestAnimationFrame\(step\)/);
  assert.doesNotMatch(petTs, /pointercancel", \(event\) => void release/);
  assert.match(petTs, /if \(pointer\?\.tracking\)/);
  assert.match(petTs, /releasePointerCapture/);
  const petHost = fs.readFileSync(path.join(appRoot, "src-tauri/src/app/pet_host.rs"), "utf8");
  assert.match(petHost, /\.shadow\(false\)/);
  assert.ok(petRs.includes("run_permission_bridge_session"));
  assert.ok(petRs.includes("sanitize_pet_state"));
});
