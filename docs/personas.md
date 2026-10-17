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

The keepwork-pro worker accepts an optional **host-granted** owner tool callback. Each tool call is bound to worker key, claimant, and call ID; duplicate call IDs execute once. Read/list operations are confined through real paths to the explicitly selected brain. Writes and terminal calls enter persisted visible approval state; opaque approval callbacks remain in memory. Cancellable terminals bypass the user's VS Code terminal and own a separate child process. Third-party workers never receive the callback or owner tools. Unknown calls are rejected at the server boundary as well as the SDK sandbox.

Schedules run daily in an IANA timezone. Next times skip missed wall-clock minutes, jobs do not overlap, duplicate DST wall times do not run twice on a local date, and startup recalculates future deadlines. Runs have durable request IDs. Unknown jobs after restart are not replayed. External targets are opt-in, owner-checked channel/conversation pairs; sending failures are not automatically retried. The old browser scheduler is untouched.

Tests: `node --test scripts/personas.test.cjs scripts/messaging.test.cjs scripts/aichat-presence.test.cjs`; shared type checks: `npm run check:shared`. Browser and real-account acceptance are documented in AIChat `docs/agents.md`.
