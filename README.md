# Keepwork Extension for VS Code

Clone projects from Keepwork, open files on keepwork.com, and run a **local MCP daemon** so [AIChat](https://keepwork.com/chat) can execute terminal commands and grep on this machine.

## Features

### Clone Repository from Keepwork
1. Press `Ctrl+Shift+P` → **Keepwork: Clone Repository**
2. Enter a Keepwork URL (e.g. `https://keepwork.com/{owner}/{repo}/...`)
3. The repository is cloned via VS Code's built-in Git (`https://git.keepwork.com/{owner}/{repo}`)

### Open in Keepwork
1. Right-click a file in the Explorer
2. Select **Open in Keepwork**

### Local MCP server (AIChat)

The extension starts **at most one** daemon on `http://127.0.0.1:8089`, even if many VS Code windows are open. Extra windows attach to the same process. Closing a window does **not** stop the daemon (AIChat tabs may still be using it).

Status bar: `Keepwork MCP` (plus client count). Hover for a summary; click for clients and call history (paged; the panel does not load the full log at once).

**Tools**

| Tool | Purpose |
|------|---------|
| `run_terminal` | Run a shell command under the workspace root (AIChat asks you to confirm) |
| `grep_files` | Search file contents under the root |
| `mcp_status` | Report root, port, pid, ripgrep |
| `web_search` | Search the public web from this machine; returns minified JSON (`title` / `url` / `snippet`) |
| `fetch_url` | Fetch one public http(s) page, render HTML in local Edge/Chrome when possible, extract structured text as minified JSON |

`GET /health` includes `workspaceRoot` so AIChat can map cloud workspace slots onto a cwd relative to that root. It also reports `paracraftClients` when desktop Paracraft processes have registered, `webserverBase` (`http://127.0.0.1:<port>/webserver`) so web-paracraft can bind the NPL code wiki, and `fsApi: "workspace"` when local-disk list/write/delete are available. `GET /exists?path=` checks that a typed local absolute path exists; AIChat must verify that path before using `/fs/*`. `run_terminal` accepts that path as `cwd` so a bound local disk folder does not fall back to `workspace/<foldername>`. AIChat local-disk `list_dir` / `search_files` / `read_file` / writes use `/fs/list`, `/fs/search`, `/fs/file`, `/fs/dir` (includes symbolic links and junctions). Local web-paracraft can overlay git files with `?searchroot=<abs>&searchpath=<rel>` via `GET /fs/file` (one file per request, **raw on-disk bytes**, MIME from the extension, no `charset=` — same API as a normal file URL; optional `?base64=true` JSON is unused by the overlay; loopback, confined to that root).

`GET /health` also reports `terminalApi: "pty-session-v1"`. AIChat uses this capability for its user-operated xterm.js workspace Terminal tab; it is not registered as another LLM MCP tool:

- `POST /terminal/sessions` — create a PTY in `{ cwd, cols, rows }`
- `POST /terminal/sessions/:id/input` — write raw keyboard/input data
- `GET /terminal/sessions/:id/stream?cursor=` — keep one NDJSON response open for incremental PTY output, with cursor replay on reconnect
- `GET /terminal/sessions/:id/output?cursor=` — compatibility endpoint for bounded incremental polling
- `POST /terminal/sessions/:id/resize` — update PTY columns and rows
- `POST /terminal/sessions/:id/interrupt` — compatibility Ctrl+C endpoint
- `DELETE /terminal/sessions/:id` — close and forget the session

Sessions are bound to the creating allowed Origin, use the same optional Bearer token as `/mcp`, cap concurrent PTYs and output, expire after inactivity, and close when the daemon stops. Windows uses ConPTY with PowerShell; Unix uses the configured shell. ANSI rendering, cursor control, history keys, Ctrl+C, resize, and interactive CLI/TUI programs work through xterm.js.

**Paracraft CLI hub** (`/paracraft/*`, same loopback server): desktop Paracraft registers on start. If Keepwork MCP is up, the client long-polls jobs (and heartbeats) until the hub goes down. The daemon also scans loopback NPL HTTP (`8099-8115` `/ajax/paracraft_cli`) so a client that started while the daemon was down can still be found. If a client reports an NPL HTTP `nplPort` and the hub can ping it, dispatch goes to that port and skips long-poll. AIChat `ParacraftTool.html` lists desktop clients and dispatches `run_command` / `screenshot` / `open_world` / `exit` / `bring_to_front`. Client register/poll stay open on loopback. List/dispatch use the pairing token only when `requireAuth` is on.

**WASM NPL code wiki** (`/webserver/<instance>/…`): web-paracraft cannot bind `:8099`. It probes `GET /health` for `webserverBase`, registers, and stores `webserverRoot` as NPL `WebServer:site_url()`. This daemon then proxies console / debugger / ajax into that WASM instance as batched `http_request` jobs (cookie `Keepwork-WebServer` for root-absolute `/wp-includes` and `/ajax`). Full write-up: [docs/paracraft-cli.md](docs/paracraft-cli.md). Engine side: paraworld `docs/aries/paracraft-cli.md`.

**Calendar reminders** (`/calendar/reminders`): AIChat’s personal calendar tool POSTs the next 7 days of reminders. The daemon stores `~/.keepwork-mcp/calendar-reminders.json` and fires timers. When this extension is active, a notification offers **打开日历**, which opens the `openUrl` (usually `https://keepwork.com/chat?tool=calendar` or a local `AIChat.html?tool=calendar`). Due reminders retry if VS Code was closed.

Default **workspace root** (confinement parent) is `~/.keepwork-mcp/workspace`. AIChat uses a slot under it:

- no workspace selected → `~/.keepwork-mcp/workspace/default`
- workspace named `Foo` (including a local folder with no usable abs path) → `~/.keepwork-mcp/workspace/Foo`

It is **not** the open VS Code project. Configure the parent with `keepwork.mcp.workspaceRoot`, `~/.keepwork-mcp/config.json`, or Command Palette:

- **Keepwork: Open MCP Working Directory** — reveal the folder in the OS file manager
- **Keepwork: Change MCP Working Directory** — pick another folder (saved globally, daemon restarts)
- **Keepwork: Show Terminal** — open / reuse the **Keepwork** integrated terminal at the bottom of VS Code

When the extension is active, `run_terminal` prefers that reused VS Code terminal (default profile). If VS Code is closed, the CLI daemon falls back to a hidden shell spawn.

## Run the MCP daemon

### Option A — VS Code / Cursor
Install this extension (F5 **Run Extension** while developing). On activate it probes `:8089` and spawns `node out/cli.js` if the port is free. Requires `node` on PATH.

### Option B — CLI (no editor)

```powershell
cd c:\lxzsrc\keepworkExtension
npm install
npm run compile
npm start
```

Optional flags: `--port 8089` `--root %USERPROFILE%\.keepwork-mcp\workspace`. `--stdio` speaks MCP over stdin/stdout for Cursor.

Pairing token is **off by default**. AIChat connects to `:8089` with no paste step. To require a token: VS Code setting `keepwork.mcp.requireAuth`, env `KEEPWORK_MCP_REQUIRE_AUTH=1`, CLI `--require-auth`, or `"requireAuth": true` in `~/.keepwork-mcp/config.json`. Then paste `~/.keepwork-mcp/token` from the Craft menu **令牌** action.

Workspace root (first match wins): `--root` / `KEEPWORK_MCP_ROOT` / VS Code `keepwork.mcp.workspaceRoot` / `~/.keepwork-mcp/config.json` / **`~/.keepwork-mcp/workspace`**.

Example `~/.keepwork-mcp/config.json`:

```json
{ "workspaceRoot": "C:/Users/you/.keepwork-mcp/workspace", "port": 8089 }
```

### Connect AIChat

1. Start the daemon (Option A or B).
2. Open [https://keepwork.com/chat](https://keepwork.com/chat) (or local `AIChat.html`).
3. Click the **Craft** pill → **Keepwork（内置）**. Multiple AIChat tabs share the daemon. Add extra loopback MCP URLs from **＋ 添加 MCP 服务器**.

### Cursor stdio

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

## Security

- Binds **127.0.0.1 only**. Do not expose port 8089 on the LAN.
- MCP and admin APIs are **open on loopback by default**. Set `keepwork.mcp.requireAuth` to require `~/.keepwork-mcp/token`.
- Commands cannot leave the workspace root. A small deny-list blocks `format`, `shutdown`, `rm -rf /`, etc.
- AIChat confirms every `run_terminal` call in the UI.
- The AIChat Terminal tab is direct user input, so it bypasses the model confirmation bar and command deny-list parsing. It is available only for a verified local-folder cwd and remains protected by loopback Origin/auth, owner binding, bounded sessions/output, idle cleanup, and explicit close.
- `web_search` / `fetch_url` only allow public http(s). Localhost, private IPs, and metadata hosts are blocked. HTML is parsed on this machine; the model receives minified JSON only.

## Publish to Visual Studio Marketplace

The extension is published as [`Xizhi.keepwork`](https://marketplace.visualstudio.com/items?itemName=Xizhi.keepwork). Use Microsoft Entra ID authentication rather than a Personal Access Token (PAT).

### One-time setup on Windows

1. Install Azure CLI:

  ```powershell
  winget install --exact --id Microsoft.AzureCLI
  ```

2. Sign in with Windows Web Account Manager (WAM). Security Defaults block device-code flow, so do not use `--use-device-code`:

  ```powershell
  az config set core.login_experience_v2=off
  az login --tenant <tenant-id> --allow-no-subscriptions
  ```

3. In [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/Xizhi), add the signed-in Entra identity to publisher `Xizhi` with the **Contributor** role. If Marketplace needs the Entra profile ID, retrieve it without printing an access token:

  ```powershell
  az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me `
    --resource 499b84ac-1321-427f-aa17-267ca6975798 `
    --query id -o tsv
  ```

### Package and publish

`npm run package` compiles the extension, increments the patch version, and creates `keepwork-<version>.vsix`. Review the new version before publishing.

```powershell
npm install
npm run package
.\node_modules\.bin\vsce.cmd publish --azure-credential `
  --packagePath .\keepwork-<version>.vsix
```

If Azure CLI was installed after VS Code started, restart VS Code or expose it to the current terminal before running `vsce`:

```powershell
$env:PATH = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin;' + $env:PATH
```

Publishing an existing VSIX does not rebuild, increment the version, commit, or create a Git tag. Verify the release on the [public listing](https://marketplace.visualstudio.com/items?itemName=Xizhi.keepwork); propagation can take a few minutes. For automated publishing, follow Microsoft's workload identity federation and managed identity workflow instead of storing interactive credentials.

## Requirements

- Node.js 18+
- Git on PATH (clone command)
- VS Code / Cursor 1.85+ for the extension UI

## License

MIT
