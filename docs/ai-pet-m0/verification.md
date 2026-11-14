# M0 verification ledger and acceptance cases

Date: 2026-11-13 (Asia/Tokyo). **M0 open; offline development evidence only.** This ledger distinguishes coded, compiled, mocked, device-tested and externally integrated states. Synthetic account/lease/entitlement input is not authorization. No live account data, microphone or production network consumer is used.

## Human acceptance and pre-commit verification — 2026-11-14

The user confirmed that the installed iOS Simulator Widget opens the app correctly
and approved committing and pushing the offline foundation. This is a human
Widget-to-app acceptance result, not a claim of backend or audio integration.

The orchestrator reran `node scripts/check-ai-pet-m0.cjs` before committing:
all six components (`contracts`, `android`, `ios`, `qa`, `native-qa`, `layout`)
passed with exit 0. Native build and device evidence remains recorded in the
platform validation documents; no additional native build or device test is
claimed for this commit-only pass. M0 external gates remain open.

## Focused acceptance matrix

These are required behavior cases, not a claim that all are implemented. Local results appear below; unexecuted device/service cases remain open.

| ID | Arrange / action | Required observable result | Evidence tier / owner |
| --- | --- | --- | --- |
| A01 Wrong-account migration | Valid-shaped envelope belongs to B; independently trusted adapter identity is A; repeat with correct account but wrong home region | Refuse before any import/inference/source mutation; return reason, retain originals. Current sign-in, local owner hash or matching display name is insufficient. | Offline semantic fixture, then exporter/backend sandbox |
| A02 Eligibility | Export private, scheduled, peer, channel, tool/system, draft, unsupported/unmapped rows among completed consumer rows | Only verified supported same-account official-character rows eligible; unverifiable rows stay local with counts/reasons; links never followed. | Contract/exporter |
| A03 Uncertain mutation/destructive replay | Accept append/import/delete then lose acknowledgement; restart/reconnect; attempt retry | Query stable request/receipt first; no new request identity or inference replay, no duplicate deletion/grant; unknown status remains explicit. | Contract + service |
| A04 Delete versus migration | Delete before/during/after batch; retry old snapshot from second installation/offline device | Durable tombstone suppresses reimport, mapped copies converge; migration itself never deletes originals; explicit later deletion is honored. | Contract + service + desktop |
| A05 Stale voice output | Play turn N, spoken interruption creates N+1; deliver queued/late N audio and old lease chunks | Playback stops, old chunks rejected; capture can continue for next turn; session/turn/generation all fenced. | Shared fixture + native core; actual timing in M1 |
| A06 Visibility versus interruption | Active session: hide/background/lock; separately inject network loss, call/audio focus loss or competing recorder | Visibility alone preserves session/capture. Actual interruption pauses capture and playback; restored transport/focus does not resume. | Shared fixture + native core + device |
| A07 Deliberate resume | Resume after interruption with each of permission/lease/entitlement/audio focus/native-start eligibility false in turn | Each denial keeps capture off; explicit user action with all checks succeeds. Recreated Android FGS must use eligible visible flow. | Native core + device/service |
| A08 Lease takeover/watchdog | Second device asks takeover; old client connected then partitioned; advance expiry; reconnect with revoked lease | Server fences old sender/spend; local capture/playback stops within measured bound, buffers discarded, old session cannot resurrect. All legacy consumer entry points covered. | Mock expiry core; service/device gate |
| A09 Mute/end/process | Mute then route change/resume; end/sign-out/revoke/exhaustion; kill and reopen app | Mute stays off; terminal actions release capture/playback/lease and settle once; no automatic microphone or uncertain request restart. | Native core + device/service |
| A10 Widget account exposure | Snapshot A; logout/login B; late write of A; open stale deep link; inspect encoded shared snapshot | No transcript, token or private prompt; A data unavailable to B; stale writes/links rejected, logout clears shared store; widget never starts capture. | iOS core encoding + App Group/device |
| A11 Catalog/account switches | Unauthorized/withdrawn/offline selection; switch persona while voice/text active; appearance-only change | No private-catalog invention; authorized cache only; stop/fence account/persona work; appearance change preserves conversation ownership. | Contract + native core |
| A12 Mixed capabilities | New client/old service, old client/new service, new/new; absent/unknown optional fields, downgrade/reconnect | Ordinary chat survives; unsupported feature bounded and explicit; no product-version equality gate, no silent semantic fallback or stale selection. | Synthetic compatibility; live peers later |
| A13 Usage/purchase | Duplicate receipt/settlement, refund, takeover, interrupted turn and exhaustion | Server-authoritative admission, no duplicate grant/charge, no overlapping grants; local purchase flag grants nothing. | Contract fixture; channel sandbox gate |
| A14 Device surfaces | Overlay denied/revoked, IME focus/drag/touch-through/rotation; iOS widget refresh/logout; accessibility/reduced motion | In-app text remains usable; platform behavior matches accepted spec without invisible capture authority. | Real device gate |
| A15 Latency/quality/privacy | 30-minute multi-turn per-language call, app switch/lock, interruptions, speaker/headset/Bluetooth, diagnostics inspection | Spec thresholds measured with sample count/profile: speech-onset stop p95 ≤500 ms, voice first audio p50 ≤2 s/p95 ≤4 s; no raw mic persistence/self-echo; power budgets measured/frozen in M1. | Six-market/language device/provider gate |

Shared fixture reference: `contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json` (`ai-pet.dev.scenarios.v1`). Native adapters must execute every declared supported voice scenario and fail unknown events/checkpoint fields. Migration is a contracts/exporter concern, not a fake native implementation. Passing identical checkpoints demonstrates only these transitions; it does not establish audio-device behavior or service authorization.

## Checks actually run

Initial toolchain probes and service-source inspection are recorded in [readiness](readiness.md). Implementation results and final integration recheck are recorded below. Full Xcode, Android SDK/JDK and real-device checks are initially unavailable. No existing desktop product source was changed by this QA work; broad unrelated app suites are outside this slice.

## Release evidence still required

Record OS/build/device/model, service/spec revision, app development version, fixture revision, network profile, language/market, sample size and observed failures for each run. Keep signed native builds, real-device tests, live-service integration and store review as distinct evidence columns. Desktop regression suites become mandatory when shared desktop behavior changes, and M4 must pass before Android public launch.

Privacy/lifecycle, migration correctness and account isolation are zero-tolerance gates. A passing schema validator cannot establish provenance, licensed assets, cloud authorization, receipt durability, source deletion semantics or physical microphone release. Missing contracts in [backend requests](backend-contract-requests.md) keep their gates open.

## Initial execution record (implementation work in progress)

- `node --test contracts/ai-pet/test/*.test.cjs tests/ai-pet-m0/*.test.cjs`: **47/47 passed** at the first stable contract recheck, including seven independent QA probes. Payload edits with retained digest, self-consistent recomputed digest and injected source IDs are rejected against independent exporter evidence. Destructive clear/delete operations are currently unsupported and fail schema validation; durable deletion execution remains gated.
- Swift package test attempt with scratch/cache redirected to `/tmp`: core compiled after setting `CLANG_MODULE_CACHE_PATH` and `SWIFTPM_MODULECACHE_OVERRIDE`; test compilation failed because this CLT installation has **no module `Testing`**. Initial default module-cache permission errors were avoided by redirecting caches; no host setting was changed. Full Swift Testing results must not be reported as passing on this host.
- A separate Foundation-only QA harness (`tests/ai-pet-m0/ios-conformance.swift`) exercises real core methods without substituting an implementation. Its results and native-owner portable checks are recorded after completion below.
- Independent temporary `npm install --prefix /tmp/ai-pet-m0-qa-deps ... ajv@8.17.1` failed DNS resolution (`ENOTFOUND`). Tests subsequently used the contract owner's installed, pinned local dependency successfully; no global installation was used.

Root review requested terminal lease-expiry/revocation alignment and stale Android account / Swift revocation fencing; those changes were implemented by the owning chats and rechecked below. Do not interpret an earlier ended-to-paused fixture projection as final cross-platform conformance.

## Final semantic review and independently observed results

- Contracts plus QA: **48/48 passed** after terminal expiry/revocation changes. `node --test contracts/ai-pet/test/*.test.cjs tests/ai-pet-m0/*.test.cjs` executes all owner scenarios and seven independent probes.
- Android core: compiled actual owner core/tests with the local JDK 17 and Gradle-bundled Kotlin 2.0.20 compiler (the same fallback flags as `apps/ai-pet-android/scripts/check-core-portable.sh`, output redirected to `/tmp/ai-pet-m0-qa-kotlin`). Executed `com.keepwork.aipet.core.CoreTestKt`: **15 scenario groups plus all 5 shared voice scenarios passed**. Migration explicitly belongs to contracts/exporter. Executed `com.keepwork.aipet.qa.AndroidConformanceKt`: **passed** account-switch output collision and manual-resume checks.
- Swift independent QA: compiled actual `Sources/AIPetCore/*.swift` with `tests/ai-pet-m0/ios-conformance.swift`; executable **passed** visibility, spoken interruption, stale output, manual resume, stale revocation, widget encoded field allowlist and account-switch/sign-out late-write checks. This is macOS-hosted core execution, not an iOS audio/device test.
- Xcode project metadata: `plutil -lint apps/ai-pet-ios/AIPetDevelopment.xcodeproj/project.pbxproj` **passed**. Full Xcode remains unavailable.
- QA Markdown relative-link check **passed**. No product manifests were edited by QA; the QA harness is explicitly `0.1.0-dev.1`, and sibling components own their development versions.

Review items resolved by owning chats and rechecked:

| Concern | Resolution / independent evidence |
| --- | --- |
| Trusted source revision could otherwise authorize altered/injected migration messages | `contracts/ai-pet/index.cjs` now checks payload against immutable adapter message evidence and a computed digest; all three independent payload attacks rejected. |
| Different terminal lease semantics masked by Android ended-to-paused projection | Shared scenarios now require `ended`; Android harness asserts its raw session value; Android 5/5 scenarios pass without normalization. Swift core uses terminal end for expiry/revoke. |
| Android account switch with colliding session/fence/turn could accept old output | Local epoch added to turn identity; independent test starts A then B with identical session/fence and rejects A's old output. |
| Late Swift revocation could terminate a replacement lease | Callback now carries session ID and generation; independent wrong-session/wrong-generation callbacks leave current capture active. |

No unresolved production integration is implied by these fixes. Candidate usage validation remains explicitly distinct from an atomic allowance/settlement ledger. Real deletion/clear execution, exporter provenance, cross-install identity mapping, native adapters, widget persistent App Group/deep-link behavior, provider/legacy voice admission and device performance remain open gates.

### Final integration recheck

QA independently ran `node scripts/check-ai-pet-m0.cjs contracts android ios qa layout` after the sibling fixes: **exit 0**. Final counts supersede the earlier in-progress totals: contracts **41/41**, Android **16 local scenario groups + 5 shared scenarios**, Swift executable policy suite **17/17 (includes all 5 shared voice scenarios)**, independent contract QA **7/7**, repository layout **passed**. The new Android sixteenth group checks concurrent late output/revocation cleanup.

QA also ran `sh tests/ai-pet-m0/run-native-conformance.sh`: **exit 0**, both independent native conformance executables passed against actual core sources, with all generated outputs in a fresh temporary directory. The iOS owner's new dependency-free `AIPetCoreChecks` command resolves the earlier missing-Testing harness blocker; standard `swift test`, native iOS app build and real-device tests are not claimed.

**Closure:** this bounded offline QA slice is complete with no remaining reproduced material failure in the exercised scope. **M0 overall remains OPEN** for canonical service/exporter/catalog/billing/rights evidence and accountable external ownership. Android APK/SDK and iOS application/device validation remain separate unmet gates. No production endpoint, real account migration, microphone activation, publication or store acceptance occurred.

## Slice 2 — native tooling and offline persistence acceptance

Started 2026-11-13 (Asia/Tokyo), after initial offline slice closure. This is a new bounded verification pass; initial-slice evidence above remains historical. External gates remain open. QA does not own SDK installation or emulator lifecycle.

| Case | Independent acceptance evidence required |
| --- | --- |
| S2-01 Tool provenance | Official source URL, pinned version and matching published digest/signature for downloaded JDK/Gradle/SDK tools; actual installed package versions; ignored caches, archives and generated binaries. No global developer-directory change or user login inferred from authorization. |
| S2-02 Native build | Run documented native build with actual SDK/toolchain; verify output app ID/version/permissions, distinguish debug APK from installed emulator/physical-device result and host Swift compile from iOS SDK/Xcode build. |
| S2-03 Development surfaces | Explicit start/stop and permission controls, unmistakable offline/demo status; no production credentials, endpoint, microphone, billing or automatic background activation. Overlay permission denial preserves in-app operation. |
| S2-04 Durable snapshots | Write A, reopen storage, logout and switch B; old A writers and links cannot restore visible A data. Corrupt/truncated/unsupported storage fails closed; deletion persists across reopen; no message/token/private prompt in encoded snapshot. |
| S2-05 History account isolation | Replay journal/snapshot with wrong account or region; refuse it before merging or mutating accepted state. Switching account must not relabel A's pending/accepted records as B. |
| S2-06 Unknown outcomes | Append request loses acknowledgement, persist/reopen/reconnect; retain same request ID and uncertain status, query status before retry, never infer successful delivery or enqueue duplicate inference. Changed payload under same ID is refused. |
| S2-07 Deletion/reordering | Duplicate/out-of-order accepted events, clear/delete before stale append/replay, reopen after tombstone; converge without duplicates or resurrection. Concurrent/newer records are handled explicitly by ordering/revision policy. |
| S2-08 Failure atomicity | Invalid event/corrupt journal/storage failure does not partially mutate accepted state or leave an old account snapshot readable. No durability claim beyond the actual adapter tested. |
| S2-09 Versions/regressions | Affected component dev version and matching manifests/build metadata agree. Prior shared lifecycle, migration and account-fencing tests still pass; no broad unrelated desktop suite. |

Execution results and any actionable findings for this slice will be appended after artifacts are ready. A passing host test alone does not close S2-02 device evidence or external service authority.

### Slice 2 findings and resolution history

- **Resolved (original reproduction):** `contracts/ai-pet/history.cjs:78` requires both `messageId` and `sourceKey` for every `delete-message`, but normal `message` events accept rows without a source key. Independent test `QA history: ordinary accepted message can be deleted without inventing a source identity` fails with `invalid-deletion-binding`. Support ordinary message-ID tombstones without requiring fabricated migration provenance; retain source-key suppression for imported rows.
- Independent recovery/context/atomic-import/deletion-replay probes initially pass (4/5). Full journal account-binding on load and content erasure are still under review; current replay API is a development data model, not a storage authorization boundary.

- **Resolved/rechecked:** ordinary message deletion now accepts a message ID without fabricated `sourceKey`; its independent regression passes.
- **Resolved (original reproduction):** new `QA history: deleted conversation projection does not retain pending plaintext` shows `delete-conversation` retains submitted text in `state.commands`. Current serialized action journal also retains past plaintext. Clear projected command text and distinguish tombstone convergence from actual content erasure; a synthetic replay journal must not claim retention compliance. No production storage/auth implementation is requested by this finding.

- **Resolved (original reproduction):** `apps/ai-pet-ios/Sources/AIPetCore/FileWidgetStorage.swift:26–34` only catches `.fileReadNoSuchFile` while `URL.resourceValues` on the nonexistent initial `widget-snapshot.json` returns `NSCocoaErrorDomain Code=4` (`fileNoSuchFile`) on this host. Independent compiled Swift disk probe fails at normal empty-file setup. Treat both absent-file errors as empty storage, while retaining refusal of actual unsafe/read failures.

- **Resolved/rechecked:** conversation deletion now removes pending command plaintext from the returned state projection; all seven independent history probes pass. The contract README explicitly limits the append-only journal to synthetic in-memory replay and acknowledges retained historical log text, no disk durability/compaction and no production erasure claim. This leaves real retention as an external/storage gate rather than falsely marking it complete.
- Restoration review: raw `restoreJournal` deliberately reconstructs the journal's declared scope and is documented as non-authoritative. Host integration must select the authenticated partition and mint a fresh activation; no production loader exists. Independent wrong-account/region/activation mutations fail. Never use successful replay itself to authorize a restored account or accept callbacks from a prior activation.

### Slice 2 independently completed checks

- Contracts and independent QA: `node --test contracts/ai-pet/test/*.test.cjs tests/ai-pet-m0/*.test.cjs` **74/74 passed** (60 owner checks plus 14 independent probes). Contract version `0.1.0-dev.3` matches both lockfile version fields.
- iOS owner executable suite: QA compiled and ran `AIPetCoreChecks` with scratch/cache paths under `/tmp`: **23/23 passed**, including actual temporary-file replacement/removal, corruption/oversize, deletion failure/retry, symlink refusal and identity-free links.
- Independent Swift disk probe: recompiled actual core sources with `tests/ai-pet-m0/ios-conformance.swift`; **passed** actual file reopen, physical deletion, stale token rejection, corrupt/unknown-schema refusal, cold-start clearing and link rejection. The initial absent-file error is **resolved/rechecked**. Earlier compilation interrupted by sibling file writes was retried after the fix; it is not a remaining compiler defect.
- `plutil -lint` on the Xcode project and widget Info.plist **passed**. Metadata parsing is not an iOS SDK build.
- Root native build runner narrow review: fixed platform allowlist, array arguments/no shell interpolation, sequential bounded builds, nonzero exit on failure, no installation or launch claimed. `--list` succeeded; an unknown platform returned **exit 2** without invoking a build. Android SDK/build/emulator execution remains owned by the Android chat to avoid competing installers or device sessions.

- Android native artifact inspection: `aapt2 dump badging` and `dump permissions` succeeded against the actual debug APK. Observed development identity/version `com.keepwork.aipet.dev` / `2` / `0.1.0-dev.2`, API 26 minimum and 35 target/compile, debuggable, offline label, **no declared permissions**. Snapshot SHA-256: `ad19aad306e6215b2863ccacca91fe4dba2c5bda113cb7c08ad3141ea2c46c35`. This is an APK build/inspection result, not emulator/device execution. Final lint/build-run status will be recorded after the Android owner finishes.

Version/source review for slice 2: contracts package and lock agree at `0.1.0-dev.3`; Android root project and APK agree at `0.1.0-dev.2`/code 2; Swift core and shared app/widget xcconfig agree at `0.1.0-dev.2`/build 2. Both iOS targets inherit the shared version configuration; the widget bundle ID uses the development app's prefix. QA probes are `0.1.0-dev.2`. iOS App Group sharing defaults to unconfigured/unavailable, with optional local configuration ignored by Git; bridge accepts only fixed synthetic preview identifiers and a generic non-identity deep link. Native widget runtime, OS cached-display clearing and provisioning remain untested.

- Android independent `sh apps/ai-pet-android/scripts/build-android.sh --offline` attempt: sandbox initially blocked the Gradle local daemon socket; retry under ordinary approved escalation reached configuration but failed loading Kotlin Android plugin (`KotlinAndroidTarget`, missing `com/android/build/gradle/api/BaseVariant`). This occurred while the Android owner was moving from baseline APK to the overlay development slice. Treat as an open build reproduction until final owner configuration is rechecked, not as a passing rebuild.
- The no-permission baseline APK is **preliminary**, not the final slice artifact: Android owner is adding an explicitly controlled overlay demo. Final permission/lint/APK/runtime evidence must supersede it.
- Swift latest executable suite independently rerun: **24/24 passed**, including concurrent atomic readers. Prior 23/23 count is superseded.

QA paused shared Gradle rebuilds after the transient plugin failure and will wait for the Android owner's declared stable final artifact. Further independent Kotlin probes compile to `/tmp` only; QA does not install/start/stop the emulator. This avoids treating a concurrently changing source/output snapshot as final acceptance.

- Independent Android probe was extended to verify that permission-return/reconcile does not automatically display overlay, denial keeps it hidden, explicit show attaches once, Activity invisibility detaches once, and presentation cleanup does not change the separately active voice core. Actual core source compiled to `/tmp` with the portable Kotlin compiler and the probe **passed**. This remains a policy test, not native WindowManager/input/device evidence.

### Stable Android handoff recheck

After explicit stable handoff, QA ran `node scripts/build-ai-pet-native.cjs android` under the approved Gradle socket permission: **exit 0 / BUILD SUCCESSFUL**. Core **19 local groups + 5 shared scenarios**, `assembleDebug` and `lintDebug` passed. The earlier `BaseVariant` failure is **resolved** by the owner's AGP/Kotlin classloader configuration and is not a remaining blocker.

Final APK `apps/ai-pet-android/app/build/outputs/apk/debug/app-debug.apk` SHA-256: **`b81a2d17104e69d7c4ed0bf596d05fb98d42cafbdc9ea8a9eb576e97e8f1833b`**. `aapt2` independently confirms `com.keepwork.aipet.dev`, `0.1.0-dev.2`/code 2, SDK 26 minimum/35 target, debuggable, and **only `android.permission.SYSTEM_ALERT_WINDOW`**. No INTERNET, microphone, billing, service or boot permission is declared. This supersedes the initial no-permission baseline hash.

Final lint has **0 errors, 15 warnings**: development copy/localization, absent application icon, Android 12+ data-extraction rules and hardcoded left gravity. These are visible remaining development/release-quality tasks; no six-language UI or release-policy qualification is claimed. The app persists no account/history/user audio, and overlay requires explicit Settings permission followed by explicit Show. Returning from Settings alone does not attach it; leaving the Activity removes it. No background-overlay/continuous-voice capability is claimed from this experiment.

### Final Android runtime evidence inspection

Android owner executed the isolated AOSP API 35 ARM64 emulator smoke and stopped its emulator/private ADB server. QA independently read `build/native-evidence/runtime-checks.json`, `launch.txt`, `permissions.txt`, empty `crash.txt`, the emulator shutdown log and the assertion paths in `scripts/smoke-emulator.py`, and visually inspected `overlay-visible.png`. Evidence agrees with install/Activity cold launch (`Status: ok`), permission-denied fallback, native Settings navigation, explicit overlay attach and drag, tap removal, Home/Activity-stop cleanup and no auto-restore. The screenshot visibly labels offline development and shows fake capture false beside the real small overlay.

Permission allow/deny was configured with **emulator-only appops**; Settings navigation was exercised but a completed real-user consent interaction is not claimed. The empty crash buffer establishes no observed fatal Java exception in this bounded run, not crash-free device qualification. Emulator renderer/teardown warnings remain in its log; they did not invalidate these observed assertions/screenshots. Real-device/OEM/rotation/IME/touch-through and sustained background voice remain untested.

### iOS toolchain boundary at slice 2 handoff (historical)

Installed `/Applications/Xcode.app` version plist independently confirms **Xcode 26.6 (17F113)**. Owner native build attempt stopped at Apple agreement acceptance, underlying exit **69**; root has asked the user to review and accept in Xcode. No agent accepted it. No further build retry is appropriate before that action. Installed SDK files are not a passed build or available simulator runtime. The guarded native script reports setup incomplete rather than claiming success. Swift core/storage **24/24**, independent disk/voice probes, and plist checks pass; app/widget host typecheck is owner evidence only. iOS SDK compilation, app artifact, App Group provisioning, installed widget and device tests remain open.

### Slice 2 closure

QA-owned work is complete for the available evidence. No unresolved reproduced behavioral failure remains in the exercised offline/native Android scope. Contracts **60/60**, independent Node QA **14/14**, Android **19 + 5** core scenarios, Android APK/lint root build, isolated Android emulator smoke (owner-run, independently inspected), Swift **24/24**, independent Swift/Kotlin probes and provenance checks pass. Lint retains **15 non-error development warnings**. Versions: contracts `0.1.0-dev.3`; Android/iOS/QA `0.1.0-dev.2`, native build/code 2.

**M0 remains OPEN.** Canonical backend/catalog/exporter/voice/billing/rights/retention gates are unchanged. The only immediate native-toolchain user prerequisite is Xcode agreement/first-launch completion; no permission is inferred from elapsed time. Subsequent iOS build/device and actual service evidence must be recorded separately. No production endpoint, real account migration, microphone activation, publication or release signing occurred.

## iOS post-license continuation

User confirms Xcode license accepted (2026-11-13, Asia/Tokyo). The previous exit-69 license blocker is historical; acceptance alone does not imply SDK build/runtime success. QA waits for the iOS owner's explicit stable handoff before rebuilding, and does not control its simulator/DerivedData concurrently.

Focused acceptance: actual Simulator SDK app build; embedded Widget executable/product and matching development/build versions; generic preview URL scheme; no microphone/camera/background authority or configured real App Group; regression checks for any native compile fixes; owner runtime logs/screenshots and cleanup. App launch, installed Widget, provisioned sharing and physical device remain distinct claims. QA artifact inspector version is `0.1.0-dev.3`; unchanged Android/JS suites are not repeated.

Pre-handoff script review: iOS build now accepts `AIPET_DERIVED_DATA` and places module caches beneath that directory, allowing QA a separate rebuild. The simulator smoke creates only a disposable device in an app-local device set, uses its explicit ID, and has shutdown/delete cleanup. Its process checks and delivered preview/unsupported URLs do not themselves prove visual rejection, installed-widget rendering or App Group sharing; screenshots and separate core assertions must substantiate those narrower claims. QA has not started a competing build or simulator.

### Post-license independent native rebuild — passed

After the iOS owner's explicit stable handoff, QA ran `AIPET_DERIVED_DATA=/tmp/ai-pet-qa-ios-native-dev3 node scripts/build-ai-pet-native.cjs ios`: **exit 0 / BUILD SUCCEEDED**, zero `warning:`/`error:` entries in `/tmp/ai-pet-qa-ios-native-dev3.log`. The initial sandbox-only attempt could not write Xcode/SwiftPM package-manifest caches; ordinary approved escalation resolved that access limitation. The successful build used an isolated output/module-cache tree and did not compete with owner DerivedData or simulator lifecycle. No license acceptance was performed by QA.

The read-only `tests/ai-pet-m0/inspect-ios-artifacts.py` passed on both the handed-off app and the independently rebuilt artifact. Verified app `com.example.keepwork.aipet.dev`, embedded `com.example.keepwork.aipet.dev.widget`, development **0.1.0-dev.3**, matching build **3** and marketing version **0.1.0**, platform `iPhoneSimulator`, minimum OS **17.0**, SDK `iphonesimulator26.5`, Xcode build `17F113`, and actual ARM64+x86_64 Mach-O executables. The Widget extension point and app-prefixed identity are correct; default App Group is unconfigured; no microphone/camera/speech usage string or background modes were added; the app registers only the generic development preview URL scheme. Artifact report: `/tmp/ai-pet-qa-ios-artifacts-dev3.json`. This is development Simulator output, not release signing/store evidence.

QA also compiled actual core sources plus `tests/ai-pet-m0/ios-conformance.swift` using the installed Xcode compiler with separate `/tmp` caches, then ran it: **passed** voice/visibility/interruption/stale-output/revocation, account-safe widget projection, durable reopen/delete/corruption/schema checks and identity-free links. Unchanged Android and Node suites were not repeated. QA inspector/harness version is **0.1.0-dev.3**. The subsequent runtime evidence review is recorded below; M0 external gates stay open.

### iOS simulator evidence review — bounded runtime scope passed

On 2026-11-13 (Asia/Tokyo), QA read the owner-produced `apps/ai-pet-ios/.cache/simulator-smoke.log` and visually inspected both `simulator-launch.png` and `simulator-unsupported-link.png`, including the latest replacement screenshots. Runtime is **iOS 26.5 (23F73)** on a disposable **iPhone 17** simulator in the app-local device set. The latest log records app launch PID **63896** (initial run: **62315**) and the same live process before and after synthetic URL requests. The launch image visibly shows **AI Pet 0.1.0-dev.3**, the offline/synthetic-only notice, language identifier selector and local preview controls. This passes install, launch, bounded process survival and visible offline UI. QA did not rebuild or operate the simulator during this review.

**Interactive deep-link handling remains unverified.** Both `aipet-development://preview` and the unsupported `?account=synthetic-other` URL were submitted, but the screenshot remains at the system **“Open in AI Pet Dev?”** confirmation. It does not show application-level acceptance or rejection. The owner corrected the smoke success wording to distinguish submitted requests from app-level delivery. The optional UI confirmation attempt is waiting on tool approval at this checkpoint; there is no reported approval rejection. Prior core link-validation probes remain passing but do not substitute for interactive runtime evidence.

Cleanup was checked read-only: `.cache/smoke-devices` exists and has **zero entries**, with no remaining device plist/directory. The current smoke script traps exit and performs bounded shutdown/delete against its explicit disposable ID. The empty directory supports device removal; shutdown/delete output is suppressed, so QA does not claim an independently logged successful shutdown return code. No personal simulator or device was operated by QA.

Remaining gates: home-screen Widget installation/rendering and cached-display clearing, provisioned App Group sharing, minimum-OS/physical-device behavior, actual microphone/audio routes and interruptions, sustained power/network behavior, signing/store distribution, six-language quality, and canonical account/catalog/history/migration/voice/billing/rights/deletion services. **M0 remains OPEN.** Native build/artifact/core checks and this bounded simulator launch scope are complete; no further broad regression rerun was needed.

## Backend-independent slice 3 — QA dev.4 in progress

Acceptance targets (not yet passed):

- Compact history: serialized checkpoint excludes deleted text and historical action bodies while retaining deletion/source fences, uncertain request identity/attempt, cursor/recovery and cancellation; original logs/copies remain separate retention obligations. Restore requires all expected binding dimensions and a fresh activation; old callbacks fail even after switching back to the same account. Restore emits no append/inference; uncertain dispatch reconciles rather than replaying. Malformed schema/state fails without partial mutation.
- Android: explicit foreground user action starts the development overlay service; Home preserves the intended cross-app overlay, Stop notification and permission revocation remove it, stale callbacks cannot reattach after stop, and process/relaunch/permission return cannot auto-start it. Native service/notification declarations and actual emulator evidence are distinct from policy probes. No microphone/backend admission is inferred.
- iOS: safe and unsupported deep links must reach visible app outcomes past the OS confirmation; actual home-screen Widget rendering and tap behavior require screenshots/runtime evidence. Generic unconfigured sharing is not real App Group provisioning.

QA waits for explicit stable native handoff, uses isolated build outputs where supported, and does not control owners’ simulators or SDK setup. Only changed/consequential probes will run; unchanged broad suites are not repeated. M0 external contracts, provisioning, physical-device and store gates remain open.

### Slice 3 checkpoint independent probes

The contracts owner handed off dev.4. QA executed the changed history suite (**9/9**) and five new checkpoint probes (**5/5**): source-alias deletion scrubs matching command text; a tombstone preceding acceptance scrubs only once the late user mapping exists; compact serialization excludes deleted payload while the original journal still retains it; canonical and source aliases remain suppressed after restore; all five expected binding dimensions are required; repeated restores reject retired activation callbacks and retain unknown request/attempt for query-only reconciliation; cursor gaps, conflicting old sequence detection and cancellation survive restore. The test explicitly preserves unrelated pending text when no mapping exists. Corrupt payloads and inconsistent state are rejected even after the caller recomputes the digest, without mutating the input. These are synthetic reference-code checks, not disk transactions, authorization, rollback resistance or erasure of existing copies.

### Slice 3 Android policy probe — passed; native handoff pending

QA compiled actual Android core sources plus `AndroidConformance.kt` into an isolated `/tmp/ai-pet-qa-service.*` directory and executed successfully. Changed checks cover service-alive overlay retention, permission-revocation detach, no reattach on permission return, one-use admission, superseded/cancelled token rejection, cross-process nonce isolation and stale-token rejection without consuming the new grant. Existing account collision/manual voice-resume checks in the same small executable also passed. This does not exercise actual Service/NotificationManager/WindowManager behavior; owner emulator evidence and stable native rebuild remain pending.

### Slice 3 iOS interactive runtime review — passed for generic mode

After final handoff, QA read `apps/ai-pet-ios/INTERACTIVE-VALIDATION.md`, `ui-microphone-evidence.json`, and `interactive-device-id.cleaned`, and independently viewed all four `ui-*.png` images. The unsupported-link image visibly reports “Unsupported link.” with disabled shared-snapshot controls and voice unavailable. The Home Screen image shows an actual installed Widget with “Preview unavailable / Open offline app”; the post-tap app image shows “No current authorized development preview.” Safe URL handling past the OS confirmation was observed by the owner through accessibility text; the safe-link screenshot itself crops the status, so that particular result is owner-observed rather than independently visually confirmed. These results supersede the earlier request-only deep-link checkpoint.

Artifact remains **iOS dev.3/build 3**, unchanged product code, iPhone 17 / iOS 26.5 (23F73). The dedicated interactive device **90A8A326-49A5-4798-B478-37B763862488** was created in the normal Simulator inventory, distinct from the app-local smoke set. QA confirmed its directory under `~/Library/Developer/CoreSimulator/Devices` is absent and the app-local smoke set is empty, consistent with owner shutdown/delete verification. The TCC evidence has no microphone authorization rows for app/widget; it does not establish hardware audio behavior. No pending approval remains for these completed checks. No rebuild or Swift regression rerun was necessary for this evidence-only slice.

Closed scope: generic installed Widget discovery/rendering/tap-open, unavailable sharing mode, safe and unsupported app-link outcomes. Still open: real App Group sharing, shared snapshot refresh/expiry/sign-out and cached-display clearing, real accounts/services, physical devices and store gates.

### Slice 3 stable Android independent native build — passed

After stable APK handoff and confirmation that the owner was only operating its emulator, QA ran the root native runner for Android with approved local Gradle socket/cache access. **Exit 0 / BUILD SUCCESSFUL**; log `/tmp/ai-pet-qa-android-dev3.log`. Gradle reused valid incremental outputs (47 up-to-date tasks); this was a successful build verification, not a clean rebuild claim. APK SHA-256: `4fe6dff96407b9663426218db79a0ffdc97456a85b6f6e9b06ac11011e0ea79d`. Artifact is **0.1.0-dev.3 / code 3**. Independent lint XML inspection found **0 errors / 21 warnings**. Owner simulator service evidence remains pending; prior dev.2 Activity-only overlay evidence does not validate this changed service implementation.

`aapt2 dump badging` independently confirms package `com.keepwork.aipet.dev`, SDK 26 minimum/35 target, debug build, and exactly `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`. No microphone/network/boot permission is present. Lint warning groups: 18 development text/localization, 1 backup extraction rule, 1 missing icon, 1 left/right gravity. These remain development/release-quality limitations; specialUse declaration is not store approval.

### Slice 3 Android runtime evidence — passed in isolated API 35 scope

After final owner handoff, QA independently inspected `build/native-evidence/runtime-checks.json`, the corresponding assertion paths in `scripts/smoke-emulator.py`, `launch.txt` (**Status: ok / COLD**), `services.txt` (**nothing**), zero-byte `crash.txt`, and emulator/private ADB shutdown logs. QA visually inspected `overlay-visible.png` (real overlay over the launcher after Home) and `overlay-notification.png` (development notice and **STOP OVERLAY** action). The completed script asserts native overlay movement, Home persistence, pet-tap removal, notification and in-app Stop removing both window/service, permission revocation removing both, and no automatic restoration after permission return, Activity resume or force-stop/relaunch. Actual service start exercises the repaired Display-associated window context path.

Permission setup used emulator-only appops and `pm grant` for notifications; this is not a completed human permission-consent flow. Notification denial/channel revocation, abrupt OS low-memory killing, display removal, minimum API, OEM/physical devices and sustained runtime remain untested. The final no-service dump is after process relaunch; prior stop/revoke absence is established by script assertions rather than separate retained dumps. The empty crash buffer is bounded-run evidence only.

Owner emulator termination appears in `emulator.log`; `adb.log` explicitly records the private server killed by request and emulator transport closure. QA did not operate the emulator. A supplementary process-list query was unavailable in the sandbox, so cleanup attribution relies on those logs and owner completion. The owner adjusted only its disposable AVD resources/wiped test data to address system UI stalls; no product behavior is inferred from that tuning.

### Slice 3 QA closure

QA dev.4 changes are complete. Independent history **9/9**, checkpoint **5/5**, and changed Kotlin policy executable passed; the unchanged 7 contract probes were already covered in root’s integration run, giving **21 independent Node QA cases** across the latest results. Contracts owner/root ran **76 component cases**; the last added checkpoint case was separately executed with all five checkpoint cases. Android root native verification passed **21 local groups + 5 shared scenarios**, APK and lint (**0 errors / 21 warnings**). Android owner-run service runtime evidence and iOS generic Widget/deep-link evidence were independently inspected as scoped above. No unnecessary iOS rebuild or unchanged broad suite was repeated.

No outstanding reproduced defect remains in these exercised synthetic scopes. **M0 remains OPEN** for canonical services, authenticated mappings, retention of external copies, App Group provisioning/shared previews, physical devices and store/distribution qualification.
