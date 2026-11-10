# `apps/mcp-rust` — Keepwork MCP daemon (Rust)

Rust implementation of the loopback MCP daemon that `apps/mcp-runtime` ships as
Node. Same wire contract, no Node in the installer.

- Binds `127.0.0.1:8089` (same port, same `/mcp`, `/health`, `/admin/*` paths).
- `/health.name` stays `keepwork-mcp`; the runtime reports
  `runtimeEngine: "rust"` and `runtimeProduct: "keepwork-mcp-runtime"`.
- `/health` advertises `fsApi: "workspace"`, `folderBrowserApi: "folders-v1"`,
  `terminalApi: "pty-session-v1"`, `aichatPresenceApi: "post-sse-v1"` and
  `personasApi: "personas-v1"`; native agent sessions, messaging and browser
  surfaces stay unadvertised until their implementations are available.
- Only advertises capabilities it actually serves, so AIChat degrades instead of
  calling a 404 while the port is in progress.

## Phase status

| Phase | Scope | State |
| --- | --- | --- |
| P0 | lifecycle, config/paths, CORS/auth, `/health`, `/exists`, `/fs/stat`, `/admin/status|stop`, MCP handshake + `mcp_status` | implemented |
| P1 | `/fs/*` full (`list`/`search`/`stat`/`file`/`dir`/`reveal`), `/fs/locations|browse`, PTY `/terminal/*`, `run_terminal`, `grep_files`, `web_search`, `fetch_url` | implemented |
| P2 | agents/ACP, messaging, personas, presence SSE | partial: presence JSON/SSE and basic persona text replies implemented; agents/ACP, messaging and persona tool execution pending |
| P3 | browser, computer, paracraft, dashboard, admin API docs/history | planned |

See [docs/rust-runtime-migration.md](../../docs/rust-runtime-migration.md) for the
migration contract, manifest v2 and rollout order.

## Persona support in 0.2.4

The daemon supports persona configuration, conversation history, message submission,
read/clear/cancel operations and change events under `/agents/personas`. AIChat's
existing desktop pet can send to **My Persona** through Bridge v1 when the local
service and a local second-brain folder are connected. This does not complete P2.

- Persona records use the Node-compatible `~/.keepwork-mcp/personas-v1` files.
  Requests require an allowed explicit `Origin`, `X-Agent-Owner` and daemon
  authentication when enabled. Model requests use only that owner's registered
  AIChat login; tokens stay in memory and never fall back to another owner.
- Replies come from a real HTTPS Keepwork `/core/v0/gpt/chat` request. This
  runtime uses Keepwork rather than native CLI executors. It can include the
  persona's bounded conversation history and confined `AGENTS.md` instructions;
  it has no workspace tools or general second-brain file retrieval.
- `taskContextVersion: 1` supports `contextMode: "isolated"`, which omits prior
  conversation history and summaries. Omitted `contextMode` keeps the historical
  conversation behavior.
- A message is accepted only after its text and request ID are persisted.
  Reusing the request ID does not submit another model request. Interrupted runs
  become unknown after restart and are not replayed. Clients must inspect an
  uncertain outcome before submitting a new request.
- Replies carry daemon-owned execution counts of zero tool requests and zero
  tool returns. They are text answers, not evidence that files changed or business
  actions completed. Persona collaboration, file writes, DingTalk/Feishu/WeChat,
  sales automation and native CLI execution are not provided; unsupported actions
  return feature-specific errors and their optional capabilities are not advertised.

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
  src/personas.rs    owner-scoped persona records, text replies and change events
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
