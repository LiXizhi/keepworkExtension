# AGENTS.md — Keepwork Extension (`keepwork-mcp`)

Instructions for AI agents working **in this repository**. Overview: [README.md](README.md).

## What this repo is

- **VS Code / Cursor extension** (`keepwork`) + **singleton local MCP daemon** (`node apps/vscode-extension/dist/cli.js` on `http://127.0.0.1:8089`, detached outside extension host; VS Code windows spawn-or-attach; AIChat tabs share one daemon).
- **KP Local Helper** (`apps/local-helper`): per-user Windows installer bundling the daemon + separate `apps/local-model-runtime`.
- **Path**: `c:/lxzsrc/keepworkExtension` (`LiXizhi/keepworkExtension`). Jobs: (1) clone Keepwork repos & open files on keepwork.com; (2) expose `run_terminal` / `grep_files` / `mcp_status` / `web_search` / `fetch_url` so AIChat (`https://keepwork.com/chat`) drives local disk.
- `run_terminal` prefers the VS Code **Keepwork** integrated terminal (`~/.keepwork-mcp/terminal-bridge.json`); closing a window keeps the daemon alive and falls back to spawn.
- For `/rust-release`, read [.github/skills/rust-release/SKILL.md](.github/skills/rust-release/SKILL.md) first. A bare command selects `all` (incl. Win7/Win8). If already tagged/online, complete read-only verification of all selected channels before deciding to publish; a fully verified release with no pending changes needs no new version/scope confirmation.

## Agent Roles & Collaboration

Three roles collaborate in parallel with independent ownership and on-demand handoffs:

- **产品 Agent**: *What/why* — requirements, UX flows, cross-version contracts (AIChat ↔ MCP), acceptance criteria (`README.md`, `docs/*`, `apps/*/docs/*`, `src/mcp/apiDocs.ts`, `skills/*/SKILL.md`).
- **程序员 Agent**: *How* — implementation, security boundaries, CommonJS/isolation rules, build/checks (`compile:only`, `check:shared`, `pnpm --prefix apps/aichat-rust check`), version bumps (`src/*`, `apps/*`).
- **测试 Agent**: *Verification* — unit/integration/smoke tests (`node --test`, `cargo test`), cross-version matrix, `aichat-rust` vs `aichat-desktop` parity, honest live vs. mocked reporting (`scripts/*.test.*`, `apps/*/tests/*`, `smoke.cjs`).

Rules:
1. Cross-boundary changes must satisfy 产品's contract, 程序员's [Non-negotiable rules](#non-negotiable-rules) + checks + version bump, and 测试's target suites.
2. **No approval bounce-back (已定位缺陷不问用户「改不改」)** *(2026-11-09)*: Once a reproduced defect's root cause is confirmed, 程序员 must not ask the user whether to fix — consult 产品 (contract/UX/fallback) and 测试 (acceptance/test matrix/regression), implement, bump version, and verify. Return to the user only for product trade-offs or irreversible/shared actions (push, publish, delete).
3. **Self-Iteration (`apps/aichat-rust` → `apps/aichat-desktop`)**: When asked for **自我迭代** or desktop parity convergence, follow [docs/aichat-rust-self-iteration.md](docs/aichat-rust-self-iteration.md).

## Non-negotiable rules

1. **Loopback only** (`127.0.0.1`). Never bind `0.0.0.0` or expose port 8089 on LAN.
2. **Optional pairing token (default off)**: `/mcp` and `/admin/*` are open on loopback unless `keepwork.mcp.requireAuth` / `KEEPWORK_MCP_REQUIRE_AUTH=1` / `--require-auth`. Never log or commit `~/.keepwork-mcp/token`.
3. **Path confinement**: relative `run_terminal` cwd and `grep_files` paths must stay under workspace root (`src/core/paths.ts`); reject `..` and symlink escapes. Existing absolute paths (`C:\foo`, `/foo`, `~/foo`) are allowed (AIChat bound folders). Workspace `/fs/list|search|file|dir` confine relative paths lexically (`confineLexical`), include symlink/junction names, and may follow links inside that verified root. `GET /fs/file` without `links=include` uses realpath confinement (web-paracraft overlay).
4. **Never weaken the deny-list** in `src/core/terminal.ts` without explicit user request. AIChat must keep confirming every `run_terminal` call (`chat_agents.js` `local-mcp-terminal-confirm`).
5. **One daemon**: on `EADDRINUSE`, attach — never start a second HTTP server. Closing VS Code must **not** kill the daemon.
6. **Keep CommonJS** (`"module": "commonjs"`) so the VS Code extension loads; do not convert to ESM-only.
7. **AIChat is no-build ESM**: do not bundle `@modelcontextprotocol/sdk`; browser client is a thin Streamable HTTP client in `js/local_mcp.js`.
8. **Bump version after every modification** of product/runtime files before finishing:
   - `apps/aichat-rust`: sync `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`.
   - Shared `src/` or extension/MCP runtime: bump `package.json` + `package-lock.json` in `apps/vscode-extension` and `apps/mcp-runtime` (`node apps/vscode-extension/scripts/prepare-release-version.cjs`).
   - Standalone apps (`apps/local-helper`, `apps/aichat-desktop`, etc.): bump their `package.json` / `package-lock.json`. Keep root `package.json` at `"0.0.0"` (`private: true`).
   - `apps/mcp-rust`: bump `crates/keepwork-mcp/Cargo.toml` and sync `Cargo.lock` (independent version line).

## Client/server version compatibility

- **Standing requirement (2026-10-31)**: AIChat and Keepwork MCP ship independently. Every version pairing must work as well as shared capabilities permit; never require equal versions or reject older/newer/unknown peers.
- **Capability negotiation**: Negotiate via explicit capabilities/contracts, never version guesses. Missing optional capability = unavailable/unknown, not broken connection. Accept additive fields; preserve legacy defaults, fields, routes, events, and persisted data. Never relax Origin, auth, ownership, confinement, or approval checks.
- **Additive & honest**: Advertise a capability only when implemented. Never silently ignore requested semantics that change results (e.g. isolated context, auth, execution guarantees); use negotiated contracts or legacy adapters for breaking changes (e.g. advertise `taskContextVersion: 1` in persona snapshots while accepting ordinary messages without `contextMode`).
- **Feature-boundary degradation**: Use an equivalent fallback, or hide/disable/return a bounded feature error while keeping ordinary chat/tools working (no app-wide upgrade wall). Distinguish unsupported capability from offline/auth/permission/transient errors. Never claim a fallback preserves semantics when it does not; missing execution metadata = unknown, not zero/success. Preserve user data and pending-request identity across reconnects/upgrades/downgrades; never auto-replay uncertain mutations or resubmit with changed semantics; re-evaluate capabilities on peer change and clear unsupported selections.
- **Test matrix**: Test `new+old`, `old+new`, and `new+new` (missing/unknown fields, unsupported routes, reconnect/downgrade, unaffected paths). Report fixture limitations honestly.

## Layout (where to edit)

Root is a private shared-runtime package; manifests, entry points, tests, and builds belong under each app directory. `apps/vscode-extension` and `apps/local-helper` may import `src/core` / `src/mcp`; **apps must not import one another**. `apps/local-model-runtime` is an independent installer resource and must never enter the VSIX.

| Path | Role |
| --- | --- |
| `src/core/{paths,config}.ts` | Workspace root, confinement, port/token, `~/.keepwork-mcp/`, default cwd |
| `src/core/{terminal,terminalSessions,vscodeBridge}.ts` | Shell/VS Code bridge (deny-list, caps, queue); node-pty sessions; daemon→extension POST |
| `src/core/{grep,keepwork,modelStudioUpload}.ts` | `rg`/Node walk; Keepwork URL clone/open (VS Code commands only); Model Studio temp OSS relay |
| `src/core/{web,headless,html_text}.ts` | Public fetch, SSRF, search parsers; Edge/Chrome `--dump-dom`; HTML→text |
| `src/core/{paracraftLaunch,paracraftClients,webserverProxy,calendarReminders}.ts` | Windows protocol launch (no direct exe); Paracraft CLI hub (`/paracraft/*`); WASM wiki proxy; 7-day reminders |
| `src/core/{fsServe,folderBrowser}.ts` | File overlay + AIChat local-disk `/fs/*`; shallow read-only folder picker |
| `src/mcp/{server,http,sessions,stdio,apiDocs}.ts` | MCP tools; Streamable HTTP, CORS/PNA/auth, admin API; paged history; Cursor stdio; API catalog |
| `src/mcp/{paracraftTools,paracraftTemplates,paracraftJobResult,paracraftGuide}.ts` | Creation jobs, official wiki, fresh images, stdio forwarding; templates (`paracraft-template.test.cjs`); compact results (`paracraft-creation.test.cjs`); art skill root |
| `apps/vscode-extension/src/{cli,extension}.ts` | App-local `dist/cli.js` (`--stdio`, `--port`, `--root`); commands & spawn-or-attach |
| `apps/vscode-extension/src/vscode/{daemon,copilotMcp,statusBar,mcpPanel,terminalBridge,notifyBridge,secondBrain}.ts` | Daemon probe/spawn; native Copilot MCP; status bar/panel; terminal `/run` bridge; calendar notify; Second Brain webview |
| `apps/local-helper`, `apps/local-model-runtime` | Windows tray/startup/notify/updater/NSIS; Windows x64 local-model (`extraResources` only) |

## MCP surface

**Second Brain** (`apps/vscode-extension/src/vscode/secondBrain.ts`): right Secondary Side Bar (VS Code 1.106+), embeds `/chat` via `aichat.external-tool.v1` (optional Keepwork login). Dev Hosts serve local AIChat via `brainDevelopment.ts` (loopback, no-build, closes on disposal) with `/chat` fallback. Keep brain skills and workspace/profile ownership in AIChat (no copies or second registry). Test: `apps/vscode-extension/scripts/second-brain.test.cjs`; docs: `apps/vscode-extension/docs/second-brain.md`.

| MCP Tool | Notes |
| --- | --- |
| `run_terminal` | `command`, optional `cwd`/`timeoutMs`; VS Code Keepwork terminal when up else spawn; serialized per session; global cap 4 |
| `grep_files` | `pattern` (regex), optional `path`/`glob`/`maxMatches`; read-only |
| `mcp_status` | Root, port, pid, `rg` availability |
| `web_search` | `query`, optional `count`; Bing → DDG → Baidu HTML; minified JSON; no confirm |
| `fetch_url` | `url`, optional `maxChars`; Edge/Chrome dump-dom → structured text; static fallback; SSRF; minified JSON |

### HTTP endpoints

- `GET /`, `GET /dashboard`, `GET /admin/api-docs`: Dashboard (Overview, History, Clients, Paracrafts, API docs). Bundle timestamps from `scripts/runtime-build-info.mjs` (never startup/mtime; test `scripts/runtime-build-info.test.mjs`). Update `src/mcp/apiDocs.ts` when adding routes. Tests: `scripts/dashboard.test.cjs`, `scripts/dashboard-browser.test.cjs` (needs live dev daemon + Edge).
- `GET /health`: Public probe (`name: keepwork-mcp`, `requireAuth`, `workspaceRoot`, `paracraftClients`, `webserverBase`, `webservers`, `fsApi: "workspace"`, `terminalApi: "pty-session-v1"`, `folderBrowserApi: "folders-v1"`, `hostKind: local-helper|vscode-extension`, `hostVersion` Local Helper only, optional `desktopClient` omitted if exe missing). Never treat protocol `version` as an app/desktop version.
- `/terminal/sessions` (`POST`, `/:id/input`, `/:id/stream?cursor=` NDJSON, compat `/:id/output?cursor=`, `/:id/resize`, `/:id/interrupt`, `DELETE /:id`): User-operated PTY. Keep Origin/auth/ownership, verified cwd, output/concurrency caps, idle/disconnect/daemon-close cleanup. Raw input cannot use whole-command deny-list; never weaken `run_terminal`.
- `GET /exists?path=`: Public probe verifying absolute/`~` directory before `/fs/*`.
- `GET /fs/locations`, `GET /fs/browse?path=&hidden=1&filter=&offset=&limit=`: Read-only shallow folder picker (`folderBrowser.ts`, Origin/auth in `http.ts`, no native dialog/model tool). Test: `node --test scripts/folder-browser*.test.cjs`.
- `/fs/*` (`fsServe.ts`): `GET /fs/list` (`recursive=1` BFS, loop-aware, includes symlinks/junctions); `GET /fs/search` (case-insensitive substring, skips `node_modules`/`.git`, cap 8000); `GET /fs/stat`; `PUT /fs/dir`; `GET /fs/file` (raw bytes, extension MIME, **never** `charset=` so overlay `overrideMimeType(... charset=x-user-defined)` stays 1:1, optional `?base64=true`, `links=include` lexical confine, loopback, no token, `Cache-Control: no-store`); `PUT /fs/file`; `DELETE /fs/file` (file/symlink only); `DELETE /fs/dir` (recursive); `POST /fs/reveal` (`revealFileInOS` or OS file manager; optional `mode=open|dir`).
- `POST/GET/DELETE /mcp` (Streamable HTTP; Bearer if `requireAuth`); `GET /admin/status`, `GET /admin/history?offset=&limit=` (newest-first, default 20, max 50, `total`/`hasMore`), `POST /admin/stop` (token, loopback).
- **Paracraft CLI hub** (plain HTTP, loopback): Scans `127.0.0.1:8099-8115` (`/ajax/paracraft_cli?action=health`) to awaken desktop Paracraft. `POST /paracraft/register` (optional `nplPort` → `useNpl: true` if health pings; WASM gets `webparacraft1..N` + `webserverInstance/Root/Base`); non-NPL clients long-poll `POST /paracraft/:id/jobs/poll` (`waitMs` ≤ 10s, ~10ms wiki coalescing, 10s drop) and post `jobs/:jobId/result` or batch `jobs/results`. `GET /paracraft/clients` lists live desktop clients only (omits `platform=wasm`). `ALL /webserver/:instance/*` proxies external loopback WASM NPL wiki (`Keepwork-WebServer` cookie; embedded WebParaCraft uses direct ServiceWorker/page RPC). `GET /paracraft/:id/timeline`; `POST /paracraft/:id/:action` (`health|world_status|run_command|screenshot|camera_capture|open_world|exit|bring_to_front`; `camera_capture` uses world `eye`/`lookat` and never reuses/populates screenshot cache).
- **Calendar reminders**: `POST`/`GET /calendar/reminders` (loopback, `/paracraft/register` CORS, `~/.keepwork-mcp/calendar-reminders.json`). Fires at `remindAt` via notify bridge (**打开日历** → `openExternal` only for `http(s)` `keepwork.com`/`localhost`/`127.0.0.1`; retries every 15s if VS Code closed).

**Settings**: `keepwork.mcp.{enableHttp,port,workspaceRoot,requireAuth}` (default auth `false`), `keepwork.mcp.connectCopilot` (default `true`).
**Copilot MCP**: Registers `keepwork.mcp` on activation (starts/attaches & reads auth only on resolve); never writes user/workspace MCP config or overrides trust/permissions; older editors without MCP API must still activate. `contributes.chatSkills` → packaged `dist/skills/paracraft-create/SKILL.md` (keep relative guides in VSIX). Verify: `npm run compile:only --prefix apps/vscode-extension && npm test --prefix apps/vscode-extension`.
**Root resolution** (first match): `--root` → `KEEPWORK_MCP_ROOT` → VS Code setting → `~/.keepwork-mcp/config.json` → `~/.keepwork-mcp/workspace` (`defaultUserWorkspace()`, auto-created with `default` / `[workspacename]`; never open VS Code folder).
**Commands**: `keepwork.openMcpWorkspace`, `keepwork.changeMcpWorkspace`, `keepwork.showMcpTerminal`.

## Common workflows

### Rust desktop release tags (`apps/aichat-rust`)

- **Standing (2026-11-13)**: New `apps/aichat-rust` releases use standard `v<major>.<minor>.<patch>` tags (e.g. `v0.2.112`) matching all 4 manifests. Never create new `aichat-rust-v*` tags; preserve historical `aichat-rust-v*` tags/Releases/URLs and legacy rerun support (never rename/delete/recreate). Applies only to `apps/aichat-rust` (extension keeps `keepwork-v*`).
- **Standing (2026-11-21)**: Every published macOS DMG must be signed with Paracraft Developer ID Application (team `5QLPT4C3EB`), notarized by Apple, stapled, and validated; verify source, size, and SHA-256 post-stapling per [.github/skills/rust-release/SKILL.md](.github/skills/rust-release/SKILL.md#macos-universal-dmg-本机签名与公证).
- Single release workflow: `.github/workflows/aichat-rust-windows-release.yml` (`rust-desktop-validation.yml` for PRs). For `rust-release`, download desktop & MCP artifacts locally via `http://127.0.0.1:7890` and publish to Qiniu via [.github/skills/rust-release](.github/skills/rust-release/SKILL.md); GitHub builds must not publish CDN assets or expose Releases before local verification. Docs: [apps/aichat-rust/README.md](apps/aichat-rust/README.md#github-release-与-cdn-下载地址).

### NodeRuntime CDN release

- `apps/mcp-runtime` ([README](apps/mcp-runtime/README.md)) owns staging/packaging/metadata; `.github/workflows/mcp-node-runtime.yml` builds Win x64 & macOS arm64/x64 on `main` push/dispatch and publishes to `keepwork/mcp-runtime/`.
- Require all 3 extracted-archive smoke tests; preserve native PTY & macOS exec modes; never mutate versions in CI. Publish 6 fixed objects (`windows-x64`, `macos-arm64`, `macos-x64` `.zip`/`.json` with version/commit/builtAt/size/SHA-256): serialize publishers, check remote `main`, overwrite+verify all 3 ZIPs before all 3 JSONs. Contract: [docs/node-runtime-cdn.md](docs/node-runtime-cdn.md); shared Qiniu lib: `scripts/lib/qiniu-release.cjs`.
- Validate: `node --test apps/mcp-runtime/scripts/*.test.cjs apps/local-helper/scripts/publish-qiniu-release.test.cjs` + native smoke tests.

### Rust MCP daemon (`apps/mcp-rust`)

- Contract & phase gates: [docs/rust-runtime-migration.md](docs/rust-runtime-migration.md). Cargo workspace is `apps/mcp-rust/crates/keepwork-mcp` (never add root `Cargo.toml`; enforced by `scripts/check-layout.cjs`).
- Verify wire compatibility: `npm run check:rust` and `npm run test:contract` (`scripts/contract/*.test.cjs`). Advertise `/health` capabilities only when implemented.
- P1: lifecycle, CORS/auth, `/health`, `/exists`, full `/fs/*` (incl. `locations|browse`), PTY `/terminal/*`, `/admin/status|stop`, MCP handshake, 5 portable tools. Leave agents/messaging/personas/browser/computer/paracraft unadvertised until contract-tested.

### Extension development

```bash
npm ci && npm ci --prefix apps/vscode-extension
npm run compile:only --prefix apps/vscode-extension
npm start --prefix apps/vscode-extension   # HTTP daemon :8089
npm run mcp --prefix apps/vscode-extension # stdio MCP for Cursor
```

### Visual Studio Marketplace release

- Use `scripts/publish-marketplace.ps1` (or VS Code task **Keepwork: Publish Latest VSIX (Entra)**) for `Xizhi.keepwork`. Validates VSIX, promotes stable MCP (Win x64 + macOS arm64/x64), then publishes shared Desktop ZIP & signed manifest (verify `desktop-code` job). Manual portal uploads require `keepwork-stable.yml` dispatch with exact `marketplace_version`.
- Auth: Entra ID (`@vscode/vsce --azure-credential`); never store PATs/tokens/credentials in files, chat, logs, or args. Identity must be Publisher Contributor/Owner (`az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv`). On Windows use WAM `az login --tenant <id> --allow-no-subscriptions` (no device code on `AADSTS530035`); CI uses workload identity federation + managed identity.
- `npm run package --prefix apps/vscode-extension` allocates one patch above both MCP & extension manifests, syncs lockfiles, and outputs `keepwork-<version>.vsix`. Publish the existing VSIX without rebuilding, bumping, committing, or tagging (commit/push only on user request). On timeout, temporarily clear `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (upper+lower) around `vsce.cmd publish --azure-credential --packagePath ...` and restore in `finally`. Verify `DONE Published Xizhi.keepwork v<version>` and public page.

### Debug the HTTP MCP server without the extension

- Run `npm run dev:server --prefix apps/vscode-extension` (task **Keepwork MCP: Dev Server (8089)**): watch-rebuilds `dist/cli.js`, restarts `:8089` (stopping an existing process only if `/health` identifies `keepwork-mcp`), and serves `skills/paracraft-create/` live (check via `paracraft_cli` `skill`, `/paracraft/authoring`, [local-development.md](skills/paracraft-create/references/local-development.md)). Probe `/health` and `/admin/status`.
- Extension Host (F5 in `apps/vscode-extension`): spawns `:8089` if free; replaces older Keepwork MCP PID only when `runtimeVersion` is newer (never compare protocol `version` or downgrade). Test: `node --test apps/vscode-extension/scripts/daemon.test.cjs apps/aichat-desktop/tests/runtime.test.cjs`.
- Cursor stdio (does not replace HTTP daemon): `{"mcpServers":{"keepwork":{"command":"node","args":["c:/lxzsrc/keepworkExtension/apps/vscode-extension/dist/cli.js","--stdio"],"env":{"KEEPWORK_MCP_ROOT":"C:/Users/you/.keepwork-mcp/workspace"}}}}`.

## Related trees (outside this repo)

| Path | Use |
| --- | --- |
| `c:/lxzsrc/maisi/maisi/maisi/webgames/tools/AIChat/js/local_mcp.js` | Browser MCP client + composer pill (`docs/local-mcp.md` for pairing) |
| `c:/lxzsrc/webparacraft` | Local web-paracraft (`?searchroot=&searchpath=` overlays git via `/fs/*`) |
| `c:/lxzsrc/ParacraftMaker` | Sibling Maker MCP (stdio + Agent Bridge `:18300`, separate port) |

## When changing behavior

- **macOS computer use** (`src/core/computerMac.ts`): experimental, built-in OS commands only, session-bound native consent (24h absolute expiry, no idle timeout), Escape/top-left stop checks before actions, no reclaim panel, no scroll/right-click; normalize screenshots to screen points; preserve argument-only data & explicit unsupported errors. Test: `node --test scripts/computer-mac.test.cjs`.
- **Explicit screenshots** (`src/core/{desktopCapture,screenshotPermission,petPermissionBridge}.ts`, `src/pet`, `apps/pet-companion`): pet-bubble approval (no deadline), revocable remembered screenshot-only approval in AIChat/dashboard; never grant input control from screenshot approval. Test: `node --test scripts/screenshot-permission.test.cjs scripts/screenshot-http.test.cjs` & `node scripts/pet-permission-native.cjs`.
- **Windows computer use** (`src/core/{computer,computerOverlay}.ts`, `src/mcp/computerTools.ts`; AIChat `js/local_mcp.js`, `js/computer_tools.js`): primary screen only, revocable session-bound consent (2-min idle expiry), no input queue/model scripts, capture-excluded non-activating Take Back Control overlay, renewed consent after revocation, non-retrying calls. Test: `node --test scripts/computer.test.cjs`; docs: [docs/computer-use.md](docs/computer-use.md).
- **New MCP tool**: update `src/mcp/server.ts`, AIChat `KEEPWORK_TOOL_NAMES` / chip labels in `chat_render.js`, README, and this file.
- **Paracraft CLI / wiki / art skill**: keep register/poll open on loopback, never log screenshot base64 ([docs/paracraft-cli.md](docs/paracraft-cli.md); engine: paraworld `docs/aries/paracraft-cli.md`). `read_official_wiki` via `paracraft_cli` forwards `{path}` unchanged to engine registry without duplicating manuals here (`scripts/paracraft-scene.test.cjs`). Canonical art skill lives in `skills/paracraft-create/` (root resource only in `paracraftGuide.ts`, guides on demand via `skill`, copied to `dist/skills/` in packages; `scripts/paracraft-guide.test.cjs`).
- **CORS / Local Helper / Model Studio**:
  - Keep CORS/PNA/token in `src/mcp/http.ts` only (tight `keepwork.com`/localhost allowlist).
  - Local Helper owns only tray/lifecycle/update/installer; build Windows `node-pty` on Windows, keep native files unpacked, never commit signing credentials.
  - Model Studio temp uploads (`modelStudioUpload.ts`, gated in `http.ts`, documented in `apiDocs.ts`): separate daemon Bearer auth from `X-DashScope-Api-Key`, never forward keys to OSS, keep HTTPS allowlist/body caps/redirect rejection/stream cancel (HTTP upload only, not MCP tool/proxy). Test: `node --test scripts/model-studio-upload.test.cjs`.
- **`apps/aichat-rust` invariants**:
  - **Navigation & popups** (`src-tauri/src/security.rs`): use `allowed_navigation` (never path-exact `trusted_page`) in `on_navigation` so iframe tool pages (`keepwork.com`, `https://cdn.keepwork.com`, exact dev-source origin, WeChat QR `open.weixin.qq.com/connect/*`) load in-app while other hosts/credentialed URLs go to system browser. `external_url` must drop URLs with `token`/`access_token`/`id_token`/`authorization`. `on_new_window` uses `allowed_in_app_popup` for login providers (Google/Feishu/Lark/DingTalk) and keepwork `/sso|/chat|/login` (never expose `aichatDesktop` to popups). Keep `trusted_page` strict for bridge/media/entry. Test: `cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins` & `node --test apps/aichat-rust/tests/*.test.cjs`.
  - **Selection guard** (`bridge.rs`): `user-select:none` on chrome, `text` only on inputs/contenteditable/`.chat-msg-bubble`/`.md-body`/`pre/code`; suppress capture-phase `contextmenu` outside copyable regions while preserving message copy and composer edit menu.
  - **Pet drag** (`src/pet.ts`, `pet.rs`): send `screenX`/`screenY` in `drag-start`, apply `drag` snapshots via `positionLayers()`, keep clamp/persistence in `pet.rs`. Position sprite via composited `translate3d` (not `left`/`top`) and drop shadow filter during `body.dragging` (avoids WKWebView ghost trails). Keep pet canvas on one monitor (move window per monitor on mixed-DPI displays). Preserve 4px click threshold & single/double/right-click semantics.
  - **MCP runtime default**: Default dev & packaging must run `apps/mcp-rust`; Node is explicit-only (`dev:node` / `AICHAT_MCP_ENGINE=node`); never revert default to Node for unported optional features. Node CDN manifests use `macos`/`windows` (`mcp_feed_platform`); desktop client feed keeps `darwin`/`win32` (`current_runtime_platform`). Bootstrap: bundled `Contents/Resources/mcp-runtime` → DesktopLauncher → CDN; start daemon before webview's first `/health` probe. Never rename desktop feed paths.
  - **Remote ACL** (`capabilities/default.json` & `src-tauri/permissions/desktop-commands.toml`): keep `https://keepwork.com/*`, `https://keepwork.com/chat*`, and `https://cdn.keepwork.com/*`; add every `generate_handler!` command to `allow-desktop-commands`; never widen window labels or `trusted_page`.

## Agent CLI adapters & maintenance

- **Copilot VS Code custom models** (`src/core/{copilotHarness,vscodeModels}.ts`, `apps/vscode-extension/src/vscode/modelBridge.ts`): native CLI models stay on ACP; custom models need BYOK Copilot CLI + open editor, keep keys in VS Code, and use a separate authenticated loopback bridge (never terminal credential). Test: `node --test scripts/copilot-model-bridge.test.cjs apps/vscode-extension/scripts/model-bridge.test.cjs`.
- **Owned `/agents` surface** (`src/core/agentSessions.ts`, `src/mcp/agentHttp.ts`, `agentCliBackends.ts`):
  - `codexHarness` → Codex; `acpHarness` → WorkBuddy (CodeBuddy ACP), Copilot, Cursor, Qwen, Kimi, OpenCode.
  - `traeHarness` → open-source Trae Agent (`trae-cli run`, key `trae`; not proprietary `traecli` ACP).
  - `antigravityHarness` → native `agy` stream-json under key `gemini` (legacy Gemini ACP history read-only; Win `%LOCALAPPDATA%/agy/bin`; override `KEEPWORK_ANTIGRAVITY_PATH`; test `node --test scripts/antigravity-harness.test.cjs`).
  - `claudeHarness` → Claude native stream-json.
  - Preserve backend-scoped routing, native credentials, non-replaying restart, local-only transcripts, Origin/owner/auth checks.
- **Skills & maintenance**: `skills/agent-cli-verify/SKILL.md` is packaged for both products; its MCP resources are opt-in via `ServerRuntime.includeSetupGuides` only (never advertised in normal HTTP/stdio); runtime install guides live in `skills/agent-cli-verify/references/providers/`. For CLI recipes/discovery/upkeep, read [.github/skills/agent-cli-maintenance/SKILL.md](.github/skills/agent-cli-maintenance/SKILL.md) + `references/providers/<backend>.md` (dev-only; never register as user-facing product skills). Docs: `docs/agent-harnesses.md`.
- **Tests**: `npm run check:shared`, `node --test scripts/agent-sessions.test.cjs scripts/agent-backends.test.cjs scripts/agent-cli-discovery.test.cjs scripts/claude-harness.test.cjs`, real smoke `node scripts/agent-cli-smoke.cjs` (never report unavailable/untested CLIs as passing).
