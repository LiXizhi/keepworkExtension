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

Status bar: `Keepwork MCP` (plus client count). Hover for a summary; click for clients and call history.

**Tools**

| Tool | Purpose |
|------|---------|
| `run_terminal` | Run a shell command under the workspace root (AIChat asks you to confirm) |
| `grep_files` | Search file contents under the root |
| `mcp_status` | Report root, port, pid, ripgrep |

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

Optional flags: `--port 8089` `--root C:\lxzsrc`. `--stdio` speaks MCP over stdin/stdout for Cursor.

Pairing token is written to `~/.keepwork-mcp/token`. In AIChat, click the **MCP** composer pill and paste it (or run **Keepwork: Copy MCP Token**).

Workspace root (first match wins): `--root` / `KEEPWORK_MCP_ROOT` / VS Code `keepwork.mcp.workspaceRoot` / `~/.keepwork-mcp/config.json` / process cwd.

Example `~/.keepwork-mcp/config.json`:

```json
{ "workspaceRoot": "C:/lxzsrc", "port": 8089 }
```

### Connect AIChat

1. Start the daemon (Option A or B).
2. Open [https://keepwork.com/chat](https://keepwork.com/chat) (or local `AIChat.html`).
3. Click **MCP 令牌** / **本地 MCP**, paste the token.
4. Multiple AIChat tabs can share the same daemon (one MCP session each).

### Cursor stdio

```json
{
  "mcpServers": {
    "keepwork": {
      "command": "node",
      "args": ["c:/lxzsrc/keepworkExtension/out/cli.js", "--stdio"],
      "env": { "KEEPWORK_MCP_ROOT": "C:/lxzsrc" }
    }
  }
}
```

## Security

- Binds **127.0.0.1 only**. Do not expose port 8089 on the LAN.
- MCP and admin APIs require the pairing token.
- Commands cannot leave the workspace root. A small deny-list blocks `format`, `shutdown`, `rm -rf /`, etc.
- AIChat confirms every `run_terminal` call in the UI.

## Requirements

- Node.js 18+
- Git on PATH (clone command)
- VS Code / Cursor 1.85+ for the extension UI

## License

MIT
