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

Local Helper adds authenticated `/messaging-worker` to its private notify bridge. It opens an
isolated sandboxed BrowserWindow (no Node, nonpersistent partition, at most four windows),
with a lifetime bound to the task timeout. Other hosts use the system browser. The shared daemon
does not depend on Electron. The iframe uses the existing versioned AIChat bridge, empty tool
catalog and an SDK execution sandbox that rejects every tool call, including unsolicited calls.

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
