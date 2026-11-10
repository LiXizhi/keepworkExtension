# `apps/mcp-rust` — Keepwork MCP daemon (Rust)

Rust implementation of the loopback MCP daemon that `apps/mcp-runtime` ships as
Node. Same wire contract, no Node in the installer.

- Binds `127.0.0.1:8089` (same port, same `/mcp`, `/health`, `/admin/*` paths).
- `/health.name` stays `keepwork-mcp`; the runtime reports
  `runtimeEngine: "rust"` and `runtimeProduct: "keepwork-mcp-runtime"`.
- `/health` advertises `fsApi: "workspace"`, `folderBrowserApi: "folders-v1"`,
  `terminalApi: "pty-session-v1"` and `aichatPresenceApi: "post-sse-v1"`; agent,
  messaging, persona and browser surfaces stay unadvertised until P2/P3.
- Only advertises capabilities it actually serves, so AIChat degrades instead of
  calling a 404 while the port is in progress.

## Phase status

| Phase | Scope | State |
| --- | --- | --- |
| P0 | lifecycle, config/paths, CORS/auth, `/health`, `/exists`, `/fs/stat`, `/admin/status|stop`, MCP handshake + `mcp_status` | implemented |
| P1 | `/fs/*` full (`list`/`search`/`stat`/`file`/`dir`/`reveal`), `/fs/locations|browse`, PTY `/terminal/*`, `run_terminal`, `grep_files`, `web_search`, `fetch_url` | implemented |
| P2 | agents/ACP, messaging, personas, presence SSE | next |
| P3 | browser, computer, paracraft, dashboard, admin API docs/history | planned |

See [docs/rust-runtime-migration.md](../../docs/rust-runtime-migration.md) for the
migration contract, manifest v2 and rollout order.

## Commands

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release          # target/release/keepwork-mcp (~0.7 MB in P0)

node scripts/smoke.cjs                                  # spawn + handshake + /admin/stop
# from the repository root
node --test scripts/contract/*.test.cjs                  # contract suite (Node reference when built)
```

Contract tests run the same assertions against this binary and, when a local
`apps/mcp-runtime/dist/cli.cjs` exists, against the Node daemon on a second port.
`fetch_url` differs from Node in one documented way: there is no headless
Edge/Chrome pass, so JS-rendered pages yield their static markup.

## Layout

```
crates/keepwork-mcp/
  src/main.rs        process entry, instance file, signals
  src/cli.rs         --port/--root/--require-auth
  src/config.rs      ~/.keepwork-mcp config/token/instance (Node precedence)
  src/paths.rs       workspace root, lexical/realpath confinement
  src/fs.rs          /fs/* routes, MIME and size caps
  src/folders.rs     /fs/locations, /fs/browse
  src/presence.rs    /aichat/presence (JSON + SSE) & MCP keepwork/presence
  src/terminal.rs    PTY sessions, cursor replay, deny-list
  src/shell.rs       run_terminal (spawn, timeout, output cap)
  src/grep.rs        grep_files (ripgrep + loop-aware walker)
  src/web.rs         web_search / fetch_url with SSRF guards
  src/identity.rs    runtimeVersion/Commit/BuiltAt + hostKind/hostVersion
  src/http/          router, CORS, auth, health/admin/exists handlers
  src/mcp.rs         sessions, JSON/SSE negotiation, tools dispatch
  src/tools.rs       tool registry (P1: the five portable tools)
  tests/contract.rs  wire contract (headers, payloads, SSE framing)
```

## Rules

- Loopback only. Never bind `0.0.0.0`.
- `fs`/`terminal`/`admin` path rules must match `src/core/paths.ts` and
  `src/core/fsServe.ts`; add cases to both engines' tests when in doubt.
- Do not advertise an API string in `/health` before its routes exist.
- Bump `crates/keepwork-mcp/Cargo.toml` version and keep its `Cargo.lock` in sync.
