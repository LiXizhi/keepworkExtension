# Implementation Checkpoint

2026-09-21. Inputs: design.md and architecture.md, re-read before implementation/QA.

## Implemented

- Preserved the initial untracked core modules and eight passing tests. Added shared-daemon controller, dedicated pairing token, exact Origin/header authentication and bounded JSON actions. No run_terminal policy changes.
- Daemon advertises `dingtalk-drafts-v1`, restores after successful loopback bind, and awaits owned listener cleanup on shutdown/admin stop. Default store is paused. Missing model credential pauses restoration.
- DWS argv comes from installed shared/event/chat skills and exact listen/send/query-send-status schemas. Retry checkpoints persist cooldown/budgets; interrupted consumers fail closed until operator review. No automatic protection reset.
- Private durable jobs, dedup hashes, retention, explicit source allowlist, private-root/secret-path exclusion, one-at-a-time generation, 30 model attempts/hour, bounded model response/time, unknown-send recovery and exact-draft confirmation.
- AIChat existing global settings mounts a modular panel. Explicit Apply pins the locally mapped global brain, active conversation model and separate background prompt. Dedicated token remains only in panel memory. Setup chat retains normal terminal confirmation and forbids unapproved activation.
- UI supports status, apply, test draft, enable drafting, pause, last 100 jobs, exact-draft send approval and receipt reconciliation. Test jobs cannot be sent.

## Deliberate Limits

`autoSupported` remains false. Installed DWS declares send `confirmation=user_required` and requires concrete action review. Standing unattended send authorization is not established; do not silently append --yes for auto replies. Only a user-confirmed exact draft reaches the send transport.

Only local mapped brains and Keepwork proxy model IDs `keepwork`/`keepwork-pro` are supported. Host environment credential provisioning is manual; no OS credential manager, browser token transfer, model aliases/custom API-key overrides, browser skills/tools, multi-turn history, media understanding, remote brain adapter or automatic wiki ingestion. All approved files are included within a 24KB budget; no broad brain scan.

Model prompt isolation is not a semantic disclosure guarantee. Approve only externally shareable sources and review outbound drafts. Body retention is 1-90 days; dedup metadata stays until capacity is reached. State snapshots are bounded, not an unlimited archive. No offline replay, system service or multi-device leader election. Keep one configured host/default daemon port; abrupt termination blocks uncertain listener restoration instead of risking duplicate consumers.

## QA Scope

Run fake-only tests, exact HTTP authorization checks, non-versioning extension compile, Local Helper build, AIChat binding/neighbor regressions and fixture browser checks. No real subscriptions, model calls, login, installs, messages, commits or releases authorized in this task. Results and live acceptance gates belong in qa-report.md.