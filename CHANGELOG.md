# Changelog

## [0.1.1] - 2026-08-13

### Changed
- Default MCP sandbox parent is `~/.keepwork-mcp/workspace`. AIChat uses `workspace/default` when no workspace is selected, or `workspace/[workspacename]` when one is (including local folders without an abs path).
- `run_terminal` reuses the VS Code **Keepwork** integrated terminal when the extension is active; falls back to hidden spawn for CLI-only daemons.
- MCP call history is paged (`GET /admin/history?offset=&limit=`). The panel and status bar load one page, not the full buffer.

### Added
- Commands: Open / Change MCP Working Directory, Show Terminal
- MCP panel buttons for directory + terminal
- History Newer / Older paging in the MCP panel

## [0.1.0] - 2026-08-13

### Added
- Local MCP daemon on `http://127.0.0.1:8089` (`run_terminal`, `grep_files`, `mcp_status`)
- Singleton spawn-or-attach across VS Code windows; status bar + clients/history panel
- CLI: `npm start` (HTTP) and `npm run mcp` (stdio)

## [0.0.1] - 2026-01-15

### Added
- Clone Repository from Keepwork URL command
- Open in Keepwork context menu for files
