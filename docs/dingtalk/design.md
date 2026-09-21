# Background DingTalk Assistant

Stage: design complete, 2026-09-21.

AIChat configures a local, user-owned assistant hosted by the shared Keepwork daemon. Local Helper must remain running, the computer awake and online; Chrome and VS Code are not execution dependencies. No system service, installation, login, subscription or live send is performed during development.

## Flow and defaults

Settings -> pair local integration -> bind selected local-folder brain and model -> explicitly approve shareable source files and model disclosure -> test draft -> enable recording/drafting -> optionally authorize exact recipients. Pause survives restart. Configuration changes pause execution and invalidate sending consent.

Lifecycle: disabled/paused -> starting -> ready -> disconnected/cooldown/blocked. Jobs: received -> generating -> draft -> sending -> sent/failed/unknown. Receive must be persisted before processing. Interrupted sends become unknown, never retried automatically. Recovered backlog is draft-only; no offline replay guarantee.

## Scope

- Personal OAuth DM and @me streams in one pinned DWS profile; no bot app.
- Local folder brain, including a local Git checkout. Remote brains and arbitrary tools are unsupported.
- Explicit file allowlist, realpath confinement, secret/private-directory exclusions and bounded reads. Incoming messages and source excerpts are untrusted data, never authority over recipients or policy.
- Fixed model/prompt snapshot, one bounded model turn, no shell/file-write tools.
- Private inbox/outbox under MCP home, outside the brain and Git; default 30-day body retention. No wiki ingestion.
- AIChat existing settings panel provides setup, binding, status, draft testing, pause, activation and inbox/receipts. Chinese UI follows the existing settings language; no new standalone application shell.
- Dedicated scoped authentication and explicit Origin checks independent of optional global MCP authentication.

## Acceptance

Fake transports prove closed-browser processing, durable deduplication, restart/pause behavior, bounded retry/cooldown, failed writes, restricted retrieval, auth/Origin rejection and unknown send handling. Compile both consumers without packaging/version bumps. Live OAuth, model credentials, subscription payloads, recipient consent and verified delivery remain separately authorized acceptance gates.

Critical dependencies: installed DWS command schema, a supported Node model transport and privately provisioned model credential. Missing dependencies fail closed. Unsupported providers must report errors, never substitute a model.