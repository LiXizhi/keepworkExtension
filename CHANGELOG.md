# Changelog

## [Unreleased]

### Added
- `web_search` and `fetch_url` MCP tools: Node fetch on the user's machine, parse HTML locally, return minified JSON (never raw markup). Bing → DuckDuckGo → Baidu fallback. SSRF blocks localhost / private IPs.

## [0.1.0] - 2026-08-13

### Added
- Local MCP daemon on `http://127.0.0.1:8089` (`run_terminal`, `grep_files`, `mcp_status`)
- Singleton spawn-or-attach across VS Code windows; status bar + clients/history panel
- CLI: `npm start` (HTTP) and `npm run mcp` (stdio)

## [0.0.1] - 2026-01-15

### Added
- Clone Repository from Keepwork URL command
- Open in Keepwork context menu for files
