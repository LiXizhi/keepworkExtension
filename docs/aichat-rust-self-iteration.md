# Self-Iteration Protocol: Converging `apps/aichat-rust` Toward `apps/aichat-desktop`

To continuously evolve the Rust + Tauri 2 desktop client ([`apps/aichat-rust`](../apps/aichat-rust/README.md)) toward 100% feature parity, interaction fidelity, and edge-case resilience with the Electron reference ([`apps/aichat-desktop`](../apps/aichat-desktop/README.md)), the three Agents (**产品 Agent** / **程序员 Agent** / **测试 Agent**) execute this structured **Self-Iteration Loop**.

## 1. Reference Mapping (`apps/aichat-desktop` → `apps/aichat-rust` 对齐矩阵)

- **Window, Title Bar, Menu & Local Dev Server (`main.ts` / `preload.cjs` / `dev-server.cjs` → `src/main.ts` / `src-tauri/src/lib.rs`)**:
  - 34px Closed Shadow DOM `#keepwork-desktop-titlebar` with K icon, Windows/Linux inline menus (`File` / `Edit` / `View` / `Help`), macOS native app menu (`Keepwork`), centered title, address pill (`localhost:<port>` or `keepwork.com/chat`), refresh icon, and live CSS skin/theme color sync (`aichat.desktop-menu.v1`).
  - Local AIChat source server (`AICHAT_DESKTOP_LOCAL_SOURCE=1` / 「使用本地源码服务器…」 starting from port 3001, `AICHAT_DESKTOP_DEV_URL`, `deployment.json` fallback) and no-cache reload on MCP restart.
- **Bridge v1 & Native Workspace (`preload.cjs` / `files.cjs` / `brainFolder.cjs` → `src/main.ts` / `src-tauri/src/files.rs` / `brain_folder.rs` / `terminal.rs`)**:
  - Frozen `window.aichatDesktop` (`aichat-desktop:v1`) exposed only to the validated top-level main frame (`version`, `capabilities`, `roots`, `pickFolder`, `revokeFolder`, `file`, `terminal`, `status`, `checkUpdates`, `installUpdate`, `onUpdateStatus`, `onFolderSelected`, `previewBrainFolder`, `initializeBrainFolder`).
  - Opaque root IDs persisted in `folder-grants.json`, symlink/junction loop-safe lexical traversal, file size caps (PPT/PPTX 500 MiB, PDF 100 MiB, general 1024 MiB), `<Documents>/MyBrain` initialization, and user-operated PTY sessions (`desktop:<id>` with cursor replay, resize, interrupt).
- **Floating Pet & System Tray Lifecycle (`petWindow.cjs` / `trayChannels.cjs` / `loginStartup.cjs` → `pet.html` / `src/pet.ts` / `src-tauri/src/pet.rs` / `tray.rs`)**:
  - Single-instance lock (`desktopLock.cjs`); closing the main window hides it and shows the transparent always-on-top pet while keeping renderer, drafts, terminals, and calls alive.
  - Fixed work-area canvas (`DESKTOP-PET-CLICK-STABILITY-001`), 460 ms jelly/composer animation (respecting `prefers-reduced-motion`), right-click menu (`0.5×`–`4×` scale, dragon/AIChat pet appearance, MagicHaqi link, Open AIChat, Hide, and `"完全退出…"` confirmation bubble `#exit-bubble` with persona/channel impact preview), plus screenshot permission bubble (`#permission-bubble` bound to `~/.keepwork-mcp/pet-permission-bridge.json`, hiding before capture).
  - System tray sign-in health indicator (amber exclamation on missing/expired session or 30s timeout), 60s polling of DingTalk / Feishu / WeChat channel status, and login startup toggle.
- **Three Independent Update Streams & Dual Runtime Supervision (`runtime.cjs` / `updateWindow.cjs` → `updates.html` / `src/updates.ts` / `src-tauri/src/runtime.rs` / `updater.rs`)**:
  - Dual daemon supervision for `keepwork-mcp-node-runtime` (`127.0.0.1:8089`) and `keepwork-local-model-node-runtime` (`127.0.0.1:18089`), 60s heartbeat, PID-verified takeover of older `runtimeVersion` instances while respecting VS Code / Local Helper ownership.
  - Independent MCP runtime staged/hot updates (`mcp-stable/<target>.json` with size, SHA-256, 40-char commit, `runtime.json`, health promotion, and automatic rollback) and desktop shell self-updates (`latest-client.json`, `update-metadata.json` with offline `stale: true` preservation, and dedicated `updates.html` window).
- **Persistent Media & Clipboard Consent (`permissions.cjs` / `gitSetup.cjs` → `src-tauri/src/permissions.rs` / `git_setup.rs`)**:
  - Origin-scoped microphone, camera, and clipboard-write consent (`media-grants.json`) remembered across reloads/restarts (separate grants for local source vs. published origin, concurrent prompt coalescing, focus restoration before clipboard write, and zero subframe/clipboard-read leakage), plus Git environment detection/setup helpers.

## 2. Self-Iteration Prompt Template (自我迭代提示词模板)

When the user triggers **自我迭代 (Self-Iteration)** or asks to keep closing the gap with `aichat-desktop`, execute the following loop:

```markdown
【自我迭代指令：推进 apps/aichat-rust 持续逼近 apps/aichat-desktop】
1. [产品 Agent — 逐模块对标与差距切片 (Gap Analysis)]
   - 对比原版 `apps/aichat-desktop`（`src/main.ts`、`src/preload.cjs`、`src/runtime.cjs`、`src/petWindow.cjs`、`src/permissions.cjs`、`src/trayChannels.cjs`、`src/updateWindow.cjs`、`src/gitSetup.cjs`、`launcher/` 及 `README.md` / `VALIDATION.md`）与当前 `apps/aichat-rust`（`src/*`、`src-tauri/src/*`）。
   - 识别当前尚未完全对齐的交互细节、IPC 契约字段、边缘异常恢复、权限记忆或系统托盘/桌面宠物行为，拆解出本轮最高优先级的【可交付功能切片（Single Iteration Slice）】及明确验收标准。
2. [程序员 Agent — 最小闭环实现与同步升版 (Implementation & Version Bump)]
   - 在 `apps/aichat-rust` 中实现该功能切片，保持与 Web 端 `window.aichatDesktop`（Bridge v1）及 `aichat.desktop-menu.v1` 100% 兼容，严格遵守安全边界（顶层 Frame/Origin 校验、不透明 Root ID、路径防穿越、外部 MCP 进程保护）。
   - 完成修改后，同步递增 `apps/aichat-rust` 的版本号（同步更新 `apps/aichat-rust/package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 `src-tauri/tauri.conf.json`）。
3. [测试 Agent — 契约验证、冒烟测试与迭代复盘 (Verification & Next Backlog)]
   - 补充或更新 `apps/aichat-rust/tests/*.test.cjs`、`apps/aichat-rust/scripts/smoke.cjs` 及 Rust 单元测试（`cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins`），运行 `pnpm --prefix apps/aichat-rust check` 确保全部通过。
   - 输出本轮自我迭代总结：
     1) 本轮对齐的 `aichat-desktop` 能力点与修改文件；
     2) 实际执行的测试命令、通过状态与更新后的版本号；
     3) 剩余与 `aichat-desktop` 的差距清单及下一轮自我迭代的推荐切片。
```
