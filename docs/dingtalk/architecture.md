# Technical Architecture

Stage: visible Chrome replies, 2026-09-22. Input: design.md.

An in-process Node host that imports AIChat and calls `sendChatMessage` directly is **not implemented**. It is recorded in [node-host-alternative.md](node-host-alternative.md). Live replies use a dedicated visible Chrome window.

## Ownership and files

- `src/core/dingtalk.ts`: typed private durable state, restricted retrieval, bounded Node Keepwork model adapter, per-conversation Chrome replies, and send policy.
- `src/core/dingtalkChrome.ts`: visible dedicated Chrome, anti-throttle launch flags, one persistent tab per DingTalk group or person.
- `src/core/aichatPresence.ts`: in-memory latest AIChat page URL and login. Not written to disk. Session close does not erase it.
- `src/core/dingtalkDws.ts`: argument-only CLI discovery, supervised NDJSON subscriptions, bounded retries, receipt queries.
- `src/mcp/dingtalk.ts`: mandatory dedicated Bearer token, exact Origin policy, bounded JSON routes. `reply` mode does not require `KEEPWORK_DINGTALK_MODEL_TOKEN`.
- `src/mcp/http.ts`: advertise capability, restore only after successful loopback bind, stop on host shutdown.
- AIChat `js/dingtalk_connection.js`: existing settings panel controller/template, memory-only pairing token; explicit bind of selected brain/model. No cloud profile modifications.
- Focused Node tests use temporary homes and fake transports; no production subscriptions or message bodies.

## State, security and storage

One integration per daemon, pinned profile, self identity, local brain root, exact relative Markdown/text source list, Keepwork proxy model and prompt. Source content and incoming text are data only; no tools are offered. Global serialized processing is deliberately stricter than per-conversation serialization, concurrency one, backlog maximum 100. Model input/output and request duration are bounded. State snapshots use write/fsync/rename; failed writes prevent processing or sending. Dedup hashes survive body expiration. Retention is 1-90 days, default 30. Interrupted sending becomes unknown; interrupted generation becomes draft-only recovery. No offline catch-up.

Dedicated token at MCP home `dingtalk/pairing-token`, never exposed by health or unauthenticated routes. Allowed browser Origins: HTTPS keepwork.com/cdn.keepwork.com and HTTP localhost/127.0.0.1. No missing Origin, opaque Origin or query-token authorization. Browser keeps token in memory, not localStorage/profile. Model token is provided only by host environment `KEEPWORK_DINGTALK_MODEL_TOKEN`, never accepted by HTTP or stored in config. Host deployment must provision that environment privately; this version does not install an OS credential manager. Missing credential blocks generation and activation.

## Verified transport and authorization boundary

Keepwork SDK `src/ai-chat/AIGenerators.base.ts` chatViaProxy is the contract: POST `https://api.keepwork.com/core/v0/gpt/chat`, Bearer token, `{model,messages,stream:false,max_tokens}`, response `{result}`. Only Keepwork built-in proxy model IDs are supported initially; direct/local/custom providers are explicitly rejected. No chatId/modId, tools or cloud history requested.

DWS dynamically resolves installed npm launcher/PATH, no installation/authentication. Two managed consumers use pinned `--profile`, `event +listen-im --kind all-direct|at-me --flatten -f ndjson`. Drain both pipes, detect stderr ready, stop by stdin close, bounded buffers. Retry budgets false/true/unknown = 0/2/1, honor cooldown and terminal_hold. Retry metadata never contains raw stderr.

`POST /dingtalk/enable` with `{ mode: "reply", consent: true }` listens to `all-direct` and `at-me` and answers in a visible Chrome window. The daemon launches its own Google Chrome (Edge only if Chrome is not installed) with a dedicated user-data directory `~/.keepwork-mcp/dingtalk-chrome`. The window is not headless. Launch flags disable background timer throttling, renderer backgrounding, occluded-window pausing, Memory Saver, and tab discarding. The profile preference `performance_tuning.high_efficiency_mode.state` is `2` (off). Each group (`group:<conversation_id>`) and each 1:1 person (`dm:<sender_open_dingtalk_id>`), including a chat with yourself, has one tab and one AIChat conversation. A copy of a reply this daemon just sent is ignored so it does not start another turn. Later notes you write yourself still do. Later messages append there, so history and the page’s existing auto-compact run. Different threads run at the same time, up to 8 tabs; a ninth waits. The page is the remembered AIChat URL with the login injected before boot, not placed in the address bar. The worker holds a Web Lock and does not register as the latest AIChat client.

The reply is sent to that same chat. Unknown delivery is not resent. `draft` mode remains the confirm-to-send model path and still needs `KEEPWORK_DINGTALK_MODEL_TOKEN`. Receipt query determines sent/failed/unknown.

## Milestones and deviations

1. Durable runner and confinement tests.
2. Typed DWS transport and isolated supervisor tests.
3. Authenticated routes and shared lifecycle tests.
4. AIChat existing-settings integration and browser/source tests.
5. Compile consumers, focused regression, qa-report.md.

Existing repository architecture wins over a new H5 skeleton: shared Node CommonJS TypeScript and existing no-build AIChat settings/CSS remain. No new HTML entry, Tailwind dependency, fonts, SDK migration or release artifacts. Existing AIChat brain picker and setup-chat confirmations stay unchanged. The settings controller owns its template/events; business logic stays in the daemon. No new visual assets are needed for an existing settings form.