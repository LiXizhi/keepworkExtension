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

`GET /health` includes `workspaceRoot` so AIChat can map a bound local folder (browser only knows the folder name) onto a cwd relative to that root. It also reports `paracraftClients` when desktop Paracraft processes have registered.

**Paracraft CLI hub** (`/paracraft/*`, same loopback server): desktop clients register and long-poll jobs; AIChat `ParacraftTool.html` lists clients and dispatches `run_command` / `screenshot` / `open_world`. Client register/poll stay open on loopback. List/dispatch use the pairing token only when `requireAuth` is on.

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

## Requirements

- Node.js 18+
- Git on PATH (clone command)
- VS Code / Cursor 1.85+ for the extension UI

## License

MIT
