# Long-lived AIChat Agents

`src/core/personas.ts` owns local identity bindings, one durable transcript per Agent, bounded context, idempotent tasks and a daemon-owned daily scheduler. `src/mcp/personaHttp.ts` is mounted under the existing authenticated, Origin-checked `/agents` namespace. Native CLI sessions use a separate hashed internal owner so they never appear in ordinary AIChat session listings.

All endpoints require `X-Agent-Owner`. Owner keys use the same Origin-bound capability scheme as existing CLI sessions. AIChat profile metadata is portable; local roots, messages, requests, approvals, native session references, schedules and channel bodies remain on this machine. Credentials remain in memory and are selected by owner; a missing owner's login must not fall back to the last different account.

## Endpoints

| Route after `/agents/personas` | Method | Purpose |
| --- | --- | --- |
| empty | GET / POST | List / upsert identity and machine binding |
| `/events` | GET | Owner-only SSE change notices; reconnect then fetch snapshots |
| `/:id` | GET | Identity, status and 50 transcript rows; `before` timestamp pagination |
| `/:id/messages` | POST | Submit `{requestId,text}` exactly once |
| `/:id/read` | POST | Mark current transcript read |
| `/:id/cancel` | POST | Cancel job and pending approvals |
| `/:id/respond` | POST | Answer an owned live request; never auto-approve |
| `/:id/schedules` | POST | Upsert daily `{id,title,prompt,time,timezone,enabled,target?}` or delete with `remove:true` |
| `/:id/bind` | POST | Explicitly attach existing messaging `binding`; does not enable it |
| `/:id/channel-start`, `/:id/channel-stop` | POST | Start/stop this Agent's channel |
| `/:id/inbox` | GET / POST | Get conversations/messages; POST `read`, `pause`, `resume`, `clear` |
| `/:id/reply` | POST | Explicit recipient conversation, idempotent request, automatic takeover |
| `/:id/remove` | POST | Cancel, detach owned listeners, delete Agent data; preserve brain files |

The channel operations delegate to `MessagingService`, maintaining compatibility with existing `/messaging` settings. Bindings are unique by stable platform identity. Message bodies are in a dedicated `messaging-v1/inbox.json`; ordinary status receipts contain no message text. Clears retain delivery tombstones. Active/queued automatic work is cancelled on takeover; work already submitted to DWS may have completed and cannot be recalled.

## Execution and scheduling

Owner CLI tasks reuse `AgentSessions` in `ask` mode. Only pre-submission initialization failures can fall back. Completed native sessions are removed from the runtime index where the provider supports it; native CLI history follows provider policy. Cancellation propagates to the owned session.

The Keepwork persona executor now uses `createMcpAgentRuntime` directly in the daemon. It does not call `MessagingWorkers`, launch Chromium, or fetch executable AIChat code. Existing messaging auto-reply workers are unchanged. Persona writes and terminal calls still enter the existing visible owner approval state; cancelled runs cannot start late tools. Runtime metadata is stored under the existing job; active runs become unknown on daemon restart and are not replayed.

`src/core/aichatRuntime.ts` is also the internal custom-team entry point. Create one service per owner, register explicitly authorized workspace descriptors with `registerWorkspaces(owner, workspaceId, grant)`, then call `answer(input, signal)`. Input supplies a stable run ID, prompt/question/history, model, tool definitions, skill IDs and optional named members. Members can override prompts/models/skills and narrow tools; owner, workspace grants and cancellation remain inherited. `runSubAgent` and `sendAgentMessage` wait for the member's answer, preserve member follow-up context, and stop at depth three. Team mutation callbacks must implement owner approval; `workspace_file` mutations require the supplied `approve` callback. No public team endpoint or editor UI is added.

Personas register only their bound local brain (Primary and `//.brain/`); callers can explicitly grant additional local/cloud/Git workspaces through the existing `AichatWorkspaceFiles` provider. Credentials stay in memory. Unknown aliases fail instead of becoming disk paths. `load_skill` reads workspace skill Markdown; browser-only capabilities and templates requiring an absent sandbox fail explicitly. Each model request uses the Keepwork `/gpt/chat` wire format (`localTools`, `max_tokens`), an owner-scoped token and no replay after an uncertain request.

### Shared source and packaging

The canonical source is AIChat `runtime/*.mjs`. From this repository run:

```sh
npm run sync:aichat-runtime
npm run check:aichat-runtime
```

The sync command creates reviewed CommonJS files under `src/core/vendor/aichat-runtime`, with source/output SHA-256 hashes in `manifest.json`. `npm run check:shared` and `npm run check:aichat-runtime` compare canonical source, module inventory and generated output whenever the sibling AIChat checkout exists; they fail if the copy is stale. When that checkout is absent, builds and checks verify the committed copy against its manifest (module inventory and output SHA-256), allowing standalone builds from this Git repository. An existing but incomplete AIChat checkout still fails. The default source is `../apps/official/apps/tools/AIChat/runtime`, resolved relative to this repository regardless of the working directory. An explicit source directory remains supported by the script and must exist. Standalone MCP builds, VS Code extension builds, watch/dev-server rebuilds and Local Helper worker builds synchronize automatically before bundling; watch mode also observes AIChat runtime edits and module additions/removals. Checks never silently synchronize. Application esbuild bundles resolve these static imports normally, without requiring a sibling checkout at runtime. Never hand-edit vendored files.

Offline integration: `node --test scripts/aichat-runtime.test.cjs scripts/personas.test.cjs`. Run the AIChat shared fixture against this copy with `AICHAT_RUNTIME_COPY=/absolute/path/to/keepworkExtension/src/core/vendor/aichat-runtime node --test tests/unit/shared_runtime.test.mjs` from AIChat.

Schedules run daily in an IANA timezone. Next times skip missed wall-clock minutes, jobs do not overlap, duplicate DST wall times do not run twice on a local date, and startup recalculates future deadlines. Runs have durable request IDs. Unknown jobs after restart are not replayed. External targets are opt-in, owner-checked channel/conversation pairs; sending failures are not automatically retried. The old browser scheduler is untouched.

Tests: `node --test scripts/personas.test.cjs scripts/messaging.test.cjs scripts/aichat-presence.test.cjs`; shared type checks: `npm run check:shared`. Browser and real-account acceptance are documented in AIChat `docs/agents.md`.

The persona system context contains its saved prompt, current brain folder, `AGENTS.md` instructions and explicit Primary/`//.brain/` guidance. Rebinding or clearing the brain revokes the old internal workspace grant; a rootless persona does not receive `workspace_file`. The runtime regression checks interactive, scheduled and fallback turns, prompt/folder changes, actual alias reads and clearing the binding.

Desktop development: the VS Code **keepwork Desktop: Start** task also syncs and rebuilds the standalone MCP bundle. It replaces an identified Keepwork daemon through `/admin/stop` and verifies the newly spawned PID; cached runtime selection and runtime downloads are disabled for this launch. Quit an existing Desktop from its tray first. See `apps/aichat-desktop/README.md`.

Before replacing different packaged bytes, sync requires a clean committed AIChat
runtime, fetches its tracking branch (without pulling or modifying the worktree),
and verifies that HEAD contains both the fetched upstream and the previously
packaged source commit. Behind/diverged history, failed fetches, and uncommitted
runtime changes abort without overwriting the copy. The manifest records source
commit provenance. Legacy or uncommitted snapshots must first be matched exactly
by a committed AIChat runtime and synced to establish provenance. Identical bytes
need no fetch and retain the known committed baseline; standalone builds still
verify the packaged copy when AIChat is absent. Checks remain read-only and compare
local source parity rather than fetching. Run `node --test scripts/aichat-runtime-freshness.test.cjs`
for isolated Git-remote regressions.
