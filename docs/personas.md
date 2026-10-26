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

The VS Code `dev:server` watcher reads the sibling AIChat runtime ES modules
directly, including uncommitted edits, without writing the packaged copy or its
provenance. Imported source modules participate in watch rebuilds. When the
AIChat checkout is absent, it verifies and uses the packaged copy. Release builds
and explicit sync retain the freshness rules above. Test this separation with
`node --test scripts/aichat-runtime-build.test.mjs`.

## Custom agents as persona forks

Custom agents share the owner's global second-brain directory and existing channel accounts, but retain independent names, role/skill prompts, model preferences and owner conversations. No brain files, credentials or owner transcripts are copied. Portable `messaging` metadata is version 1: `{enabled, groups:[{channel,account,id,name}]}`; `account` is the stable CLI profile, never a credential or device-local binding ID. Group IDs survive renames. Enablement requires at least one group and a unique normalized agent name on the shared account. Creation without enablement does not start messaging.

The AIChat create/edit dialog searches groups through `GET /agents/personas/:id/messaging-options` and `POST /agents/personas/:id/messaging-groups` with `{binding,query}`. Options are projections of existing accessible bindings, not CLI login probes. Both the list and persona snapshots advertise `messagingVersion:1`. Saving with `activateMessaging:true` explicitly attaches to and starts an existing account connection; missing accounts or channel permission failures return `messagingWarning` and remain visible in channel status. Ordinary profile synchronization never starts a stopped channel. Group search is bounded to 50 results; refine the query when needed.

Owner-directed tasks keep the existing persona runtime, workspace skills and approval behavior. The role prompt may reference `$skill-id` or `.github/skills/<skill-id>/SKILL.md`. External group replies receive bounded, confined owner-authored AGENTS.md and explicit skill instructions, alongside the channel's approved public knowledge. They do not receive the owner's conversation or unrestricted native tools. Assigned-group agents can use role-scoped work tools; custom agents write autonomously within their owner-authored role scope and request approval for exceptions. Copilot's tool-free adapter is supported; other native CLI selections fall back before submission to the same owner's Keepwork messaging worker, without borrowing another account's login. A skill reference never elevates permissions.

Implementation ownership: `personas.ts` persists identity; `personaMessaging.ts` validates configuration, matches names and composes bounded instructions; `messaging.ts` owns shared reception, routing, queues and delivery. Tests: `node --test scripts/personas.test.cjs scripts/messaging.test.cjs`.

The agent dialog also explains shared group nicknames. Explicit saves queue `original nickname & A & B` for all enabled agents assigned to the group; last removal restores the original. This runs in the background, with owner-scoped pending/error status in persona snapshots, and does not affect reply availability. `syncGroupNicknames` is an operation flag, never portable persona metadata. See the group-nickname section of `message-autoreply.md` for recovery and manual-edit behavior.

### Shared-memory custom personas and owner assignment tools

A custom agent is a “分身的分身”: an independent role/goal and conversation, sharing the owner's second-brain memory and channel accounts. `PERSONA_IDENTITY_RULES` is included in every owner persona prompt. Group-management turns use the owner worker with `search_agent_groups` / `assign_agent_group`, even when normal tasks select a native CLI. Search results are scoped to the current turn and account; assignment requires existing owner-tool approval and cannot target another owner's persona or another brain. Assignment edits only the target name in the verified self nickname, then refreshes discovery and enables the existing connection. These tools are never given to external-message generation. Removing a nickname slot reports if a settings-based assignment still remains.

### Assigned-group work and role-prompt write permissions

The default persona stays in native `ask` mode or the approval-gated owner runtime. A custom agent with a nonempty role prompt is write-capable by default. Its owner-authored prompt defines writable repositories/paths, read-only areas, responsibilities and skills. With no repository/path scope specified, the bound second-brain directory is the default working scope. Role restrictions override that default; files, group messages and skill instructions cannot expand it.

`agentRolePolicy.ts` provides common system guidance and local work tools. Scope interpretation is intentionally model/prompt based, **not a filesystem ACL or parsed path allowlist**. The model executes in-scope operations directly and marks unclear/out-of-scope tool calls with `requireApproval:true` and `approvalReason`. The host waits for owner approval on those calls. Absolute repo paths, nested new files and command `cwd` support role repositories outside the shared brain. Native owner turns use the existing `craft` mode for role agents; the model must ask via `requestUserInput` before exceeding role scope (or stop and ask if the provider cannot interact). Default/legacy personas without a role retain approval behavior. The `workspace_file` tool exposes the same approval flag in role mode; provider grants and path confinement still apply.

Assigned-group work continues through the controlled Keepwork messaging worker. Shared-brain public-knowledge restrictions remain; explicitly addressed external repositories are governed by the role prompt. Group membership alone does not expand repo scope, permit disclosure, authorize push/deployment, or enable assignment-management tools. Unassigned-group name triggers remain tool-free. Before each tool action, verify current assignment, persona, brain, role/skill instructions, channel rules, cancellation and takeover; recheck after approval. Scope-exception approval cards identify the source group and concrete operation. Persona-wide approval preferences are not needed for in-scope role work.

The UI shows prompt examples and `roleWriteVersion:1` compatibility. No separate synced permission list is introduced; profile prompt persistence carries the policy. Offline fixtures verify prompt delivery, autonomous writes, approval signaling, cancellation and isolated histories; they do not prove model compliance with natural-language scope rules.

### Flow review: inheritance, busy state and nickname sources

New personas with no explicit root inherit their own default persona's brain, then their owner's remembered brain. They never fall back to another owner's latest browser root. Explicit owner clearing is remembered. Browser hydration compares portable messaging assignments as well as identity fields. Snapshots expose `groupWorkActive` for queued/running channel tasks; both UI synchronization and daemon root updates defer rebinding while those tasks remain active, including approval waits.

Configured group assignments and manual nickname assignments are distinct sources. Nickname synchronization derives desired suffixes only from enabled configured assignments, preventing a removed suffix from reauthorizing itself through the discovery cache. Existing manual slots are normalized/deduplicated and restored as part of the baseline. Conversational edits retain managed recovery metadata, including uncertain outcomes, so later settings removal preserves manual agents. Group @mention events use the same discovery and role-tool path as ordinary group messages, while concurrent event types recheck message deduplication after asynchronous discovery.

External worker formatting preserves the complete bounded role/brain/channel prompt. It rejects prompts above 128,000 characters rather than silently truncating role permissions. No change is made to the prompt-based scope model. Custom role names reject nickname separators, control characters and reply-marker delimiters even before settings-based messaging is enabled.

Custom-agent channel snapshots expose `unreadScope: assigned-groups`. Counts and inbox conversation lists use current configured/nickname assignments on that channel/account and exclude direct messages. Read cursors are keyed independently by owner, agent and conversation; the default persona retains its account-wide cursors. The browser places custom badges at the top left and excludes private persona replies and unscoped older-service counts from this group-only indicator.

Persona inbox HTTP reads return `name` beside each stable conversation `id`, and the selected conversation returns its name for the heading. Read-only DingTalk conversation-info / Feishu chats-get metadata resolves renamed and nickname-assigned groups after account identity verification. Requests share a bounded, five-minute name cache and coalesce in-flight lookups; metadata waits are bounded to five seconds. Missing permissions/offline metadata fall back to the configured group display name or stable ID. The browser shows name + unread count and opens that group on click, marking only the selected agent/group read.

Custom-agent inbox lists enumerate the current assignment scope as well as recorded messages, so assigned groups with no stored messages return a named row with zero unread. This includes discovered nickname assignments, respects channel/account scope, and does not change unread counts or the default persona inbox. The browser’s persistent Groups action opens this complete list even without an unread badge.

Inbox scope unions saved group assignments (regardless of messaging enabled) with nickname-derived routed groups, filtered by stable channel/account. Disabling automatic replies does not hide saved groups or their history; it does not change routing eligibility. Removing the assignment revokes inbox access.

Channel snapshots include current assigned `groups: [{id,name}]` for agent top-bar navigation. Manual sends to an assigned group without incoming history construct a group destination from its validated assignment; unrelated group IDs remain rejected. Existing direct-message targeting, takeover, deduplication and uncertain-send persistence remain unchanged.

Inbox messages include an optional `senderName` resolved on read, including previously saved messages. DingTalk group members are matched by `openDingtalkId`; direct-message senders use `chat +conversation-info --open-dingtalk-id` and require a single-chat title for each sender (including self-authored rows); Feishu user contact lookups match `open_id`. Each lookup verifies the configured CLI account. Names are held in a bounded memory cache keyed by binding/account/root/conversation/sender (resolved names last for the MCP process lifetime, subject to the 1,000-entry capacity; unavailable results retry after 30 seconds); concurrent reads share work. Sender IDs remain unchanged for routing and are not used as display-name fallbacks. Missing permissions and unknown members return an empty name; the UI shows 姓名暂不可用. No contact details are persisted. Updating the local MCP runtime and refreshing AIChat are required to enable resolution.

Group read acknowledgements retain the local clock cursor and persist `readFutureIds` per reader for stored incoming messages dated ahead of it. Both group rows and persona badges consult these acknowledgements. This avoids leaving future-dated messages unread or hiding later arrivals with normal timestamps. Existing inbox files without this optional field retain their timestamp behavior until marked read.

DWS event status may omit `open_dingtalk_id` even for a valid login. Conversation and nickname/group-name adapters validate the required `corp_id:user_id` against the configured profile; the optional open ID is used only when available to normalize self sender IDs. Missing optional metadata must not be reported as an account mismatch.

Client supervision distinguishes `waiting-client` (desktop process unavailable), `needs-authorization` (personal CLI authorization missing, denied or mismatched), and `authorization-error` (verification failed, such as a timeout). These states keep the binding enabled but suspend receiving. Manual starts recheck authorization rather than retaining a cached failure. AIChat displays 飞书消息授权未完成 with 完成授权 for the authorization-required state and reuses its existing scoped Feishu authorization assistant.
