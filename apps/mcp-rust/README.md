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
- The dashboard lists all persisted browser identities, including historical
  ones. A record is keyed by the request Origin, browser owner key and persona
  ID; ordinary refreshes reuse it. Changing the source port or browser storage
  creates a separate identity whose profile may contain the same persona IDs.
  Older desktop source servers used random ports, leaving historical copies.
  The dashboard shows identity-group fingerprints, IDs, brain paths and record
  and identity counts to distinguish these copies from active work. Additive
  `/admin/personas` fields are `key`, `ownerGroup`, `root` and
  `stats.ownerGroups`; fingerprints never expose request owner keys. Historical
  records are retained, including empty conversations, and are never merged
  across identities.
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

## DingTalk listener lifecycle

The runtime owns only the DWS listener children it starts. Stopping the binding,
a partial startup failure, a listener disconnect or graceful daemon shutdown
cleans up those children; a replacement waits for the previous children to exit.
Events and exit callbacks from an older listener generation cannot affect its
replacement. External consumers and subscriptions remain protected: the runtime
waits for their occupancy to clear and never stops or deletes them. Historical
orphan processes without verified ownership are not automatically adopted or
terminated. Stopping a binding preserves its cached messages and read state, so
history remains readable with automatic replies disabled.

## Commands

### Historical persona maintenance

Persona data survives restarts. Source origins and owner keys remain separate;
the daemon never automatically deletes, merges or migrates old identities.
To remove confirmed empty copies left by older random-port source servers, use
the explicit offline maintenance utility:

```bash
node apps/mcp-rust/scripts/archive-personas.cjs plan /absolute/path/.keepwork-mcp selection.json > plan.json
node apps/mcp-rust/scripts/archive-personas.cjs apply plan.json
node apps/mcp-rust/scripts/archive-personas.cjs restore /absolute/path/.keepwork-mcp/persona-archives/<archive>
node --test apps/mcp-rust/scripts/archive-personas.test.cjs
```

`selection.json` contains `obsoleteOwnerGroups` and `protectedOwnerGroups`, both
arrays of full `ownerGroup` fingerprints. Only mark identities obsolete after
verifying their old source; an idle state or zero messages is insufficient.
Planning is read-only. A selected record is eligible only when an equivalent
configuration remains, with no messages, receipts, summary, schedules, job,
authorization, nonempty group configuration, direct/peer binding reference or
unknown persisted state. Protected and unclassified identities stay intact.

Stop the desktop host's MCP supervision and the daemon before apply/restore.
The utility rejects a live recorded PID or an occupied default/configured port,
reserves the ports, holds `persona-maintenance.lock`, and rechecks the complete
persona/binding hashes before mutation. Updated Rust startups check the lock
and bind before loading data; an attaching process never rewrites persona files.
Older runtimes do not honor this lock, so stop their hosts before maintenance.
Unchanged records are no longer rewritten merely because the daemon restarts.

Archives live outside the scanned store in `persona-archives/<archive>/files`,
with exact original bytes, SHA-256 hashes and a private recovery manifest.
Every selected file is backed up before any source is removed. Restore leaves
already identical files intact and rejects conflicting files without overwriting
them. The utility does not print owner keys, prompts or transcript contents.

### Runtime checks

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release          # target/release/keepwork-mcp (~0.7 MB in P0)

node scripts/smoke.cjs                                  # spawn + handshake + /admin/stop
# from the repository root
node --test scripts/contract/*.test.cjs                  # contract suite (Node reference when built)
node --test apps/mcp-rust/scripts/dashboard-personas.test.cjs # isolated browser fixtures; installed Chrome
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
