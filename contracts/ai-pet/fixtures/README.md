# Unpublished portable offline fixtures

`voice-lifecycle-scenarios.json` is a language-neutral event/checkpoint format, not a service wire protocol. Native harnesses may load this JSON directly, initialize their test state from `initial`, translate `steps[].event` into their own core input, and assert each field of `expect` as a partial state checkpoint. No elapsed real time, devices, audio, accounts, or services are implied. `checks` are mock adapter outcomes, never client-provided authorization evidence.

Fields: `session` is active/paused/ended; `capture` and `playback` are booleans; lease and turn generations are positive fencing integers; `accepted` is the outcome of the current output/import operation. Unspecified checkpoint fields are not asserted. A test harness must fail on unknown events, not skip them. All initial voice cases have valid mock permission, admission, lease and audio focus, no playback, and a live connection. Lease expiry or revocation ends the session and disables capture/playback. This is terminal: transport restoration, later interruption events and deliberate resume cannot reopen it. A fresh explicit start and admission are required; fresh admission is outside this scenario executor. Phone/competing-recorder/network interruptions pause an otherwise live session and require deliberate resume. `user-resume` requires all five checks. A spoken interruption increments turn generation and clears playback without ending capture. Migration binding compares the envelope against independently supplied adapter identity.

`positive.json` contains one valid shape per named schema definition. All identifiers and assets are synthetic; the poster file does not exist and its digest is illustrative. `negative.json` contains `{kind,path,value,reason}` mutations of those positives: JSON Pointer `path`, replacement/addition `value`, or removal when null. Semantic scenarios and tests additionally cover valid-shaped but unsafe input. Positive shape fixtures do not pass production authorization.

## Conversation/history scenarios (development revision 1)

`history-scenarios.json` uses `ai-pet.dev.history-scenarios.v1`. Each scenario starts a fresh journal from top-level `initial.binding` and `initial.epoch`. Steps contain either `action` or `reload: true`; reload serializes/restores the synthetic journal and must emit zero effects. `expectState` and `expectEffects` use recursive partial object matching, but arrays have exact length/order. `expectError` is an exact error reason; a rejected step leaves both state and journal unchanged. Unknown actions or fixture formats must fail, not be skipped.

Every action carries the complete context binding (account, home region, character/version, conversation) and a host-issued activation `epoch`. Epochs change on switching away/back, so old callbacks cannot be made current by colliding identifiers. Supported action forms:

| `type` | Additional fields / behavior |
| --- | --- |
| `draft` | `text`; local text only, not delivered history |
| `queue` | `requestId`, `turnId`; captures current draft immutably, clears draft |
| `dispatch` | `requestId`; queued/retry-ready becomes unknown before an append effect; unknown emits only query-outcome |
| `outcome` | `requestId`, matching dispatch `attempt`, `outcome`: unknown/accepted/definitively-absent; trusted synthetic lookup result, never timeout-derived |
| `cancel` | `requestId`; fences later assistant output; no transcript deletion |
| `server` | `event` with positive integer `sequence` and `kind`, described below |

Server event kinds: `message` has one `message`; `import-snapshot` has at most 200 `messages`, each with a previously verified canonical `sourceKey`; `delete-message` has `messageId` and optional established `sourceKey`; `delete-conversation` is terminal for this conversation; `cancelled` has `requestId`. Message fields: `messageId`, `requestId`, `turnId`, `role` user/assistant, `text`, optional `sourceKey`. Normal message deletion never requires an invented source identity. A known source mapping is retained as a suppression key when its mapped message is deleted.

`sequence`/`cursor` are contiguous integers **only for this synthetic protocol**; production may use opaque cursors. Gaps emit `recover-after` and leave accepted history/cursor unchanged, while recording the highest observed recovery target. Replay ordered missing events to that target; ignored gap events are not buffered or silently accepted. Exact duplicate sequence/content is ignored; conflicting reuse fails. Message/source aliases with different payloads fail closed until the real service defines canonical reconciliation. Local time never establishes order.

Effects are data, not executed operations. `append` contains the original identity/text and incremented `attempt`; `query-outcome` includes request ID and attempt; a response with an older attempt is rejected. `definitively-absent` enables an explicit subsequent dispatch of the **same** request ID/content, never automatic replay. Real services must prove authoritative absence and idempotent handling against requests still in flight. These events are injected synthetic authority, not new wire APIs.

## Compact checkpoint scenarios (development revision 1)

`checkpoint-scenarios.json` uses `ai-pet.dev.checkpoint-scenarios.v1`. Each scenario supplies a complete strict checkpoint value and a separate synthetic `host` context. Serialize `checkpoint` and call `restoreCheckpoint(serialized, host)`. Successful loads must emit **zero effects**. `expectError` is an exact load rejection reason; otherwise compare `expectState` recursively as partial object checkpoints with exact array length/order. Optional `nextAction` is passed to the existing history reducer using the restored state. Assert `expectNextError`, `expectNextState` or `expectNextEffects` as provided. Unknown formats must fail. Host values in this fixture are test inputs, not real authorization evidence.

Cases cover query-only unknown recovery, terminal deletion with stale imported data, outstanding cursor gap, wrong host account, saved activation reuse, and old callbacks. Additional executable tests corrupt schema/integrity/state relationships, exercise repeated checkpoint lineages, source-alias pending-text cleanup, delete-before-late-accept mappings and complete replay-fence retention.

## Asset admission fixtures

`asset-bundle.json` has format `ai-pet.dev.asset-fixture.v1`. Convert `resourcesBase64` entries to a Map of decoded bytes and pass `manifest` plus `{approval, nowMs, resources}` to `verifyAssetBundle` in `asset-verifier.cjs`. All approval identities/evidence are synthetic test context, not actual catalog rights. The image is generated colored pixels, not a real character.

`asset-negative.json` is a list of JSON Pointer mutations of that manifest: set `value`, or delete when `remove` is true. Tests may recompute the synthetic approval's manifest digest after mutation to exercise semantic admission rather than only immutable-manifest binding. Every listed mutation must still reject. The executable asset tests additionally generate bad CRC/truncated/overinflating/non-supported-profile data, recompute their file digests and synthetic approval, and require atomic rejection.
