# AGENTS.md — Keepwork Extension (`keepwork-mcp`)

Instructions for AI agents working **in this repository**. Product overview:
[README.md](README.md).

## What this repo is

- **VS Code / Cursor extension** (`keepwork`) plus a **singleton local MCP daemon**
- **Path**: `c:/lxzsrc/keepworkExtension` (GitHub `LiXizhi/keepworkExtension`)
- **Job**: (1) clone Keepwork git repos and open files on keepwork.com;
  (2) expose `run_terminal` / `grep_files` / `mcp_status` / `web_search` / `fetch_url` so the **AIChat website**
  (`https://keepwork.com/chat`) can drive the user's local disk — something the
  browser cannot do on its own.

The HTTP MCP listener is **not** inside the extension host. It is a detached
`node out/cli.js` process on **`http://127.0.0.1:8089`**. Many VS Code windows
spawn-or-attach; many AIChat tabs share one daemon (one MCP session each).

`run_terminal` prefers the VS Code **Keepwork** integrated terminal when the
extension is active (loopback bridge in `~/.keepwork-mcp/terminal-bridge.json`).
The MCP HTTP server stays in the daemon. Closing a window must **not** kill the
daemon; it may drop the terminal bridge (next command falls back to spawn).

## Non-negotiable rules

1. **Bind loopback only** (`127.0.0.1`). Never listen on `0.0.0.0` or expose port 8089 on the LAN.
2. **Pairing token is optional (default off).** `/mcp` and `/admin/*` are open on loopback unless `keepwork.mcp.requireAuth` / `KEEPWORK_MCP_REQUIRE_AUTH=1` / `--require-auth`. When auth is on, do not log or commit `~/.keepwork-mcp/token`.
3. **Path confinement**: relative `run_terminal` cwd and `grep_files` paths must stay under the workspace root (`src/core/paths.ts`). Reject `..` and symlink escapes. Absolute disk paths (`C:\foo`, `/foo`, `~/foo`) are allowed when the directory exists — AIChat uses these for a bound local folder. Workspace `/fs/list` `/fs/search` `/fs/file` `/fs/dir` (AIChat local disk) confine the *requested* relative path lexically (`confineLexical`); they include symlink/junction names and may follow a link that lives inside that verified root. `GET /fs/file` without `links=include` still uses realpath confinement for the web-paracraft overlay.
4. **Do not weaken the deny-list** in `src/core/terminal.ts` without an explicit user request. AIChat must keep confirming every `run_terminal` call.
5. **One daemon**: if `listen` throws `EADDRINUSE`, attach — do not start a second HTTP server. Closing a VS Code window must **not** kill the daemon.
6. Keep CommonJS (`"module": "commonjs"`) so the VS Code extension still loads. Do not convert the package to ESM-only.
7. AIChat is a **no-build ES module app** — do not bundle `@modelcontextprotocol/sdk` into it. The browser client is a thin Streamable HTTP client in `js/local_mcp.js`.

## Layout (where to edit)

| Path | Role |
|------|------|
| `src/core/paths.ts` | Workspace root + confine paths |
| `src/core/config.ts` | Port, token, `~/.keepwork-mcp/` instance file, default user workspace |
| `src/core/terminal.ts` | Shell spawn / VS Code terminal bridge, timeout, output cap, deny-list, per-session queue |
| `src/core/terminalSessions.ts` | User-operated node-pty sessions, raw input/output, resize, ownership, caps, idle cleanup |
| `src/core/vscodeBridge.ts` | Daemon client: POST to the extension terminal bridge |
| `src/vscode/terminalBridge.ts` | Extension host: reuse Keepwork integrated terminal + `/run` loopback |
| `src/vscode/notifyBridge.ts` | Extension host: calendar OS/VS Code notifications + open AIChat |
| `src/core/grep.ts` | `rg` if present, else Node walk |
| `src/core/web.ts` | Public http(s) fetch, SSRF checks, search-engine HTML parsers, compact JSON |
| `src/core/headless.ts` | System Edge/Chrome `--dump-dom` for `fetch_url` |
| `src/core/html_text.ts` | Structured HTML → text (headings/lists; never markup) |
| `src/core/keepwork.ts` | Keepwork URL → git clone URL / open-in-browser URL |
| `src/core/paracraftClients.ts` | Desktop Paracraft CLI registry + job queue (`/paracraft/*`) |
| `src/core/webserverProxy.ts` | WASM NPL code wiki front (`/webserver/:instance/*`) |
| `src/core/calendarReminders.ts` | AIChat calendar 7-day reminders (`/calendar/reminders`) |
| `src/core/fsServe.ts` | Loopback file overlay (`GET /fs/file`) + AIChat local-disk workspace (`/fs/list` `/fs/search` `/fs/stat` PUT/DELETE) |
| `src/mcp/server.ts` | MCP tool registration (`run_terminal`, `grep_files`, `mcp_status`, `web_search`, `fetch_url`) |
| `src/mcp/http.ts` | Streamable HTTP, CORS/PNA, session map, admin API |
| `src/mcp/sessions.ts` | Connected clients + in-memory call history (paged list) |
| `src/mcp/stdio.ts` | stdio transport for Cursor (does not take 8089) |
| `src/cli.ts` | `node out/cli.js` (`--stdio`, `--port`, `--root`) |
| `src/extension.ts` | VS Code commands + activate spawn-or-attach |
| `src/vscode/daemon.ts` | Health probe, detached spawn, admin fetch |
| `src/vscode/statusBar.ts` | Status bar text / tooltip |
| `src/vscode/mcpPanel.ts` | Click panel: clients + paged history + working directory / terminal |

AIChat client (outside this repo): `c:/lxzsrc/maisi/maisi/maisi/webgames/tools/AIChat/js/local_mcp.js`.

## MCP surface

| Tool | Notes |
|------|--------|
| `run_terminal` | `command`, optional `cwd` / `timeoutMs`; VS Code Keepwork terminal when the extension is up, else spawn; serialized per session; global cap 4 |
| `grep_files` | `pattern` (regex), optional `path` / `glob` / `maxMatches`; read-only |
| `mcp_status` | Root, port, pid, whether `rg` is on PATH |
| `web_search` | `query`, optional `count`; Bing → DDG → Baidu HTML; minified JSON results; no confirm |
| `fetch_url` | `url`, optional `maxChars`; Edge/Chrome dump-dom then structured text; static HTML fallback; SSRF; minified JSON |

HTTP:

- `GET /health` — public probe (`name: keepwork-mcp`, `requireAuth`, `workspaceRoot`, `paracraftClients`, `webserverBase`, `webservers` as `{ instance, root }[]`, `fsApi: "workspace"` when list/write/delete are available)
- `GET /health` also reports `terminalApi: "pty-session-v1"` when the user-operated PTY API is available.
- `POST /terminal/sessions`, `POST /terminal/sessions/:id/input`, `GET /terminal/sessions/:id/stream?cursor=` (long-lived NDJSON output with cursor replay), compatibility `GET /terminal/sessions/:id/output?cursor=`, `POST /terminal/sessions/:id/resize`, `POST /terminal/sessions/:id/interrupt`, `DELETE /terminal/sessions/:id` — direct AIChat workspace PTY. Keep Origin/auth ownership, verified cwd, bounded output/concurrency, idle cleanup, stream disconnect cleanup, and daemon-close cleanup. Raw user input cannot use whole-command deny-list parsing; do not weaken the separate model-operated `run_terminal` confirmation or deny-list.
- `GET /exists?path=` — public probe: does this absolute/`~` path exist as a directory (AIChat must verify a user-typed local workspace root before `/fs/*`)
- `GET /fs/list?root=&path=&max=` — directory listing; includes symbolic links / junctions. `recursive=1` returns file paths (BFS, loop-aware, capped)
- `GET /fs/search?root=&path=&q=&max=` — filename substring search (case-insensitive); includes symlink/junction names, skips `node_modules` / `.git`, loop-aware, scan cap 8000
- `GET /fs/stat?root=&path=` — `{ exists, isFile, isDirectory, symlink, size }`
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
  - `POST /paracraft/:id/:action` — `health` / `world_status` / `run_command` / `screenshot` / `open_world` / `exit` / `bring_to_front`
- Calendar reminders (plain HTTP, loopback, same CORS as `/paracraft/register`):
  - `POST /calendar/reminders` — replace the next 7-day reminder set `{ events: [{ id, title, start, remindAt, openUrl }], horizonDays }`
  - `GET /calendar/reminders` — inspect the stored set
  - Persist `~/.keepwork-mcp/calendar-reminders.json`. Daemon timers fire at `remindAt`; the extension notify bridge shows `showInformationMessage` with **打开日历** → `openExternal(openUrl)` (`http(s)` keepwork.com / localhost / 127.0.0.1 only). If VS Code is closed, due items retry every 15s until the bridge is up.

Settings: `keepwork.mcp.enableHttp` / `keepwork.mcp.port` / `keepwork.mcp.workspaceRoot` / `keepwork.mcp.requireAuth` (default false).

Root resolution (first match): `--root` / `KEEPWORK_MCP_ROOT` / VS Code setting / `~/.keepwork-mcp/config.json` / `~/.keepwork-mcp/workspace` (created automatically, with a `default` slot). Not the open VS Code folder. AIChat cwd is `workspace/default` or `workspace/[workspacename]`.

Commands: `keepwork.openMcpWorkspace`, `keepwork.changeMcpWorkspace`, `keepwork.showMcpTerminal`.

## Common workflows

```bash
cd c:/lxzsrc/keepworkExtension
npm install
npm run compile
npm start                          # HTTP daemon :8089
npm run mcp                        # stdio MCP for Cursor
```

### Visual Studio Marketplace release

- Marketplace identity: `Xizhi.keepwork`; public page: `https://marketplace.visualstudio.com/items?itemName=Xizhi.keepwork`.
- Prefer Microsoft Entra ID via `@vscode/vsce --azure-credential`; do not put PATs, access tokens, or Azure credentials in repository files, chat, logs, or command arguments.
- The Entra identity must be a **Contributor** (or Owner) of Marketplace publisher `Xizhi` and must have permission to modify the existing `keepwork` extension. When authorization fails, retrieve the profile ID with `az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv`, then add that identity in publisher management.
- On Windows, use normal `az login --tenant <tenant-id> --allow-no-subscriptions` so Web Account Manager can satisfy MFA and Security Defaults. Do not use device-code login when the tenant blocks device code with `AADSTS530035`.
- `npm run compile` and `npm run package` both run `npm version patch --no-git-tag-version`; they mutate `package.json` and `package-lock.json`. Do not invoke either merely to validate an already-built release, and never run them twice for the same intended version. Use `npm run compile:only` for a non-versioning type check.
- `npm run package` creates `keepwork-<version>.vsix`. Before publishing, verify that the manifest version and VSIX filename match the intended release.
- Publish the existing artifact without another build or version bump:

  ```powershell
  $env:PATH = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin;' + $env:PATH
  .\node_modules\.bin\vsce.cmd publish --azure-credential --packagePath .\keepwork-<version>.vsix
  ```

- The explicit PATH prefix is needed only when Azure CLI was installed after the current VS Code process started; a restarted VS Code should inherit it normally.
- A successful release prints `DONE Published Xizhi.keepwork v<version>`. Verify the public Marketplace page; allow several minutes for propagation.
- Publishing an existing VSIX must not change source, increment versions, create commits, or create tags. Do not commit or push release changes unless the user explicitly requests it.
- For unattended CI releases, use Microsoft's workload identity federation plus managed identity flow and add that managed identity as a Publisher Contributor. Do not persist an interactive Azure CLI session as CI authentication.

### Debug the HTTP MCP server without the extension

Run the VS Code task **Keepwork MCP: Dev Server (8089)**, or start the same workflow from a terminal:

```bash
npm run dev:server
```

This compiles TypeScript in watch mode and runs `out/cli.js` on `127.0.0.1:8089`. After every successful source rebuild, it restarts the MCP daemon automatically; compilation failures leave the last working daemon running. On startup it stops an existing daemon only when `/health` identifies it as `keepwork-mcp`, so it will not replace an unrelated service using port 8089. Stop the task with Ctrl+C.

Use `http://127.0.0.1:8089/health` to verify the listener and `http://127.0.0.1:8089/admin/status` to inspect the PID, workspace root, clients, and auth state. This workflow is for debugging the MCP HTTP server and AIChat integration without publishing the extension, pressing F5, or reloading an Extension Development Host.

F5 **Run Extension** in this folder: on `onStartupFinished` the extension probes `:8089` and spawns the CLI if free. Status bar **Keepwork MCP** → click for clients/history.

Cursor stdio (does not replace the HTTP daemon AIChat needs):

```json
{
  "mcpServers": {
    "keepwork": {
      "command": "node",
      "args": ["c:/lxzsrc/keepworkExtension/out/cli.js", "--stdio"],
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

- New MCP tool → `src/mcp/server.ts` + AIChat `KEEPWORK_TOOL_NAMES` / chip labels in `chat_render.js` + README + this file.
- Paracraft CLI hub → `src/core/paracraftClients.ts` + `/paracraft/*` in `src/mcp/http.ts`; keep register/poll open on loopback; never log screenshot base64. Narrative: [docs/paracraft-cli.md](docs/paracraft-cli.md).
- External WASM NPL code wiki gateway → `src/core/webserverProxy.ts` (`/webserver/:instance/*`); register `webserverRoot`; `GET /health` `webserverBase`. The embedded wiki bridge lives in webparacraft `ServiceWorker.js` + `src/emscripten.js`. Same [docs/paracraft-cli.md](docs/paracraft-cli.md); engine: paraworld `docs/aries/paracraft-cli.md`.
- Web-paracraft local script overlay → `src/core/fsServe.ts` (`GET /fs/file`); confine to the URL `root` with realpath; MIME from file extension (text vs binary; unknown as `application/octet-stream`); never append `charset=` — overlay uses `overrideMimeType(... charset=x-user-defined)` so bytes stay 1:1. Optional `?base64=true` JSON is supported but unused by the overlay.
- AIChat local-disk workspace → same `src/core/fsServe.ts` (`/fs/list` `/fs/search` `/fs/stat` `PUT/DELETE /fs/file` `DELETE /fs/dir`); verify `root` with `inspectDiskPath` / `GET /exists`; include symlink names; lexical confine + `links=include` on read.
- Security / CORS / PNA / token → `src/mcp/http.ts` only; keep origin allowlist tight (`keepwork.com`, localhost).
- Terminal policy → `src/core/terminal.ts` (deny-list, timeout, output cap) and keep AIChat confirm in `chat_agents.js` (`local-mcp-terminal-confirm`).
- Singleton / status bar → `src/vscode/daemon.ts` + `statusBar.ts` + `mcpPanel.ts`; do not move the HTTP listener into the extension host. The VS Code terminal bridge (`src/vscode/terminalBridge.ts`) is a separate loopback helper.
- Default working directory parent → `~/.keepwork-mcp/workspace` via `src/core/config.ts` `defaultUserWorkspace()`. Slots: `default` (no AIChat workspace) and `[workspacename]`. Do not default to the open VS Code folder.
- Keepwork clone/open URL rules → `src/core/keepwork.ts` (VS Code commands only in v1; not MCP tools).
