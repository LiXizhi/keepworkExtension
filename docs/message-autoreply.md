# Message auto-reply service

`src/core/messaging.ts` owns per-account listeners, bounded queues and local task receipts.
`messagingPolicy.ts` validates second-brain rules, restricts knowledge reads and selects triggers.
`messagingDingtalk.ts` uses the native DWS executable with argument arrays (no shell), ready markers,
NDJSON, stable profile IDs and exact reply targets. Existing consumers are never displaced.
`messagingExecutor.ts` owns tool-free Copilot ACP and task-scoped AIChat workers.

AIChat owns the configuration UI and Skill prompt under `.github/skills/message-autoreply/`.
The daemon's local `~/.keepwork-mcp/messaging-v1/` registry is a service binding, not a second brain
registry: root/profile/enabled plus body-free receipts and dedup hashes. Secrets remain in DWS or
CLI-native credential storage; AIChat login stays in process memory. Restart never replays jobs.

HTTP capability: `/health.messagingApi = "messaging-v1"`. Management routes require an allowed
explicit Origin and the configured daemon authentication:

| Method | Route | Payload / result |
| --- | --- | --- |
| GET | `/messaging/config?root=…` | Bindings, current Skill/config and defaults; existing manual rules preserved |
| POST | `/messaging/config` | `{root,profile,config,prompt}`; save and pause listener |
| POST | `/messaging/profiles` | `{root}`; credential-free DWS account identifiers |
| POST | `/messaging/groups` | `{root,profile,query?}`; one bounded page of group identifiers/names |
| GET | `/messaging/status` | Listener state and recent metadata-only receipts |
| GET | `/messaging/events` | Live SSE state snapshots; no message bodies |
| POST | `/messaging/start`, `/messaging/stop` | `{id}`; enable/disable the owned binding |

The no-argument MCP `listen_dingtalk_messages` starts only bindings already enabled in the UI.
The worker HTML at `/messaging/worker#<capability>` strips its fragment immediately.
`/messaging/worker/claim` (POST), `/result` (POST) and `/alive` (GET) require an ephemeral Bearer
capability and `X-Agent-Owner` UUID. Claim is single-use; results are accepted once from its owner.
They never grant access to management endpoints. Worker fetches are same-origin.

The shared daemon lazily launches one headless system Edge/Chrome process using `playwright-core`
and retains it across messaging requests, including concurrent requests. Each task gets a separate
in-memory browser context; completion, cancellation, timeout or failure closes that context.
Daemon shutdown closes the browser, including launches still in progress. Browser crashes fail
in-flight tasks without replay; a later request starts a replacement. Missing browser/startup failures
are reported without opening a visible browser or falling back to the notify bridge. Install Edge/Chrome
or configure `EDGE_PATH` / `CHROME_PATH`. The legacy Local Helper notify endpoint is no longer used.
The iframe uses the existing versioned AIChat bridge, empty tool catalog and an SDK execution sandbox
that rejects every tool call, including unsolicited calls.

Copilot runs in a private per-task directory with a unique custom agent (`tools: []`), no custom
instructions or built-in MCP, explicit tool deny rules and denied permission requests. Only
preselected public text enters the prompt. Other CLI adapters are ineligible until equivalent
restrictions are implemented; use AIChat instead. No fallback after submission/unknown result.
Copilot custom-agent behavior follows the [official configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
and [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), checked 2026-10-16.

The native DWS streaming-card interface accepts text, not arbitrary A2UI components. An explicit
creation rejection falls back to ordinary messages; an unknown result does not. Final update
uncertainty stays visible and never produces a second final reply. Ordinary messages use 6000-byte
UTF-8 chunks with per-part idempotency keys. Calls and progress do not expose hidden reasoning.

Tests: `node --test scripts/messaging.test.cjs scripts/aichat-presence.test.cjs` and
`npm run check:shared`. AIChat's `tests/e2e/messaging.test.mjs` uses Live Server and isolated fixtures.
Actual Copilot/DWS/Keepwork login and reply acceptance require a dedicated account/conversation;
do not count fixture tests as live acceptance or steal an existing listener for verification.

Auto executor selection follows AIChat’s current workspace default backend and its saved model via authenticated presence metadata (memory only). It never substitutes another installed CLI. Missing defaults, unavailable CLI or an adapter without enforced tool denial fall back to keepwork-pro before submission only. Currently Copilot is the implemented tool-free CLI adapter; other defaults are recognized but use the restricted iframe fallback. Explicit executor/model overrides remain supported.


Persona Connect uses `POST /agents/personas/:id/channel-connect` with the verified local brain root. It reuses that persona's persisted binding, otherwise selects the current DWS profile and binds it, preserving existing rules. It starts the listener idempotently and returns real listening status. Empty public knowledge selections are permitted and expose no brain files. Saved enabled bindings resume on daemon restart. Messaging state changes notify persona SSE clients. The UI uses AI repair only on connection failure; unsupported daemon versions require an update, never another CLI install.

Enabled listeners automatically recover from initial transient connection failures and disconnects with exponential backoff (5s to 60s, no retry-count limit). Status is `reconnecting`, includes `nextRetryAt`, and does not invoke AI. Explicit stop cancels retries. Invalid rules, unavailable CLI, invalid authorization and competing listeners require repair. Recovery only recreates subscriptions; it never replays model jobs or delivery attempts.

Known login failures return `needs-login` from persona channel-connect. Explicit `POST /agents/personas/:id/channel-login` runs native `dws auth login` (existing binding profile if present), deduplicates concurrent requests, discards CLI output, waits for completion and reconnects. Background recovery never repeatedly launches browser authorization. The UI handles authorization without an LLM and offers AI diagnosis only after programmatic recovery fails. New devices and revoked credentials can still require DingTalk approval.


## Feishu personal CLI polling

`messagingFeishu.ts` is the personal-user adapter; it never creates a bot, webhook or event subscription. POST `/agents/personas/:id/channel-connect` with `channel: "feishu"` binds the verified appId/userOpenId in the local second brain. Subsequent connections reuse the binding. Enabled bindings resume with the daemon, independently of browser sessions. Snapshots include channel, transport (`polling`), lastPollAt and pollIntervalMs; only a completed sweep sets listening.

Every ten minutes, one tick makes one cross-conversation `im +messages-search` request for the last eleven minutes (one minute of overlap) (50 results maximum), plus identity verification. It never lists chats or polls each conversation. The CLI batch-enriches matching results; one CLI search can therefore involve multiple HTTP requests. Dense windows persist their page token and continue on the next tick, with no auto-pagination burst. Empty windows still cost a search request. Persistent dedup prevents overlap from producing duplicate replies. Transient failures use existing reconnect backoff; scope errors require `search:message` authorization and never fall back to full chat scanning. Search indexing delay can cause missed messages outside the eleven-minute lookback; this is best-effort recent-message polling, not a guaranteed event stream. Downtime is not backfilled except an already pending search page.

Verification: `node --test scripts/messaging.test.cjs scripts/personas.test.cjs`, `npm run check:shared`. Read-only live MCP verification on 2026-10-19 confirmed valid personal user authentication and successful chat/message reads. No real message was sent by acceptance tests.

DingTalk uses event subscriptions only; no self-chat or message-history polling. Self-authored group @me events are accepted, while ordinary self messages and AI reply echoes remain filtered. Live upstream delivery of self mentions still requires verification.
