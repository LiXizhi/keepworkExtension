# `apps/mcp-rust` — Keepwork MCP daemon (Rust)

Rust implementation of the loopback MCP daemon that `apps/mcp-runtime` ships as
Node. Same wire contract, no Node in the installer.

- Binds `127.0.0.1:8089` (same port, same `/mcp`, `/health`, `/admin/*` paths).
- `/health.name` stays `keepwork-mcp`; the runtime reports
  `runtimeEngine: "rust"` and `runtimeProduct: "keepwork-mcp-runtime"`.
- `/health` advertises file, folder-browser, PTY, presence, persona and messaging
  contracts, plus `agentSessionApi`, `agentInventoryApi`, `agentContextApi`,
  `agentModeApi` and `agentImageTurnApi` (`"v1"`) for the native CLI slice described below.
  Non-Codex native history import, browser automation and unsupported provider protocols
  are not advertised as available.
- Only advertises capabilities it actually serves, so AIChat degrades instead of
  calling a 404 while the port is in progress.

## Current scope and acceptance

The [Rust capability matrix](../../docs/rust-capability-matrix.md) is the current
feature/engine/platform index. Files, PTY, portable tools, Dashboard, admin API
catalog/history, native CLI sessions and image turns, persona local tools,
DingTalk/Feishu messaging and owner-driven Circles are implemented. Browser,
computer and Paracraft services, autonomous multi-agent routing and headless
messaging workers are not fully ported. Optional capabilities decide availability;
product version equality is never required.

See [the migration contract](../../docs/rust-runtime-migration.md) for manifest
v2, independent update streams and ownership boundaries, and the
[packaged-release checklist](../../docs/acceptance/rust-desktop-release.md) for
durable evidence. Dated validation below records its exact source/environment;
it does not certify a current installed package, every platform or a real account.

## Native CLI sessions

The Rust daemon now implements `/agents/backends`, executable-only inventory,
owner-scoped session create/list/read/update, text and image turns, approval replies,
interruptions and NDJSON session snapshots. WorkBuddy and CodeBuddy use their
native `--acp` process; the same adapter supports registered ACP CLIs. Codex uses
its native `app-server --stdio` protocol, and Claude Code uses its native
bidirectional stream-json control protocol. These transports do not forward to a Node MCP
daemon or treats installation detection as a successful model turn.

- Native executable discovery is read-only and bounded. A targeted provider
  query starts only that provider. Provider credentials stay in its native CLI;
  an ACP handshake with no account query reports authentication as unknown.
- Every public request keeps explicit allowed Origin, hashed `X-Agent-Owner`
  isolation and optional daemon bearer authentication. The browser cannot pass
  executable names, flags or arbitrary native RPC calls.
- Turns persist their request ID before submission. Reconnect, timeout and
  restart never replay an uncertain prompt. Restarted in-flight turns remain
  uncertain and can be inspected; native history is resumed only when the
  provider advertises the required contract.
- `/agents/sessions/:id/image-turns` accepts 1–4 inline PNG/JPEG/WebP/GIF data
  URLs, at most 4 MiB decoded in total (7,000,000-byte HTTP body). Codex and
  Claude receive native image blocks; ACP requires `promptCapabilities.image`
  from the CLI handshake, including DeepSeek. Unsupported providers reject
  before sending a prompt. Ordinary text requests keep their existing limits.
  Daemon snapshots and history store image placeholders; the browser retains
  submitted previews in its existing account-scoped transcript.
- Craft requests full access, Ask preserves interactive native approvals, and
  Plan requires a native planning mode for ACP and denies mutating permissions.
  Unsupported model, effort or mode semantics fail before the prompt is sent.
  Questions are not auto-approved.
- AIChat context registration, SSE tool dispatch and result delivery bind to the
  original owner/conversation/page/generation. A private MCP stdio process uses
  this same Rust binary (`--agent-tool-proxy`); only its revocable capability
  enters the CLI environment. Page disconnects report unknown dispatched
  results and never replay mutations. Cloud and Git credentials are not stored
  or handed to native agents.
- Page reload or replacement revokes the former capability. An existing native
  session is considered connected only when its current page/generation and
  binding incarnation still match. ACP `session/load` or Codex `thread/resume`
  installs the new descriptor before a later prompt; providers without that
  restore contract fail explicitly. Reading Rust's persisted history does not
  start a CLI. A legacy Node Codex registry without visible items is the narrow
  exception: its first owned session GET performs read-only App Server
  `thread/read` with `includeTurns: true`, caches the recovered visible history,
  and reports a clear error if retrieval fails. It never starts/resumes a thread
  or submits a prompt; unhydrated records keep the missing-items marker across
  unrelated saves instead of becoming a false empty transcript.
- ACP `session/load` isolates replayed transcript events from the preserved local
  history and rejects interactive requests during replay. Later turns wait until
  the queued restore events have drained; restoration failures send no prompt.
- Background `workspace_file` operates on explicitly granted local spaces;
  mutations require Craft and retain path/symlink confinement and read-before-
  edit checks. Remote/cloud/Git file operations require the original online
  page's discovered tools. Git draft import/get/drop/ack preserves the existing
  draft store without pretending to verify a remote base. Remote conflict
  checks, Git background edits and protected-deck staging remain unsupported.

Codex native history is available through `GET /agents/native-codex?cursor=`
and `GET /agents/native-codex/:threadId`, with equivalent
`/agents/native-sessions/codex` routes. Listing uses opaque pagination and includes
CLI, editor, exec and app-server threads across providers, excluding threads
managed by another AIChat owner. Opening history only calls `thread/read` and
attaches one persistent owner-scoped wrapper; it never starts or resumes a turn.
The wrapper preserves the original thread and canonical working directory,
defaults to Ask, and refreshes external busy state on inactive reads. External
active threads cannot accept AIChat turns or be stopped through this wrapper.
An explicit user turn resumes the original thread with the existing submission
receipts and approval contract. Invalid history or unavailable workspaces fail
without creating an empty replacement. Workspace metadata reports the original
cwd with `complete: false`; additional native workspace roots are not inferred.

Claude Code reuses the discovered installation and starts a separate native
stream-json process for each conversation. Native initialization supplies its
model catalogue; text and reasoning deltas reconcile with complete assistant
blocks, and native tool approvals, questions and interrupts use the existing
owned session API. Additional workspace roots use `--add-dir`; page-bound MCP
tools remain process-scoped. No permission-bypass flag or user-global CLI
configuration is added. Reading `claude auth status` can verify native sign-in;
unsupported or unrecognized account status remains unknown, and signed-out
status is distinct from a missing installation. Metadata queries never start
login or submit a prompt. Native resume preserves the original conversation;
reconnects and uncertain submissions never resend a prompt automatically.

Antigravity CLI uses native `agy` stream-json under the stable `gemini` backend
key. Model discovery reads `agy models`; no reasoning options are invented.
Each conversation reuses its native process across turns and resumes with its
exact saved conversation ID after restart. Text and tool updates stream through
the owned session API; interruption, process exits and uncertain submissions
never replay a prompt. Ask and Plan use agy's native plan mode. Native permissions
remain in force: denied tools produce a failed turn, and headless sessions cannot
answer interactive permission requests. Page-bound MCP configuration stays in a
host-owned launch directory, with capability credentials inherited only by the
child process. Neither user workspace nor global CLI configuration is changed.
Node Antigravity history remains readable and resumable across runtime engines;
legacy Gemini ACP history stays readable but requires a new Antigravity chat to
continue. Antigravity accepts text only and explicitly rejects image input.
Executable discovery remains separate from protocol/account verification, and
metadata queries do not launch login or submit a prompt.

Account switching, non-Codex native history import and the Copilot
VS Code custom-model bridge also remain outside this Rust implementation. A
registered ACP provider is not evidence that its installed version, account,
models or platform have passed a live acceptance run.

Copilot ACP does not support the required per-session AIChat MCP-server binding
in this contract. Its inventory/model discovery does not mean that an AIChat
`contextVersion: 1` conversation is usable: those creation requests are rejected
before a prompt, rather than silently dropping browser tools or changing
providers. Direct legacy sessions remain limited to the native contract the
installed CLI actually supports.

Validation uses real isolated HTTP listeners and deterministic native child
processes: `node --test scripts/contract/agents.test.cjs` from the repository root
after building the Rust binary, plus the Rust unit suite. These fixtures do not
establish live provider or native desktop UI compatibility.

Claude's Rust transport is covered by isolated native-process and HTTP fixtures,
including installed/signed-out/unknown-account states, initialization, streamed
text, approvals, questions, interruption and continuation. This is protocol
regression coverage; fixtures alone do not establish live account or model
access. A running older Rust daemon can still report Claude's
protocol as unsupported until the changed runtime is installed and started.

On 2026-11-12, an isolated macOS arm64 Rust 0.2.25 debug daemon used the existing
Claude Code 2.1.322 installation. Read-only native auth status confirmed sign-in,
and initialization returned the native model catalogue. In each of two separate
temporary workspaces, the first turn used one native file-tool call to read
`probe.txt` and returned its exact random Unicode marker (including Chinese and
emoji); a second turn recalled that marker without a tool call in the same native
thread. All four turns completed. A separate Rust 0.2.26 debug run read a new
workspace's random Unicode file marker, stopped and restarted the isolated daemon
with the same profile and Origin, and restored the exact cached transcript. An
explicit new turn then recalled that marker in the same native thread. This task
did not restart or replace the shared listener, which initially ran Rust 0.2.21
with four clients. A later read found Rust 0.2.26 on 8089 after an external update;
its refreshed Claude backend query returned `available: true`,
`protocolSupported: true`, verified authentication, six native models and the
existing CLI path.
These checks verify native file access, continuation and daemon-restart resume on
this machine; Windows, native desktop UI and live AIChat page-tool execution were
not exercised by these Claude runs.

On 2026-11-12, isolated macOS arm64 tests with the actual WorkBuddy CLI found
17 models and completed two turns in one native conversation, including recall
of the first turn's marker. A separate real turn discovered and invoked the
Rust MCP bridge: a local SSE consumer returned a random nonce that was absent
from the prompt, and the final answer matched that tool result. The consumer
simulated the online page; the native Tauri UI and Windows were not exercised.
No workspace files were created by these turns. Final fixed-binary HTTP
contracts passed 95/95 on Rust 0.2.19 with the default thread stack; the full
Rust suite and Clippy also passed. Shared build output was isolated because
another task was rebuilding the same target directory.

## Circles in 0.2.20

`POST /agents/personas/circles` now serves AIChat's existing circle editor.
The default action is `read`; no frontend update or Node compatibility daemon
is required. Organization, member, nested-circle and role edits use the same
single-use `preview` / `apply` tickets, stable IDs, revision checks and
owner/brain/organization scope as Node. Organization files remain under the
brain's `.aichat/circles/`; local sync state and receipts remain under
`messaging-v1/circles/`. Unknown fields are stripped and unsafe symlink paths
are rejected. The actual serialized file size is checked before replacement.

Connected DingTalk and Feishu accounts support contact/group searches,
company-directory member previews, discovery of joined `X-` groups, deployment
to new or existing groups, explicit pull/publish previews, conflict decisions,
history, messages/replies, receipt verification and unbinding. Refresh imports
remote state without external writes; registered owners refresh every ten
minutes. External writes recheck the account, group owner/admin authority,
current brain and revision. DingTalk uses only its dedicated `# X:goal` notice.
Unknown writes persist their intent before dispatch and cannot be replayed;
an owner can inspect the remote result and preview any remaining changes.

This implements owner-driven circle operations. Autonomous multi-agent group
routing and role execution, group nicknames and multi-computer coordination
remain outside this Rust implementation. Tests use isolated local metadata and
fake CLI processes; real DingTalk/Feishu writes and the native desktop UI have
not been exercised for this change.

```bash
cargo test --offline --manifest-path apps/mcp-rust/Cargo.toml --test circles_contract --test circles_channels_contract
cargo test --offline --manifest-path apps/mcp-rust/Cargo.toml --lib circle_
```

## Persona support

The daemon supports persona configuration, conversation history, message submission,
read/clear/cancel operations and change events under `/agents/personas`. AIChat's
existing desktop pet can send to **My Persona** through Bridge v1 when the local
service and a local second-brain folder are connected. The current optional
contracts and remaining scope live in the capability matrix.

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
- Replies use HTTPS Keepwork `/core/v0/gpt/chat`, rather than a native CLI persona
  executor. The bounded conversation history and confined `AGENTS.md` instructions
  can be combined with `grep_files`, `web_search`, `fetch_url`, and a `run_terminal`
  limited to one `dws` or `lark-cli` command. Keepwork receives `localTools`; tools
  execute only after a complete validated argument snapshot, with at most eight
  rounds. This is not arbitrary shell or general file-write authority. The channel
  auto-answer pump uses its separate text-only path; native persona CLI and
  headless-worker execution remain unsupported.
- `taskContextVersion: 1` supports `contextMode: "isolated"`, which omits prior
  conversation history and summaries. Omitted `contextMode` keeps the historical
  conversation behavior.
- A message is accepted only after its text and request ID are persisted.
  Reusing the request ID does not submit another model request. Interrupted runs
  become unknown after restart and are not replayed. Clients must inspect an
  uncertain outcome before submitting a new request.
- Replies carry actual daemon-owned execution metadata; zero counts are not a
  blanket current contract, and omitted metadata means unknown. Claimed file
  changes or business actions require tool results and receipts. DingTalk/Feishu
  channel management, manual replies and owner-driven Circles are implemented;
  autonomous persona collaboration, general file writes, WeChat, sales automation
  and native CLI persona execution remain outside this implementation. Unsupported
  actions fail at their feature boundary while ordinary text remains usable.

## DingTalk listener lifecycle

The runtime owns only the DWS listener children it starts. Stopping the binding,
a partial startup failure, a listener disconnect or graceful daemon shutdown
cleans up those children; a replacement waits for the previous children to exit.
Each listener keeps a stdin pipe held by the daemon, so parent exit closes the
pipe and DWS can clean up on EOF. Normal shutdown closes that pipe first and
allows two seconds for DWS to exit and release its own consumers and subscriptions.
Only an unresponsive child still owned by its `Child` handle is force-reaped.
Events and exit callbacks from an older listener generation cannot affect its
replacement. External consumers and subscriptions remain protected: the runtime
waits for their occupancy to clear and never stops or deletes them. Historical
orphan processes without verified ownership are not automatically adopted or
terminated. Stopping a binding preserves its cached messages and read state, so
history remains readable with automatic replies disabled. Client/server contracts
and persisted messaging records are unchanged.

Inbox reads return the complete cached view immediately; optional group/sender
name lookups run in the background. One grouping pass builds conversation
summaries, cloning only each conversation's latest message or the requested
50-message window. Response fields, ordering, `before` cursors and unread rules
remain compatible with existing clients.

Metadata lookups deduplicate in-flight targets, share a service-wide limit of
four CLI reads and at most 512 queued/in-flight targets, and cache failed or
empty names for 30 seconds. Resolved names appear on a later service read; they
do not trigger a dedicated SSE event or automatic history redraw/read action.
AIChat's explicit refresh or expired/invalidated list cache fetches the new names;
an ordinary reopen can reuse its 60-second snapshot. The Node runtime retains
its existing five-second name-warming budget; this backend change is Rust-only.

Inbox performance validation (2026-11-12, MCP **0.2.19**, Personas **1.0.15**):
**39** targeted cases passed (5 metadata + 24 messaging + 10 browser), plus
**35** CLI contract cases to protect the CLI support already running in 0.2.18.
The earlier 20 messaging cases are not counted again. Four performance cases
failed on the previous inbox source while its legacy-contract case passed;
these are fake-CLI gate checks, not a live latency benchmark. The complete
current source was built in `/private/tmp/keepwork-inbox-full-_kxcqhhj`; the earlier
trimmed 0.2.16 artifact was not used to replace the newer runtime. Logs:
`/tmp/messaging-metadata-full-{final,unit}.log`,
`/tmp/messaging-metadata-latency-before.log`,
`/tmp/inbox-performance-cli-contracts.log`; build record:
`/tmp/keepwork-inbox-performance-full-build.json`.

The owned service was updated only after confirming no active or uncertain work.
Live PID 2088 reported Rust 0.2.19 with `agentSessionApi` and `agentInventoryApi`
still `v1`; DingTalk reported `listening`, `listening: true`, `autoReply: true` and
an empty error. All 45 cached history IDs and 12 CLI session IDs were retained
(`/tmp/keepwork-inbox-performance-live-result.json`). No validation message was
sent, real unread state marked or release published. Refresh AIChat to load the
Personas 1.0.15 frontend; no live millisecond improvement is claimed.

Validation (2026-11-12, MCP **0.2.16**): **33** unique business tests passed
(13 listener lifecycle + 20 messaging; one host-fixture helper ignored), using
the release's isolated source stage at
`/private/tmp/keepwork-dingtalk-eof-o14q2xg1/apps/mcp-rust`. Both new EOF regressions
failed against the actual previous source. A direct working-tree compile was
blocked by another unfinished task's `Weak` import; that code was preserved.
Logs: `/tmp/dws-stdin-eof-{before-tests,final-lifecycle,final-messaging-unit}.log`;
build record: `/tmp/keepwork-dingtalk-eof-build.json`.

Live recovery verified ownership of the old consumers through inherited
`KEEPWORK_MCP_HOST_KIND=rust-node-runtime`, `KEEPWORK_MCP_HOST_VERSION=0.2.55` and
`KEEPWORK_MCP_RUNTIME_VERSION=0.2.11`, plus exact arguments/profile/cwd and PPID 1.
PID 61826 exited before intervention; after rechecking identity, only PID 61858
received SIGTERM. Shared bus PID 35877 remained running. The replacement Rust
daemon, PID 64048 / 0.2.16, reported DingTalk `status: listening`, `listening: true`,
`autoReply: true` and an empty error; cached history IDs were retained. Native
DWS PIDs 64082/64114 belonged to that daemon through the DWS Node launcher, held
stdin pipes, and maintained three stable event subscriptions. No message was
sent for validation, unknown subscription deleted, shared bus stopped or release
published.

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
target/release/keepwork-mcp --build-info # immutable compiled identity; no listener

node scripts/smoke.cjs                                  # spawn + handshake + /admin/stop
# from the repository root
node --test scripts/contract/*.test.cjs                  # contract suite (Node reference when built)
node --test apps/mcp-rust/scripts/dashboard-personas.test.cjs # isolated browser fixtures; installed Chrome
```

`--build-info` reports the compiled `version`, `commit`, `target`, `sourceHash`
and `capabilities`; host identity environment variables cannot override them.
The desktop bundler validates every requested target against the current source
and required capabilities before writing resources. `--no-build` still rejects
older binaries, stale binaries with the same version and missing capabilities.
Rust development launches prepare separate
`apps/aichat-rust/src-tauri/target/dev-mcp-runtime/rust-*` directories, as Node
development launches do, so a surviving daemon's files are not overwritten.
After packaging or restart, inspect the actual port-8089 `/health` identity and
capabilities and `/agents/backends`; a verified local bundle does not prove that
the shared listener was replaced or that a real provider turn passed.

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
  src/personas/     owner-scoped persona records, local tools, Circles and change events
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

## Session persistence optimization (0.2.47)

The 0.2.48 smoke runner checks the compiled binary identity, live child PID and
isolated workspace before every POST, including shutdown. Authentication uses
only that child's temporary profile. HTTP startup/body/shutdown are bounded;
cleanup signals and reaps only the owned child before removing its profile.
Port conflicts, peer replacement, auth-on/auth-off loopback operation,
hanging responses and spawn/exit failures have isolated regression fixtures in
`scripts/smoke.test.cjs`. No smoke is allowed to use the shared port 8089.

Streamed native CLI updates rewrite only the changed session's Node-compatible
history sidecar. Registry records, request receipts, `sync_all`, cursors and full
reconnect snapshots retain their existing commit order. Provider exits save the
affected histories together; failed writes do not advance a cached fingerprint.

An isolated macOS arm64 debug A/B benchmark (64 sessions × 32 chunks) reduced
history writes from 2,048 to 32 and history bytes from 17,511,232 to 510,592.
Registry writes remained 32 / 17,984,567 bytes. Its measured P95 was 436.938 ms
versus 26.220 ms; this is a local disk fixture, not an end-to-end latency promise.
Repeat with `node apps/mcp-rust/scripts/benchmark-agent-persistence.cjs --out <new-directory>`
from the repository root. It saves both strategies' counters, build identity and
logs without connecting to any daemon or account. Final task validation receipts
are collected under `.test-runtime/rust-optimization-final/` at the repository root;
real account, clean-machine and published-feed checks remain separate pending gates.

## Rules

- Loopback only. Never bind `0.0.0.0`.
- `fs`/`terminal`/`admin` path rules must match `src/core/paths.ts` and
  `src/core/fsServe.ts`; add cases to both engines' tests when in doubt.
- Do not advertise an API string in `/health` before its routes exist.
- Bump `crates/keepwork-mcp/Cargo.toml` version and keep its `Cargo.lock` in sync.


DingTalk manual image attachments use the additive conversation `replyImage` contract and `POST /agents/personas/:id/reply-image`. One PNG/JPEG/GIF/WebP up to 5 MiB is validated, staged privately under the binding root, sent through current-user DWS file transport, and cleaned after the attempt. Images arrive as downloadable attachments. Text replies keep their legacy request shape; Feishu and older services keep text usable without advertising this optional capability. The persistent request ledger prevents replay of unknown sends. See [manual image attachments](../../docs/message-autoreply.md#manual-image-attachments).
