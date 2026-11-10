const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");

test("window.aichatDesktop v1 bridge and 34px closed-Shadow-DOM titlebar contracts are preserved", () => {
  const bridgeTs = fs.readFileSync(path.join(appRoot, "src", "bridge.ts"), "utf8");
  const titlebarTs = fs.readFileSync(path.join(appRoot, "src", "titlebar.ts"), "utf8");
  const rustBridge = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "bridge.rs"),
    "utf8"
  );

  for (const src of [bridgeTs, rustBridge]) {
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
    assert.ok(src.includes("aichat.desktop-menu.v1"));
  }
});

test("desktop menu protocol matches aichat-desktop page/host command routing", () => {
  const menuRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "menu.rs"),
    "utf8"
  );
  const libRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "lib.rs"),
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
  assert.ok(libRs.includes('Err(format!("Unsupported menu command: {other}"))'));
});

test("self-update and automatic update flows are preserved for both MCP and Desktop app", () => {
  const runtimeRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "runtime.rs"),
    "utf8"
  );
  const updatesRs = fs.readFileSync(
    path.join(appRoot, "src-tauri", "src", "updates.rs"),
    "utf8"
  );
  const updatesHtml = fs.readFileSync(path.join(appRoot, "updates.html"), "utf8");
  const updatesTs = fs.readFileSync(path.join(appRoot, "src", "updates.ts"), "utf8");

  // MCP runtime self-update checks
  assert.ok(runtimeRs.includes("https://cdn.keepwork.com/keepwork/mcp-stable"));
  assert.ok(runtimeRs.includes("validate_update_manifest"));
  assert.ok(runtimeRs.includes("extract_zip_archive"));
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
    /api\.action\("drag-start", \{ screenX: event\.screenX, screenY: event\.screenY \}\)/
  );
  assert.match(petTs, /state = \{ \.\.\.state, \.\.\.\(snap as PetSnapshot\) \}/);
  assert.match(petTs, /requestAnimationFrame\(step\)/);
  assert.doesNotMatch(petTs, /pointercancel", \(event\) => void release/);
  assert.match(petTs, /if \(pointer\?\.tracking\)/);
  assert.ok(petRs.includes("run_permission_bridge_session"));
  assert.ok(petRs.includes("sanitize_pet_state"));
});
