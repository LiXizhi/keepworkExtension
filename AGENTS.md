# AGENTS.md — Keepwork Extension (`keepwork-mcp`)

Instructions for AI agents working **in this repository**. Product overview:
[README.md](README.md).

## What this repo is

- **VS Code / Cursor extension** (`keepwork`) plus a **singleton local MCP daemon**
- **Path**: `c:/lxzsrc/keepworkExtension` (GitHub `LiXizhi/keepworkExtension`)
- **Job**: (1) clone Keepwork git repos and open files on keepwork.com;
  (2) expose `run_terminal` / `grep_files` / `mcp_status` so the **AIChat website**
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
3. **Path confinement**: `run_terminal` cwd and `grep_files` paths must stay under the workspace root (`src/core/paths.ts`). Reject `..` and symlink escapes.
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
| `src/core/vscodeBridge.ts` | Daemon client: POST to the extension terminal bridge |
| `src/vscode/terminalBridge.ts` | Extension host: reuse Keepwork integrated terminal + `/run` loopback |
| `src/core/grep.ts` | `rg` if present, else Node walk |
| `src/core/keepwork.ts` | Keepwork URL → git clone URL / open-in-browser URL |
| `src/core/paracraftClients.ts` | Desktop Paracraft CLI registry + job queue (`/paracraft/*`) |
| `src/mcp/server.ts` | MCP tool registration (`run_terminal`, `grep_files`, `mcp_status`) |
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

HTTP:

- `GET /health` — public probe (`name: keepwork-mcp`, `requireAuth`, `workspaceRoot`, `paracraftClients`)
- `POST/GET/DELETE /mcp` — Streamable HTTP; Bearer token only if `requireAuth`
- `GET /admin/status`, `GET /admin/history?offset=&limit=`, `POST /admin/stop` — token, loopback
  (`/admin/history` returns one newest-first page, default `limit=20`, max 50; includes `total` / `hasMore`)
- Paracraft CLI hub (plain HTTP, not MCP):
  - `POST /paracraft/register` — desktop client identity (open on loopback)
  - `POST /paracraft/:id/jobs/poll` — long-poll jobs (`waitMs`)
  - `POST /paracraft/:id/jobs/:jobId/result` — job result
  - `GET /paracraft/clients` — live desktop clients (Bearer if `requireAuth`)
  - `POST /paracraft/:id/:action` — enqueue `health` / `world_status` / `run_command` / `screenshot` / `open_world`

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
| `c:/lxzsrc/ParacraftMaker` | Sibling Maker MCP (stdio + Agent Bridge `:18300`, not this port) |

## When changing behavior

- New MCP tool → `src/mcp/server.ts` + AIChat `LOCAL_MCP_NAMES` / chip labels in `chat_render.js` + README + this file.
- Paracraft CLI hub → `src/core/paracraftClients.ts` + `/paracraft/*` in `src/mcp/http.ts`; keep register/poll open on loopback; never log screenshot base64.
- Security / CORS / PNA / token → `src/mcp/http.ts` only; keep origin allowlist tight (`keepwork.com`, localhost).
- Terminal policy → `src/core/terminal.ts` (deny-list, timeout, output cap) and keep AIChat confirm in `chat_agents.js` (`local-mcp-terminal-confirm`).
- Singleton / status bar → `src/vscode/daemon.ts` + `statusBar.ts` + `mcpPanel.ts`; do not move the HTTP listener into the extension host. The VS Code terminal bridge (`src/vscode/terminalBridge.ts`) is a separate loopback helper.
- Default working directory parent → `~/.keepwork-mcp/workspace` via `src/core/config.ts` `defaultUserWorkspace()`. Slots: `default` (no AIChat workspace) and `[workspacename]`. Do not default to the open VS Code folder.
- Keepwork clone/open URL rules → `src/core/keepwork.ts` (VS Code commands only in v1; not MCP tools).
