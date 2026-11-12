# AGENTS.md — Keepwork Extension (`keepwork-mcp`)

Instructions for AI agents working **in this repository**. Product overview:
[README.md](README.md).

## What this repo is

- **VS Code / Cursor extension** (`keepwork`) plus a **singleton local MCP daemon**
- **KP Local Helper** (`apps/local-helper`) packages the same daemon plus the separate `apps/local-model-runtime` process as one per-user Windows installer
- **Path**: `c:/lxzsrc/keepworkExtension` (GitHub `LiXizhi/keepworkExtension`)
- **Job**: (1) clone Keepwork git repos and open files on keepwork.com;
  (2) expose `run_terminal` / `grep_files` / `mcp_status` / `web_search` / `fetch_url` so the **AIChat website**
  (`https://keepwork.com/chat`) can drive the user's local disk — something the
  browser cannot do on its own.

The HTTP MCP listener is **not** inside the extension host. It is a detached
`node apps/vscode-extension/dist/cli.js` process on **`http://127.0.0.1:8089`**. Many VS Code windows
spawn-or-attach; many AIChat tabs share one daemon (one MCP session each).

`run_terminal` prefers the VS Code **Keepwork** integrated terminal when the
extension is active (loopback bridge in `~/.keepwork-mcp/terminal-bridge.json`).
The MCP HTTP server stays in the daemon. Closing a window must **not** kill the
daemon; it may drop the terminal bridge (next command falls back to spawn).

## Agent Roles & Collaboration (`产品 Agent` / `程序员 Agent` / `测试 Agent`)

Agents in this repository operate in a **parallel collaboration mode**: each role owns its distinct domain, artifacts, and verification scope, and agents invoke or hand off to one another on demand when tasks cross boundaries.

| Role | Core Responsibilities | Owned Scope & Artifacts | Handoff / Collaboration Triggers |
| --- | --- | --- | --- |
| **产品 Agent (Product Agent)** | - Requirement analysis, feature scoping, UX/UI interaction flows, and acceptance criteria<br>- Cross-version client/server capability contract design (AIChat ↔ Keepwork MCP)<br>- Product documentation, API catalog definitions, and skill guides | - `README.md`, `docs/*`, `apps/*/docs/*`<br>- API catalog & user-facing descriptions (`src/mcp/apiDocs.ts`, `skills/*/SKILL.md`)<br>- Version compatibility & capability negotiation specs | - Invokes **程序员 Agent** once capability contracts, UX states, and fallback expectations are defined<br>- Invokes **测试 Agent** to review acceptance criteria and edge/downgrade scenarios |
| **程序员 Agent (Programmer Agent)** | - Architecture design, runtime/extension/desktop implementation, and bug fixing<br>- Enforcing security boundaries (loopback-only, path confinement, Origin/auth, terminal deny-list)<br>- Maintaining CommonJS compatibility (`src/core`, `src/mcp`) and application isolation (`apps/*`)<br>- Bumping the affected product version(s) after every modification before task completion | - Shared runtime: `src/core/*`, `src/mcp/*`, `src/pet/*`<br>- Applications: `apps/aichat-rust/*`, `apps/aichat-desktop/*`, `apps/vscode-extension/*`, `apps/local-helper/*`, `apps/local-model-runtime/*`, `apps/mcp-runtime/*`<br>- Build, version & packaging scripts (`npm run compile:only`, `npm run check:shared`, `pnpm --prefix apps/aichat-rust check`, `prepare-release-version.cjs`) | - Consults **产品 Agent** when capability semantics, error messages, or UI fallbacks are ambiguous<br>- Hands off to **测试 Agent** with changed modules, bumped version info, and target test suites after self-check |
| **测试 Agent (QA / Test Agent)** | - Writing and executing unit, integration, and smoke tests (`node --test`, `cargo test`)<br>- Cross-version compatibility matrix testing (new client + old server, old client + new server, new + new)<br>- Feature-parity verification between `apps/aichat-rust` and `apps/aichat-desktop`<br>- Security boundary, daemon lifecycle, and real CLI/browser smoke verification | - Root & app test suites: `scripts/*.test.cjs`, `scripts/*.test.mjs`, `apps/*/scripts/*.test.cjs`, `apps/*/tests/*`, `apps/aichat-rust/src-tauri/src/**`<br>- Smoke & live verification tools (`apps/aichat-rust/scripts/smoke.cjs`, `scripts/dashboard-browser.test.cjs`, `scripts/agent-cli-smoke.cjs`) | - Reports regressions, parity gaps, unverified live environments, or compatibility gaps back to **程序员 Agent**<br>- Validates feature completeness and version bump consistency against **产品 Agent** acceptance criteria before release |

### Role Boundaries & Collaboration Rules

1. **Independent Ownership**:
   - **产品 Agent** focuses on *what* and *why* (user scenarios, protocol contracts, graceful degradation rules, documentation) without coupling to internal implementation details.
   - **程序员 Agent** focuses on *how* (clean implementation in `src/` and `apps/`, strict adherence to [Non-negotiable rules](#non-negotiable-rules), zero cross-app imports, and version bumping after every modification).
   - **测试 Agent** focuses on *verification* (isolated fixtures, boundary/security checks, regression coverage, and honest reporting of what was tested live vs. mocked).
2. **On-Demand Invocation**:
   - Any agent can be invoked standalone for focused tasks (e.g., docs update, bug fix, or test addition) or coordinate in parallel on larger features.
   - Every cross-boundary change must satisfy **产品 Agent**'s compatibility contract, **程序员 Agent**'s compile/shared checks + version bump, and **测试 Agent**'s targeted test suite before completion.
3. **No approval bounce-back (已定位缺陷不问用户「改不改」)**:
   - Once a defect's root cause is confirmed by code or runtime evidence, the **程序员 Agent** must not hand the fix decision back to the user. It must first consult the **产品 Agent** (expected behavior, interaction contract, fallback and compatibility boundaries) and the **测试 Agent** (acceptance criteria, test matrix, regression risk), then implement, bump the affected product version per [Non-negotiable rules](#non-negotiable-rules), and verify.
   - Return to the user only when the 产品 Agent explicitly flags a product trade-off that requires the user's choice, or when the action touches shared state / is irreversible (push, publish, delete).
   - Reason: user instruction on 2026-11-09 — defect fixes are decided through the product/test agent protocol, not by asking whether to fix.
   - Scope: every reproduced defect in this repository whose root cause is located.

### Self-Iteration Protocol: Converging `apps/aichat-rust` Toward `apps/aichat-desktop` (自我迭代与功能对齐协议)

To continuously evolve the Rust + Tauri 2 desktop client ([`apps/aichat-rust`](apps/aichat-rust/README.md)) so that it steadily approaches and achieves 100% feature parity, interaction fidelity, and edge-case resilience with the original Electron reference ([`apps/aichat-desktop`](apps/aichat-desktop/README.md)), the three Agents execute a structured **Self-Iteration Loop**:

#### 1. Reference Mapping (`apps/aichat-desktop` → `apps/aichat-rust` 对齐矩阵)
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

#### 2. Self-Iteration Prompt Template (自我迭代提示词模板)
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

## Non-negotiable rules

1. **Bind loopback only** (`127.0.0.1`). Never listen on `0.0.0.0` or expose port 8089 on the LAN.
2. **Pairing token is optional (default off).** `/mcp` and `/admin/*` are open on loopback unless `keepwork.mcp.requireAuth` / `KEEPWORK_MCP_REQUIRE_AUTH=1` / `--require-auth`. When auth is on, do not log or commit `~/.keepwork-mcp/token`.
3. **Path confinement**: relative `run_terminal` cwd and `grep_files` paths must stay under the workspace root (`src/core/paths.ts`). Reject `..` and symlink escapes. Absolute disk paths (`C:\foo`, `/foo`, `~/foo`) are allowed when the directory exists — AIChat uses these for a bound local folder. Workspace `/fs/list` `/fs/search` `/fs/file` `/fs/dir` (AIChat local disk) confine the *requested* relative path lexically (`confineLexical`); they include symlink/junction names and may follow a link that lives inside that verified root. `GET /fs/file` without `links=include` still uses realpath confinement for the web-paracraft overlay.
4. **Do not weaken the deny-list** in `src/core/terminal.ts` without an explicit user request. AIChat must keep confirming every `run_terminal` call.
5. **One daemon**: if `listen` throws `EADDRINUSE`, attach — do not start a second HTTP server. Closing a VS Code window must **not** kill the daemon.
6. Keep CommonJS (`"module": "commonjs"`) so the VS Code extension still loads. Do not convert the package to ESM-only.
7. AIChat is a **no-build ES module app** — do not bundle `@modelcontextprotocol/sdk` into it. The browser client is a thin Streamable HTTP client in `js/local_mcp.js`.
8. **Bump version after every modification**: whenever repository files are modified, increment the version number of the affected product(s) before completing the task:
   - For `apps/aichat-rust`: synchronously bump `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
   - For shared `src/` or extension/MCP runtime: update `package.json` and `package-lock.json` in `apps/vscode-extension` and `apps/mcp-runtime` (e.g. via `node apps/vscode-extension/scripts/prepare-release-version.cjs`).
   - For other standalone apps (`apps/local-helper`, `apps/aichat-desktop`, etc.): bump the corresponding app's `package.json` / `package-lock.json`. Keep the root `package.json` at `"0.0.0"` (`private: true`).
   - For `apps/mcp-rust`: bump `crates/keepwork-mcp/Cargo.toml` and keep `crates/keepwork-mcp` (workspace) `Cargo.lock` in sync. Its version line is independent of the desktop app.

## Client/server version compatibility

- Standing user requirement (2026-10-31): AIChat and Keepwork MCP ship independently. Make every client/server version pairing work as well as its shared capabilities permit. A client release must not require publishing or updating the server, and a server release must preserve existing clients. Do not require equal product versions or reject an otherwise usable peer merely because it is older, newer or has an unknown version.
- Negotiate features through explicit capabilities and supported protocol contracts, not product-version guesses. Missing optional capability means unavailable/unknown, not a broken connection. Accept additive response fields and preserve legacy request defaults, response fields, routes, event formats and persisted data. Validate security-sensitive inputs normally; compatibility never relaxes Origin, authentication, ownership, path confinement or approval checks.
- Prefer additive, optional changes. Advertise a capability only when its semantics are implemented. Do not silently ignore a requested semantic that would change the result (for example isolated context, authorization or execution guarantees). For an incompatible protocol change, negotiate a supported contract or retain a legacy adapter instead of replacing the existing contract in place.
- Fail gracefully at the feature boundary: use an equivalent supported fallback when available; otherwise hide/disable the unsupported action or return a clear, bounded feature-specific error. Keep ordinary chat and unrelated tools working. Do not block the whole app behind an upgrade prompt for an optional feature. Distinguish unsupported capability from offline, authentication, permission and transient errors; give an actionable explanation when the user attempts an unavailable operation.
- Never claim a fallback preserves semantics when it does not. Missing execution metadata means unknown, not zero calls or success. Preserve user data and pending-request identity across reconnects/upgrades/downgrades. Never automatically replay an uncertain mutation or resubmit it with changed semantics; inspect the outcome first. Re-evaluate capability state when the connected peer changes and clear unsupported selections.
- For every cross-boundary behavior change, test new client + older published server contracts and older published client contracts + new server, as well as the supported new/new path. Include absent/unknown optional fields and capabilities, unsupported routes/features, reconnect or downgrade, and unaffected ordinary operations. Use isolated fixtures when live versions are unavailable, state that limitation, and do not claim universal live compatibility from version numbers or source inspection alone.

- Server responsibility: continue accepting legacy clients and omitted optional parameters with their historical behavior; expose new functionality through additive capabilities. Keep legacy response fields consumable by old clients, return explicit unsupported-feature errors where semantics cannot be honored, and keep other endpoints available. Example: advertise `taskContextVersion: 1` in persona snapshots while keeping ordinary messages valid without `contextMode`.

## Layout (where to edit)

The repository root is a private shared-runtime package. Product manifests, entry points, editor settings, tests and build outputs belong under their application directory. `apps/vscode-extension` and `apps/local-helper` may import `src/core` / `src/mcp`; applications must not import one another. `apps/local-model-runtime` is an installer resource and independent process; its source, dependencies, ONNX model, manifests and staged runtime must never enter the VSIX.

| Path | Role |
|------|------|
| `src/core/paths.ts` | Workspace root + confine paths |
| `src/core/config.ts` | Port, token, `~/.keepwork-mcp/` instance file, default user workspace |
| `src/core/terminal.ts` | Shell spawn / VS Code terminal bridge, timeout, output cap, deny-list, per-session queue |
| `src/core/terminalSessions.ts` | User-operated node-pty sessions, raw input/output, resize, ownership, caps, idle cleanup |
| `src/core/vscodeBridge.ts` | Daemon client: POST to the extension terminal bridge |
| `apps/vscode-extension/src/vscode/terminalBridge.ts` | Extension host: reuse Keepwork integrated terminal + `/run` loopback |
| `apps/vscode-extension/src/vscode/notifyBridge.ts` | Extension host: calendar OS/VS Code notifications + open AIChat |
| `src/core/grep.ts` | `rg` if present, else Node walk |
| `src/core/modelStudioUpload.ts` | Allowlisted temporary Model Studio upload policy + streamed OSS multipart relay; shared Origin/auth in http.ts; no key persistence |
| `src/core/web.ts` | Public http(s) fetch, SSRF checks, search-engine HTML parsers, compact JSON |
| `src/core/headless.ts` | System Edge/Chrome `--dump-dom` for `fetch_url` |
| `src/core/html_text.ts` | Structured HTML → text (headings/lists; never markup) |
| `src/core/keepwork.ts` | Keepwork URL → git clone URL / open-in-browser URL |
| `src/core/paracraftLaunch.ts` | Fixed Windows protocol launch grammar, project reuse, shared launch IDs and registration status; no direct executable launch |
| `src/core/paracraftClients.ts` | Desktop Paracraft CLI registry + job queue (`/paracraft/*`) |
| `src/core/webserverProxy.ts` | WASM NPL code wiki front (`/webserver/:instance/*`) |
| `src/core/calendarReminders.ts` | AIChat calendar 7-day reminders (`/calendar/reminders`) |
| `src/core/fsServe.ts` | Loopback file overlay (`GET /fs/file`) + AIChat local-disk workspace (`/fs/list` `/fs/search` `/fs/stat` PUT/DELETE) |
| `src/mcp/server.ts` | MCP tool registration (`run_terminal`, `grep_files`, `mcp_status`, `web_search`, `fetch_url`) |
| `src/mcp/paracraftTools.ts` | Creation jobs, official wiki, fresh MCP images, stdio singleton-hub forwarding; engine-owned API documentation |
| `src/mcp/paracraftTemplates.ts` | Lazy packaged-template metadata, deterministic native source and named RGB palette overrides; tests in `scripts/paracraft-template.test.cjs` |
| `src/mcp/paracraftJobResult.ts` | Display-only compact creation results and same-job full recovery; tests in `scripts/paracraft-creation.test.cjs` |
| `src/mcp/http.ts` | Streamable HTTP, CORS/PNA, session map, admin API |
| `src/mcp/sessions.ts` | Connected clients + in-memory call history (paged list) |
| `src/mcp/stdio.ts` | stdio transport for Cursor (does not take 8089) |
| `apps/vscode-extension/src/cli.ts` | app-local `dist/cli.js` (`--stdio`, `--port`, `--root`) |
| `apps/vscode-extension/src/extension.ts` | VS Code commands + activate spawn-or-attach |
| `apps/local-helper` | Windows tray app, login startup, notify bridge, updater and NSIS packaging; imports the shared MCP source |
| `apps/local-model-runtime` | Windows x64 local-model source, integrity data, tests and staged NodeRuntime; bundled only as Local Helper `extraResources` |
| `apps/vscode-extension/src/vscode/daemon.ts` | Health probe, detached spawn, admin fetch |
| `apps/vscode-extension/src/vscode/copilotMcp.ts` | Native VS Code MCP provider, singleton daemon resolution and connection-time auth for Copilot |
| `apps/vscode-extension/src/vscode/statusBar.ts` | Status bar text / tooltip |
| `apps/vscode-extension/src/vscode/mcpPanel.ts` | Click panel: clients + paged history + working directory / terminal |

AIChat client (outside this repo): `c:/lxzsrc/maisi/maisi/maisi/webgames/tools/AIChat/js/local_mcp.js`.

## MCP surface

The VS Code Second Brain view lives in `apps/vscode-extension/src/vscode/secondBrain.ts`.
It defaults to the right Secondary Side Bar (VS Code 1.106+) and embeds `/chat`
using `aichat.external-tool.v1`, with optional Keepwork login. Development Hosts
serve local AIChat source through `brainDevelopment.ts` and fall back to `/chat`;
the source server is loopback-only, does not build AIChat, and closes on disposal.
Brain skills and workspace/profile ownership remain in AIChat. Do not introduce copies
of those skills or a second MCP brain registry. Run `apps/vscode-extension/scripts/second-brain.test.cjs`
for wrapper security/lifecycle checks; details: `apps/vscode-extension/docs/second-brain.md`.

| Tool | Notes |
|------|--------|
| `run_terminal` | `command`, optional `cwd` / `timeoutMs`; VS Code Keepwork terminal when the extension is up, else spawn; serialized per session; global cap 4 |
| `grep_files` | `pattern` (regex), optional `path` / `glob` / `maxMatches`; read-only |
| `mcp_status` | Root, port, pid, whether `rg` is on PATH |
| `web_search` | `query`, optional `count`; Bing → DDG → Baidu HTML; minified JSON results; no confirm |
| `fetch_url` | `url`, optional `maxChars`; Edge/Chrome dump-dom then structured text; static HTML fallback; SSRF; minified JSON |


HTTP:

- `GET /` and `GET /dashboard` — browser dashboard with Overview, History, Clients, Paracrafts and API docs hash views. Overview reads build identity and host/environment details from `/admin/status`; bundle timestamps come from `scripts/runtime-build-info.mjs` (including watch rebuilds), never daemon startup or file mtime. Test metadata with `scripts/runtime-build-info.test.mjs`. `GET /admin/api-docs` returns the runtime-aware structured API catalog; maintain HTTP definitions in `src/mcp/apiDocs.ts` when adding routes. Test with `scripts/dashboard.test.cjs`; browser smoke test `scripts/dashboard-browser.test.cjs` requires a running development daemon and Edge.
- `GET /health` — public probe (`name: keepwork-mcp`, `requireAuth`, `workspaceRoot`, `paracraftClients`, `webserverBase`, `webservers` as `{ instance, root }[]`, `fsApi: "workspace"` when list/write/delete are available). New daemons report `hostKind`: `local-helper` or `vscode-extension`; only Local Helper reports its application `hostVersion`. Browser clients must not interpret the service protocol `version` as an application version.
- `GET /health` optionally reports `desktopClient` (product/version/platform/arch), recorded by a packaged desktop launch and omitted if its executable no longer exists. Never use MCP runtime/protocol versions as the desktop version.
- `GET /health` also reports `terminalApi: "pty-session-v1"` when the user-operated PTY API is available.
- `POST /terminal/sessions`, `POST /terminal/sessions/:id/input`, `GET /terminal/sessions/:id/stream?cursor=` (long-lived NDJSON output with cursor replay), compatibility `GET /terminal/sessions/:id/output?cursor=`, `POST /terminal/sessions/:id/resize`, `POST /terminal/sessions/:id/interrupt`, `DELETE /terminal/sessions/:id` — direct AIChat workspace PTY. Keep Origin/auth ownership, verified cwd, bounded output/concurrency, idle cleanup, stream disconnect cleanup, and daemon-close cleanup. Raw user input cannot use whole-command deny-list parsing; do not weaken the separate model-operated `run_terminal` confirmation or deny-list.
- `GET /exists?path=` — public probe: does this absolute/`~` path exist as a directory (AIChat must verify a user-typed local workspace root before `/fs/*`)
- `GET /fs/locations` and `GET /fs/browse?path=&hidden=1&filter=&offset=&limit=` — read-only AIChat folder picker, implemented in `src/core/folderBrowser.ts`. `/health` advertises `folderBrowserApi: "folders-v1"`. Locations use the daemon OS's configured common folders and roots; browsing is shallow, folder-only and paginated. Keep explicit Origin/auth checks in `src/mcp/http.ts`. No native dialog or model tool. Test with `node --test scripts/folder-browser*.test.cjs`.
- `GET /fs/list?root=&path=&max=` — directory listing; includes symbolic links / junctions. `recursive=1` returns file paths (BFS, loop-aware, capped)
- `GET /fs/search?root=&path=&q=&max=` — filename substring search (case-insensitive); includes symlink/junction names, skips `node_modules` / `.git`, loop-aware, scan cap 8000
- `GET /fs/stat?root=&path=` — `{ exists, isFile, isDirectory, symlink, size }`
- `PUT /fs/dir?root=&path=` — recursively create a confined directory; returns `{ created }`
- `GET /fs/file?root=&path=` — one confined file as **raw on-disk bytes**. MIME from extension (Lua/NPL `text/plain`, html/js/css/png/jpg, unknown `.fxo` / `.o` as `application/octet-stream`). **Never** `charset=` (XHR would decode the body). Optional `?base64=true` returns JSON `{ ok, size, rel, type, base64 }` instead. `links=include` uses lexical confine so a symlink inside the root is readable. Loopback, no token, `Cache-Control: no-store`
- `PUT /fs/file?root=&path=` — write UTF-8/bytes under the verified root (creates parent dirs)
- `DELETE /fs/file?root=&path=` — delete a file or symlink (not a directory)
- `DELETE /fs/dir?root=&path=` — recursive directory delete
- `POST /fs/reveal?root=&path=` — show the confined path in the OS file manager (`revealFileInOS` when the VS Code extension is up, else `explorer /select` / `open -R` / `xdg-open` dir). Optional `mode=open` opens the file with the default app; `mode=dir` opens the containing folder.
- `POST/GET/DELETE /mcp` — Streamable HTTP; Bearer token only if `requireAuth`
- `GET /admin/status`, `GET /admin/history?offset=&limit=`, `POST /admin/stop` — token, loopback
  (`/admin/history` returns one newest-first page, default `limit=20`, max 50; includes `total` / `hasMore`)
- Paracraft CLI hub (plain HTTP, not MCP):
  - Hub **awakens** desktop Paracraft: while the daemon is up it scans `127.0.0.1:8099-8115` and pings `/ajax/paracraft_cli?action=health`. Desktop **registers once on start**; if that succeeds it long-polls jobs (and heartbeats) while the hub stays up. If register fails it does **not** poll `:8089` until NPL inbound or the next start.
  - `POST /paracraft/register` — start probe + identity (open on loopback). Body may include `nplPort`. For WASM the hub assigns `webparacraft1`, `webparacraft2`, … and returns `webserverInstance` / `webserverRoot` / `webserverBase`.
  - If `nplPort` pings (`GET http://127.0.0.1:<nplPort>/ajax/paracraft_cli?action=health`), register returns `useNpl: true` and the hub dispatches to that NPL HTTP port instead of long-poll.
  - `POST /paracraft/:id/jobs/poll` — long-poll jobs (`waitMs`, max 10s) only for clients without a live NPL port. Empty + `useNpl` when the NPL port is live. Hub pings NPL health every 10s; poll-only clients drop if they stop polling for 10s. HTTP wiki jobs are coalesced (~10ms) so parallel CSS/JS share one poll.
  - `POST /paracraft/:id/jobs/:jobId/result` — job result
  - `POST /paracraft/:id/jobs/results` — batch `{ results: [{ jobId, result }] }` (WASM wiki file bodies)
  - `GET /paracraft/clients` — live **desktop** clients (Bearer if `requireAuth`); `platform=wasm` is omitted so ParacraftTool does not duplicate the web iframe
  - `ALL /webserver/:instance/*` — optional external loopback NPL code-wiki front for WASM. The embedded WebParaCraft wiki uses a direct same-origin ServiceWorker/page RPC and does not require Keepwork MCP. For external access, Keepwork queues `http_request` jobs; the WASM instance serves `.page` / ajax / static via ParaIO. Cookie `Keepwork-WebServer` routes root-absolute `/wp-includes` and `/ajax` back to that instance.
  - `GET /paracraft/:id/timeline` — last screenshots + non-`health` action summaries (capped; no ping spam)
  - `POST /paracraft/:id/:action` — `health` / `world_status` / `run_command` / `screenshot` / `camera_capture` / `open_world` / `exit` / `bring_to_front`. `camera_capture` takes world-coordinate `eye`/`lookat` vectors for an independent desktop viewport; never reuse or populate the ordinary screenshot cache for it.
- Calendar reminders (plain HTTP, loopback, same CORS as `/paracraft/register`):
  - `POST /calendar/reminders` — replace the next 7-day reminder set `{ events: [{ id, title, start, remindAt, openUrl }], horizonDays }`
  - `GET /calendar/reminders` — inspect the stored set
  - Persist `~/.keepwork-mcp/calendar-reminders.json`. Daemon timers fire at `remindAt`; the extension notify bridge shows `showInformationMessage` with **打开日历** → `openExternal(openUrl)` (`http(s)` keepwork.com / localhost / 127.0.0.1 only). If VS Code is closed, due items retry every 15s until the bridge is up.

Settings: `keepwork.mcp.enableHttp` / `keepwork.mcp.port` / `keepwork.mcp.workspaceRoot` / `keepwork.mcp.requireAuth` (default false).

VS Code Copilot: `keepwork.mcp.connectCopilot` defaults to true. The extension
contributes provider `keepwork.mcp` and registers it during activation; discovery
publishes the loopback `/mcp` endpoint, resolution starts/attaches to the singleton
and reads auth headers only then. Never write user/workspace MCP configuration or
override editor trust/tool permissions. `contributes.chatSkills` points to the
complete packaged `dist/skills/paracraft-create/SKILL.md`; keep its relative guides
in the VSIX. Older editors without the MCP API must still activate. Verify with
`npm run compile:only --prefix apps/vscode-extension` and
`npm test --prefix apps/vscode-extension`.

Root resolution (first match): `--root` / `KEEPWORK_MCP_ROOT` / VS Code setting / `~/.keepwork-mcp/config.json` / `~/.keepwork-mcp/workspace` (created automatically, with a `default` slot). Not the open VS Code folder. AIChat cwd is `workspace/default` or `workspace/[workspacename]`.

Commands: `keepwork.openMcpWorkspace`, `keepwork.changeMcpWorkspace`, `keepwork.showMcpTerminal`.

## Common workflows

### NodeRuntime CDN release

- `apps/mcp-runtime` owns standalone runtime staging, archive packaging and release metadata. See [its README](apps/mcp-runtime/README.md).
- `.github/workflows/mcp-node-runtime.yml` builds Windows x64 and macOS arm64/x64 on native runners on every `main` push, or manual dispatch on `main`. It reuses the Local Helper Qiniu secrets and publishes under `keepwork/mcp-runtime/`.
- Keep all three extracted-archive smoke tests passing before publishing. Preserve native PTY files and macOS executable modes. Publish exactly six fixed objects: `windows-x64.zip/json`, `macos-arm64.zip/json`, `macos-x64.zip/json`. Each platform JSON contains version, commit, builtAt, size and SHA-256; no version directories or filename suffixes. Do not mutate package versions in CI.
- Overwrite and verify the three ZIPs before overwriting and verifying their three JSON files. Serialize publishers and check current remote `main` before starting; once overwrite begins, complete the matching pairs. Fixed objects are not atomically replaced; consumers must verify hashes and retry mismatched downloads. External contract: [docs/node-runtime-cdn.md](docs/node-runtime-cdn.md). Shared Qiniu transport lives in `scripts/lib/qiniu-release.cjs`; applications must not import one another's release scripts.
- Validate release changes with `node --test apps/mcp-runtime/scripts/*.test.cjs apps/local-helper/scripts/publish-qiniu-release.test.cjs` plus native staging/package smoke tests.

### AIChat Rust desktop release

- `.github/workflows/aichat-rust-windows-release.yml` builds Windows x64 + arm64 and the macOS universal DMG. The `publish` job attaches them to the GitHub release on an `aichat-rust-v*` tag; the `publish-cdn` job copies the same three installers to the CDN after both builds finish, on dispatch and on tags.
- `apps/aichat-rust/scripts/publish-cdn-release.cjs` uploads exactly `Keepwork_<version>_x64-setup.exe`, `Keepwork_<version>_arm64-setup.exe` and the single `Keepwork_<version>_*.dmg` to `keepwork/aichat-rust/<version>/`. The path is immutable: identical bytes are skipped, different bytes at the same key are an error, so republishing changed installers requires a new version. Never build or repack inside the publisher, and never write installers under `keepwork/aichat-desktop/`, `keepwork/mcp-stable/` or `keepwork/aichat-cef/`.
- The CDN copy is skipped with a warning only when the Qiniu secrets are absent; unsigned builds are copied too, matching the GitHub release, which has no signing gate (the Windows build job warns instead).
- Validate publisher changes with `node --test apps/aichat-rust/tests/cdn-release.test.cjs` plus a `--dry-run` against a downloaded artifact directory.

### Rust MCP daemon (`apps/mcp-rust`)

- Rust rewrite of the same daemon. Contract and phase gates: [docs/rust-runtime-migration.md](docs/rust-runtime-migration.md).
- The app owns its Cargo workspace (`crates/keepwork-mcp`); the repository root must not gain a `Cargo.toml` (`scripts/check-layout.cjs` enforces this).
- Wire compatibility is verified against the Node daemon by `scripts/contract/*.test.cjs` (same assertions, two engines, separate ports). Run `npm run check:rust` and `npm run test:contract` before shipping a slice.
- Advertise a `/health` capability only when its routes exist; unimplemented surfaces stay absent so AIChat degrades instead of hitting 404s.
- P1 covers lifecycle, CORS/auth, `/health`, `/exists`, the full `/fs/*` surface (including `/fs/locations|browse`), PTY `/terminal/*`, `/admin/status|stop`, the MCP handshake and the five portable tools (`mcp_status`, `run_terminal`, `grep_files`, `web_search`, `fetch_url`). Agents, messaging, personas, browser, computer and paracraft remain unadvertised. Do not mark later phases done without the corresponding contract tests.

### Extension development

```bash
cd c:/lxzsrc/keepworkExtension
npm ci
npm ci --prefix apps/vscode-extension
npm run compile:only --prefix apps/vscode-extension
npm start --prefix apps/vscode-extension       # HTTP daemon :8089
npm run mcp --prefix apps/vscode-extension     # stdio MCP for Cursor
```

### Visual Studio Marketplace release

- For a Marketplace release use the checked-in `scripts/publish-marketplace.ps1` (or the matching VS Code task). The coordinated workflow validates the published VSIX, promotes MCP, then publishes the shared Desktop ZIP and signed manifest. Verify the desktop-code job before reporting completion. A manual portal upload needs a `keepwork-stable.yml` dispatch with its exact marketplace_version.
- Marketplace identity: `Xizhi.keepwork`; public page: `https://marketplace.visualstudio.com/items?itemName=Xizhi.keepwork`.
- Prefer Microsoft Entra ID via `@vscode/vsce --azure-credential`; do not put PATs, access tokens, or Azure credentials in repository files, chat, logs, or command arguments.
- The Entra identity must be a **Contributor** (or Owner) of Marketplace publisher `Xizhi` and must have permission to modify the existing `keepwork` extension. When authorization fails, retrieve the profile ID with `az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv`, then add that identity in publisher management.
- On Windows, use normal `az login --tenant <tenant-id> --allow-no-subscriptions` so Web Account Manager can satisfy MFA and Security Defaults. Do not use device-code login when the tenant blocks device code with `AADSTS530035`.
- `npm run package --prefix apps/vscode-extension` allocates one patch version above both the MCP and extension manifests, updates both lockfiles and packages the matching VSIX. Commit and push the prepared release to main, then run the **Keepwork: Publish Latest VSIX (Entra)** task. It publishes the existing VSIX and dispatches stable MCP publication for Windows x64 and both macOS architectures. Verify both channels. For build-only checks use `npm run compile:only --prefix apps/vscode-extension`. Standalone `compile` still bumps only the extension patch.
- `npm run package --prefix apps/vscode-extension` creates `apps/vscode-extension/keepwork-<version>.vsix`. Before publishing, verify that the app manifest version and VSIX filename match the intended release.
- Publish the existing artifact without another build or version bump. If Marketplace publishing times out, retry with HTTP proxy variables temporarily cleared for the `vsce` process; the example saves and restores the current PowerShell process values even if publishing fails:

  ```powershell
  $env:PATH = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin;' + $env:PATH
  $proxyNames = 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'
  $savedProxy = @{}
  foreach ($name in $proxyNames) {
    $savedProxy[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  try {
    .\apps\vscode-extension\node_modules\.bin\vsce.cmd publish --azure-credential --packagePath .\apps\vscode-extension\keepwork-<version>.vsix
  } finally {
    foreach ($name in $proxyNames) {
      [Environment]::SetEnvironmentVariable($name, $savedProxy[$name], 'Process')
    }
  }
  ```

- The explicit PATH prefix is needed only when Azure CLI was installed after the current VS Code process started; a restarted VS Code should inherit it normally.
- A successful release prints `DONE Published Xizhi.keepwork v<version>`. Verify the public Marketplace page; allow several minutes for propagation.
- Publishing an existing VSIX must not change source, increment versions, create commits, or create tags. Do not commit or push release changes unless the user explicitly requests it.
- For unattended CI releases, use Microsoft's workload identity federation plus managed identity flow and add that managed identity as a Publisher Contributor. Do not persist an interactive Azure CLI session as CI authentication.

### Debug the HTTP MCP server without the extension

For Paracraft development, the dev task serves `skills/paracraft-create/` from
this checkout on each request. Check live skill content via `paracraft_cli`
with action `skill` and the actual schemas via `/paracraft/authoring`.
See [development checks](skills/paracraft-create/references/local-development.md)
before claiming the selected AIChat Web client ran a new revision.

Run the VS Code task **Keepwork MCP: Dev Server (8089)**, or start the same workflow from a terminal:

```bash
npm run dev:server --prefix apps/vscode-extension
```

This rebuilds the app-local `dist/cli.js` in watch mode and runs it on `127.0.0.1:8089`. After every successful source rebuild, it restarts the MCP daemon automatically. On startup it stops an existing daemon only when `/health` identifies it as `keepwork-mcp`, so it will not replace an unrelated service using port 8089. Stop the task with Ctrl+C.

Use `http://127.0.0.1:8089/health` to verify the listener and `http://127.0.0.1:8089/admin/status` to inspect the PID, workspace root, clients, and auth state. This workflow is for debugging the MCP HTTP server and AIChat integration without publishing the extension, pressing F5, or reloading an Extension Development Host.

Open `apps/vscode-extension` as the VS Code workspace, then run F5 **Run Extension**: on `onStartupFinished` the extension probes `:8089` and spawns its app-local CLI if free. A newer bundled runtime replaces an identified older Keepwork MCP PID after rechecking health; compare `runtimeVersion`, never the protocol `version`. Newer running versions must not be downgraded for a workspace preference. Test with `node --test apps/vscode-extension/scripts/daemon.test.cjs apps/aichat-desktop/tests/runtime.test.cjs`. Status bar **Keepwork MCP** → click for clients/history.

Cursor stdio (does not replace the HTTP daemon AIChat needs):

```json
{
  "mcpServers": {
    "keepwork": {
      "command": "node",
      "args": ["c:/lxzsrc/keepworkExtension/apps/vscode-extension/dist/cli.js", "--stdio"],
      "env": { "KEEPWORK_MCP_ROOT": "C:/Users/you/.keepwork-mcp/workspace" }
    }
  }
}
```

## Related trees (outside this repo)

| Path | Use |
|------|-----|
| `c:/lxzsrc/maisi/maisi/maisi/webgames/tools/AIChat/js/local_mcp.js` | Browser MCP client + composer pill |
| `c:/lxzsrc/maisi/.../AIChat/docs/local-mcp.md` | How to pair the token |
| `c:/lxzsrc/webparacraft` | Local web-paracraft; `?searchroot=&searchpath=` overlays git files via `/fs/*` |
| `c:/lxzsrc/ParacraftMaker` | Sibling Maker MCP (stdio + Agent Bridge `:18300`, not this port) |

## When changing behavior

- Experimental macOS computer use lives in `src/core/computerMac.ts`: built-in OS commands only, native consent bound to the requesting MCP session (24-hour absolute expiry, no idle timeout), Escape/top-left stop checks before actions, no reclaim panel, no scroll/right-click. Screenshots normalize to screen points. Preserve argument-only user data and explicit unsupported-action failures. Test `node --test scripts/computer-mac.test.cjs`. Windows safeguards below remain unchanged.

- Explicit screenshots: `src/core/desktopCapture.ts` + `screenshotPermission.ts` + `petPermissionBridge.ts`; shared native pet UI lives in `src/pet`, with standalone runtime dependencies in `apps/pet-companion`. Capture approval uses the pet bubble with no deadline; remembered screenshot-only approval is revocable through AIChat and dashboard settings. Never grant input control from screenshot approval. Run `node --test scripts/screenshot-permission.test.cjs scripts/screenshot-http.test.cjs` and `node scripts/pet-permission-native.cjs`.

- Computer use: `src/core/computer.ts` + `src/core/computerOverlay.ts` + `src/mcp/computerTools.ts`; Windows primary screen only, revocable native consent bound to the requesting MCP session with two-minute idle expiry, no input queue or model-supplied scripts. The capture-excluded, non-activating overlay provides Take Back Control; renewed consent is mandatory after revocation. AIChat discovery and vision adapter: `js/local_mcp.js` + `js/computer_tools.js`. Keep desktop calls non-retrying. Test `node --test scripts/computer.test.cjs`; see [docs/computer-use.md](docs/computer-use.md).

- New MCP tool → `src/mcp/server.ts` + AIChat `KEEPWORK_TOOL_NAMES` / chip labels in `chat_render.js` + README + this file.
- Paracraft CLI hub → `src/core/paracraftClients.ts` + `/paracraft/*` in `src/mcp/http.ts`; keep register/poll open on loopback; never log screenshot base64. Narrative: [docs/paracraft-cli.md](docs/paracraft-cli.md).
- Official Paracraft docs: `read_official_wiki` is an ACTIONS gateway entry through the single `paracraft_cli` MCP gateway. Forward `{path}` unchanged; the engine registry validates it and returns bounded bundled read-only content before world entry. Preserve provenance/errors. Do not duplicate the engine manual or page registry here. Test with `scripts/paracraft-scene.test.cjs`.
- Paracraft art skill: canonical files are under `skills/paracraft-create/`. `src/mcp/paracraftGuide.ts` advertises only the root skill resource; `paracraft_cli` action `skill` loads individual guides on demand. Both product builds copy it under `dist/skills/`; keep it in packages. Test `scripts/paracraft-guide.test.cjs`. The skill guides art decisions; engine-owned wiki remains the API authority.
- External WASM NPL code wiki gateway → `src/core/webserverProxy.ts` (`/webserver/:instance/*`); register `webserverRoot`; `GET /health` `webserverBase`. The embedded wiki bridge lives in webparacraft `ServiceWorker.js` + `src/emscripten.js`. Same [docs/paracraft-cli.md](docs/paracraft-cli.md); engine: paraworld `docs/aries/paracraft-cli.md`.
- Web-paracraft local script overlay → `src/core/fsServe.ts` (`GET /fs/file`); confine to the URL `root` with realpath; MIME from file extension (text vs binary; unknown as `application/octet-stream`); never append `charset=` — overlay uses `overrideMimeType(... charset=x-user-defined)` so bytes stay 1:1. Optional `?base64=true` JSON is supported but unused by the overlay.
- AIChat local-disk workspace → same `src/core/fsServe.ts` (`/fs/list` `/fs/search` `/fs/stat` `PUT/DELETE /fs/file` `DELETE /fs/dir`); verify `root` with `inspectDiskPath` / `GET /exists`; include symlink names; lexical confine + `links=include` on read.
- Security / CORS / PNA / token → `src/mcp/http.ts` only; keep origin allowlist tight (`keepwork.com`, localhost).
- Terminal policy → `src/core/terminal.ts` (deny-list, timeout, output cap) and keep AIChat confirm in `chat_agents.js` (`local-mcp-terminal-confirm`).
- Singleton / status bar → `apps/vscode-extension/src/vscode/daemon.ts` + `statusBar.ts` + `mcpPanel.ts`; do not move the HTTP listener into the extension host. The VS Code terminal bridge (`apps/vscode-extension/src/vscode/terminalBridge.ts`) is a separate loopback helper.
- Local Helper packaging → keep product logic in `src/core` / `src/mcp`; `apps/local-helper` may only own tray/lifecycle/update/installer behavior. Build Windows PTY artifacts on Windows, keep native `node-pty` files unpacked, and never commit signing credentials.
- Default working directory parent → `~/.keepwork-mcp/workspace` via `src/core/config.ts` `defaultUserWorkspace()`. Slots: `default` (no AIChat workspace) and `[workspacename]`. Do not default to the open VS Code folder.
- Keepwork clone/open URL rules → `src/core/keepwork.ts` (VS Code commands only in v1; not MCP tools).
- `apps/aichat-rust` main-window navigation → `src-tauri/src/security.rs` `allowed_navigation`, never path-exact `trusted_page` inside `on_navigation`. wry reports iframe (tool) navigations to the same handler without frame information: same-origin keepwork.com pages, `https://cdn.keepwork.com` tool pages (published AIChat releases), the exact dev-source origin, and the WeChat QR iframe (`open.weixin.qq.com/connect/*`) must load in-app, while non-keepwork hosts and credentialed URLs still go to the system browser. `external_url` must drop any URL carrying `token` / `access_token` / `id_token` / `authorization` so a blocked tool URL never leaks its bearer token to the address bar. Login popups go through `allowed_in_app_popup` in `on_new_window`: provider hosts (Google / Feishu / Lark / DingTalk) and keepwork `/sso` `/chat` `/login` open in-app so `window.opener`, postMessage and the `/sso` callback work; every other http(s) popup opens in the system browser. Popups never receive `aichatDesktop`. Keep `trusted_page` strict for bridge senders, media grants and entry validation. Test `cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins` and `node --test apps/aichat-rust/tests/*.test.cjs`.
- `apps/aichat-rust` main-window chrome → `bridge.rs` init script injects a selection guard: `user-select:none` for app chrome, `text` only for inputs, contenteditable, `.chat-msg-bubble`, `.md-body`, `pre/code`; capture-phase `contextmenu` is suppressed outside those copyable regions. Keep message copy and the composer edit menu usable when changing this.
- `apps/aichat-rust` pet drag → `src/pet.ts` must send `screenX`/`screenY` in `drag-start` and apply each `drag` snapshot with `positionLayers()`; `pet.rs` owns `petLeft`/`petTop`, clamp and persistence. Position the sprite with a composited `translate3d` (never left/top per pointermove) and drop the shadow filter while `body.dragging`, otherwise WKWebView leaves ghost trails. Keep the pet canvas on one monitor: a union window across mixed-DPI displays gets placed offscreen by Tauri, so multi-monitor movement must move the window per monitor instead. Preserve the 4px click threshold and single/double/right-click semantics.
- `apps/aichat-rust` MCP runtime → Default development and standard packaging must run `apps/mcp-rust`; Node is only a user-explicit compatibility choice via `dev:node` / `AICHAT_MCP_ENGINE=node`. Never change the default to Node to compensate for an optional capability not yet ported to Rust. For the compatible Node route, MCP CDN manifests use `macos`/`windows` (`mcp_feed_platform`), while the desktop client feed keeps `darwin`/`win32` (`current_runtime_platform`). Bootstrap order is bundled `Contents/Resources/mcp-runtime` → DesktopLauncher runtime → CDN download; start the daemon before the webview's first `/health` probe so AIChat does not pause auto-reconnect. Never rename the desktop feed paths.
- `apps/aichat-rust` remote capability → `capabilities/default.json` must include `https://keepwork.com/*`, `https://keepwork.com/chat*` and `https://cdn.keepwork.com/*`; AIChat release pages append query/hash and tool pages live on the CDN, so exact `/chat` patterns deny IPC with `Command ... not allowed by ACL`. The custom bridge commands are allow-listed together by `src-tauri/permissions/desktop-commands.toml` (`allow-desktop-commands`); keep every new `generate_handler!` command in that list. Do not widen the window label list or `trusted_page`.

## Agent CLI adapters

Copilot's optional VS Code custom-model discovery/routing lives in `src/core/copilotHarness.ts`
and `src/core/vscodeModels.ts`; the extension endpoint is `apps/vscode-extension/src/vscode/modelBridge.ts`.
Native CLI models stay on ACP. Custom models require BYOK-capable Copilot CLI and
an open editor, keep provider keys in VS Code, and use a separate authenticated
loopback model bridge (never the terminal credential). Validate with
`node --test scripts/copilot-model-bridge.test.cjs apps/vscode-extension/scripts/model-bridge.test.cjs`.

`src/core/agentSessions.ts` and `src/mcp/agentHttp.ts` expose the shared owned `/agents`
surface. `codexHarness.ts` handles Codex; `acpHarness.ts` handles WorkBuddy (CodeBuddy
ACP engine), Copilot, Cursor, Trae, Qwen, Kimi and OpenCode.
`antigravityHarness.ts` implements native `agy` stream-json under the stable `gemini`
backend key. Legacy Gemini ACP history stays readable and cannot resume in agy.
Windows discovery uses `%LOCALAPPDATA%/agy/bin`; the override is `KEEPWORK_ANTIGRAVITY_PATH`.
Test `node --test scripts/antigravity-harness.test.cjs` when changing this adapter.
`claudeHarness.ts` implements Claude native stream-json; `agentCliBackends.ts` owns
the provider registry. Preserve backend-scoped routing, native credentials,
non-replaying restart, local-only transcript caches and existing Origin/owner/auth
checks. `skills/agent-cli-verify/SKILL.md` is packaged for both products. Its MCP resources
are opt-in via `ServerRuntime.includeSetupGuides` for configuration/catalog contexts only;
normal HTTP and stdio sessions must not advertise setup guides or provider references.
Second Brain setup loads selected provider configuration separately on demand. Run `npm run check:shared` and
`node --test scripts/agent-sessions.test.cjs scripts/agent-backends.test.cjs scripts/agent-cli-discovery.test.cjs scripts/claude-harness.test.cjs`.
Real acceptance is `node scripts/agent-cli-smoke.cjs`; unavailable or untested CLIs
must not be reported as passing. See `docs/agent-harnesses.md`.

## Agent CLI development maintenance

For agent CLI installation recipes, discovery, protocol/model compatibility or periodic product upkeep, read [.github/skills/agent-cli-maintenance/SKILL.md](.github/skills/agent-cli-maintenance/SKILL.md), then the selected `.github/skills/agent-cli-maintenance/references/providers/<backend>.md`. This is a single development Skill with per-platform references. Runtime installation guidance is plain Markdown under `skills/agent-cli-verify/references/providers/`; do not register development maintenance Skills as user-facing product skills.

- Model Studio temporary uploads → `src/core/modelStudioUpload.ts`, gated in `src/mcp/http.ts`, documented in `apiDocs.ts`. Preserve separation of daemon Bearer auth and `X-DashScope-Api-Key`, never forward keys to OSS, keep HTTPS target allowlist/body caps/redirect rejection/stream cancellation. Run `node --test scripts/model-studio-upload.test.cjs`. This is an HTTP upload capability, not a model-invoked MCP tool or general proxy.
