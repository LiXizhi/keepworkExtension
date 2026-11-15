# AI Pet M0 implementation tracking

Started: 2026-11-13, Asia/Tokyo. Scope: implement the accepted plan's backend-independent foundation and make external M0 gates concrete. The [accepted plan](../ai-pet-cross-platform-plan.md) and [implementation specification](../ai-pet-implementation-spec.md) remain the product baseline.

Status: slices 1–3 are complete and reviewed. Slice 4 implementation, native builds, offline checks and scoped Android emulator/iOS Simulator acceptance are complete. Android's final-APK targeted checks and full smoke passed on 2026-11-15 with verified hardware GLES; iOS feature checks and review-app restoration passed previously. **M0 overall remains open** for canonical external contracts, ownership, rights, real-device and service evidence.

Human review confirmed on 2026-11-14 (Asia/Tokyo): the user tested the iOS Simulator Widget and confirmed that it opens the app correctly, then authorized committing and pushing the branch. See the [human review record](../../apps/ai-pet-ios/HUMAN-REVIEW.md). This acceptance does not close the remaining external M0 gates.

## Slice 4 — native presentation and asset admission

Started 2026-11-14 after human acceptance and publication of baseline `45c5d12`
on `feat/ai-pet-m0-foundation` in the user's fork. Four existing Astra/medium
chats delivered the following work with their original ownership boundaries:

- Contracts: bounded offline asset admission using independently supplied approval
  evidence and actual resource bytes, with adversarial integrity/binding tests.
- Android: resource-backed six-language selection, accessible geometric developer
  pet poses and synthetic mouth preview; preserve explicit overlay admission and
  Stop behavior across language/lifecycle changes.
- iOS: persisted six-language app selection, static localized Widget and accessible
  geometric developer pet; preserve deep-link/snapshot boundaries and suppress
  motion while inactive or when Reduce Motion is enabled.
- Independent QA: asset rejection probes, native presentation/localization checks,
  regression evidence and current gate accounting.

Source and build handoffs are stable: contracts/QA `0.1.0-dev.5`, Android
`0.1.0-dev.4` / code 4, iOS `0.1.0-dev.4` / build 4. The orchestrator's complete
offline aggregate passed: 102 contract cases, 23 Android local groups plus five
shared scenarios, 27 Swift core checks, 26 independent JavaScript QA cases, native
conformance executables and repository layout. Six-language resource checks also
passed and are now part of the default root command.

Both native builds passed. Android lint reports zero errors and six development
warnings. On 2026-11-15, changing only the emulator's graphics selection to `-gpu host`
selected actual Apple M5 hardware GLES/Metal, with no software fallback. The unchanged
final APK passed both the targeted checks and the complete longer smoke sequence:
six languages, saved-language persistence, seven poses, preview controls, Home/drag,
all three overlay Stop paths, running language-switch ownership, permission
revocation/restoration, and force-stop/reopen without resurrection.

The normal/2× final Stop is fully above the navigation bar; actual Active→clicked
Stop→Ended completed in 8.134/17.603 seconds in the targeted run, measured before
Start input and below lease expiry. Stop/revoke checks prove live window/service
existence before removal. Reopened apps demonstrate a real control change and
restoration. Fresh unique UI dumps reject stale evidence; slower drags prevent
large-text locator overshoot. Thirteen host harness regression checks pass.
Original settings were restored/read back, the crash buffer was empty, and emulator
PID/ports plus dedicated ADB were verified gone. Avatar apps and iOS were unchanged
during this successful run. This hardware profile resolves the exercised runtime
problem on this Mac; the ultimate software-compositor cause is not fully isolated.
See the [diagnostic evidence](../../apps/ai-pet-android/docs/runtime-diagnostics.md)
and [reproducible runtime commands](../../apps/ai-pet-android/README.md#runtime-verification-on-this-mac).

iOS dev.4 visible runtime checks completed
on the retained review simulator on 2026-11-14: all six languages and seven poses,
persisted language preference, synthetic mouth controls, actual OS Reduce Motion,
maximum accessibility text size, safe/unsupported link outcomes, and a tap on the
refreshed static Widget. QA independently checked the installed app/Widget hashes
and the corrected foreground screenshots. Widget language follows the system while
the app retains its selected preference. Hidden background motion suppression is
covered by policy tests, not inferred from a Home Screen screenshot. Earlier failed
attempts remain recorded; previous dev.3 runtime/human evidence is not reused as
acceptance of dev.4 UI. See the current [iOS walkthrough and evidence](../../apps/ai-pet-ios/SLICE4-VALIDATION.md)
and [Android presentation validation](../../apps/ai-pet-android/docs/presentation-locales-validation.md).

The geometric pet is original development artwork, not an official catalog
character. Language coverage does not certify translation or speech quality.
Backend, rights, provisioned App Group, microphone/provider and distribution gates
remain open. The existing human review simulator is retained with dev.4 installed
in Japanese. Dynamic Type was restored and read back as `large`; Reduce Motion was
restored to off and the Speaking slider was enabled again. Root temporarily stopped
this task-owned simulator, preserving its data, for the Android resource comparison.
Its later white launch surface recovered during the user-authorized avatar pause:
launch and safe link took about 0.2 seconds, and actual dev.4 UI responded to scrolling.
After the final Android attempt, the same review device was booted and restored again;
the owner confirmed responsive Japanese dev.4 foreground, `large`, and Reduce Motion
off. Android's owned emulator/private ADB were cleaned up, with original settings read
back. Both authorized avatar processes were resumed and verified running after each
bounded pause: first at 23:09:59–23:10:03 JST, then at 23:40:30 JST on 2026-11-14.
No avatar process remains paused. The dated dev.3 human review stays historical.
On 2026-11-15, the user authorized committing this verified slice and pushing
`feat/ai-pet-m0-foundation` to the `hodokoshitsunagu-arch/keepworkExtension` fork.

Previous slice (2026-11-13) is complete: compact history checkpoints passed component and independent QA checks; actual iOS deep-link routing and generic Home Screen Widget display/tap checks passed; the user-started cross-app Android overlay passed build, lint and isolated emulator lifecycle checks. These are historical dev.3 mobile results. External M0 gates remain open.

Native iOS follow-up: full Xcode setup, Simulator SDK builds and independent artifact verification passed. On iPhone 17/iOS 26.5, native UI interaction completed both Open-App confirmations: the safe link showed no authorized preview, while the identity-bearing URL was rejected. The actual Home Screen Widget rendered its unavailable state, and tapping it opened the app without voice activation. The dedicated test device was removed and its absence verified. See [interactive validation](../../apps/ai-pet-ios/INTERACTIVE-VALIDATION.md).

Follow-up slice on 2026-11-13: the same four Astra/medium chats delivered scoped Android tooling and native builds, an emulator-tested Android overlay experiment, durable iOS widget snapshots and Widget Extension source, an offline history reducer/journal, and independent QA. Full Xcode 26.6 is installed. Its original license/first-launch blocker is resolved; SDK compilation now succeeds without waiting for a Simulator runtime.

## Parallel ownership

The user requested multiple conversation sessions using Astra at medium reasoning effort. Four local chats share this checkout with disjoint file ownership. The orchestrator owns integration and this status index; each chat reports its own validation and limitations.

| Chat | Model / reasoning | Owned paths | Chat ID | Status |
| --- | --- | --- | --- | --- |
| AI Pet M0 — Contracts and Fixtures | gpt-6-astra / medium | `contracts/ai-pet/**` | `01a1d0a6-8108-7190-9271-020b39926d0d` | Slice 4 complete: bounded asset admission and adversarial fixtures |
| AI Pet M0 — Android Foundation | gpt-6-astra / medium | `apps/ai-pet-android/**` | `01a1d0a6-9b06-79a3-b058-e9193e90acb4` | Final-APK targeted and full runtime smoke passed on hardware GLES; tracked launcher and regression checks added; settings/process/port cleanup verified |
| AI Pet M0 — iOS Foundation | gpt-6-astra / medium | `apps/ai-pet-ios/**` | `01a1d0a6-b0a0-7200-b35d-a5b81782a8cc` | Visible dev.4 feature checks complete and QA verified; later launch stall recovered during the authorized lower-load window, saved settings preserved |
| AI Pet M0 — Readiness and QA | gpt-6-astra / medium | M0 readiness/request/verification documents; `tests/ai-pet-m0/**` | `01a1d0a6-bb71-75c3-983f-89817f3dcd91` | Slice 4 bounded review complete; final artifact identities and unverified runtime boundaries recorded |

## Initial slice

1. Produce unpublished candidate contracts with portable fixtures and meaningful ownership/lifecycle validation. Shape validation must never be presented as authentication or verified ownership.
2. Implement independently testable native mobile cores and explicitly offline development shells where the available toolchains permit.
3. Produce a service-owner request checklist and a gate matrix grounded in existing repository evidence.
4. Run targeted component tests and independent QA; fix material findings before reporting the slice complete.
5. Preserve existing desktop behavior. Production account synchronization, migration, provider audio, and paid services remain disconnected until canonical contracts exist.

## Baseline and completion rules

- Baseline repository application-layout check passed before implementation (`node scripts/check-layout.cjs`).
- Global developer selection remains `/Library/Developer/CommandLineTools`. Full Xcode 26.6 (17F113) is installed; the iOS build script selects it per command. License/first-launch setup is complete; physical-device validation remains open.
- No fixed calendar dates are inferred from agent concurrency. External contract ownership remains a real service-team dependency.
- M0 cannot be reported fully complete while canonical authentication, official catalog, verified history export, voice/lease, entitlement, and deletion contracts remain unverified.
- Distinguish source implemented, host tests passed, native app built, device tested, service integrated, and distribution reviewed. A simulated lease, capture device, or backend closes only its local test gate.

## Integration record

Delivered components:

| Artifact | Version | Implemented and verified |
| --- | --- | --- |
| [Candidate contract package](../../contracts/ai-pet/README.md) | `0.1.0-dev.5` | Prior history/checkpoint boundaries plus bounded resource-byte/manifest/approval validation; 102 component checks passed |
| [Android foundation](../../apps/ai-pet-android/README.md) | `0.1.0-dev.4` / code 4 | Six-language UI, geometric poses and synthetic mouth controls; build/lint and 23 local groups plus five shared scenarios passed; unchanged final APK passed targeted and full API 35 hardware-GLES runtime checks, including normal/2× Stop and interactive reopen |
| [iOS foundation](../../apps/ai-pet-ios/README.md) | `0.1.0-dev.4` / build 4 | Six-language app/static Widget and geometric presentation; App/Widget build, packaged-resource checks and 27 core checks passed; dev.4 visible runtime checks complete, including Reduce Motion, large text, every pose/language, link rejection and refreshed Widget tap; separate from dev.3 human review |
| [Independent QA probes](../../tests/ai-pet-m0/README.md) | `0.1.0-dev.5` | 26 JavaScript probes plus Kotlin/Swift resource-aware native probes; six-language completeness, packaged artifacts, motion/persistence and retained security/lifecycle boundaries |

The orchestrator separately ran the contract suite and the Android/iOS/QA/layout aggregate successfully. QA independently confirmed the aggregate and native probes. Full run details and the distinction between owner tests and independent probes are in the [verification ledger](verification.md).

## Run the local checks

After preparing the local dependencies/toolchains documented in each component README:

```sh
node scripts/check-ai-pet-m0.cjs
```

This root command runs `contracts`, `android`, `ios`, `qa`, `localization`, `runtime-harness`, `native-qa`, and `layout`. Pass component names to select a subset, or `--list` for usage. It installs nothing, does not contact consumer services, and returns failure if a required local check/toolchain is missing. Localization checks require Python 3 and verify resource keys, nonempty values and formatting placeholders, not translation quality. The Python runtime-harness group checks bounded readiness, measured system-bar bounds, actual renderer selection, fresh UI capture and control-change assertions without starting a device. The Android fallback compiles core Kotlin with the Gradle-bundled compiler; it is not an APK build. Swift uses the executable assertion harness because this CLT installation lacks the `Testing` module; it is not an iOS device run.

Native builds have a separate entry point after preparing the platform tools:

```sh
node scripts/build-ai-pet-native.cjs android
node scripts/build-ai-pet-native.cjs ios
```

With no platform argument, this command attempts both and reports every failure. Android produces a debug APK and runs lint; iOS produces an unsigned Simulator app. Missing SDK/Xcode fails the requested build rather than silently passing. Build tools can resolve their pinned dependencies; the command does not install SDKs, launch apps, or publish releases. Platform READMEs own toolchain setup and artifact paths.

The latest contracts suite has 102 passing checks and independent JavaScript QA has 26 passing probes. The orchestrator ran the original complete aggregate and then the added localization and runtime-harness groups; all passed. The runtime-harness group includes eight owner tests and five independent QA checks (13 total). Compact checkpoints remove historical actions and known deleted plaintext from their returned representation, preserve replay/cursor/cancellation/tombstone fences, and require an independently supplied expected binding plus fresh activation to restore. This is a synthetic codec: old journal copies, real disk transactions, authenticity, rollback resistance and secure erasure remain unimplemented. Do not persist real consumer history through these development helpers.

The historical dev.3 Android emulator smoke verified Home persistence and cross-app drag, pet/in-app/notification Stop, service/window removal, background permission revocation, permission restoration without restart, and forced-process-stop/reopen without resurrection. Test permissions used emulator-only setup; this does not prove a complete real-user consent flow. That run's final crash buffer was empty; the test emulator/private ADB server were stopped. An earlier System UI ANR was rejected as evidence and the dedicated AVD resource profile was corrected. Reproduction and boundaries are in [service overlay validation](../../apps/ai-pet-android/docs/service-overlay-validation.md); [dev.2 validation](../../apps/ai-pet-android/docs/native-validation.md) also remains historical.

Follow-up failures fixed and rechecked: ordinary history deletion incorrectly required migration provenance; deleted conversation state retained pending command text; Swift first-run storage mishandled missing-file errors and cached file metadata; Kotlin/AGP plugin separation broke Android class loading; extracted emulator tools needed local package registration. The user resolved the iOS license requirement; first-launch components are installed, and the build now explicitly selects the Simulator SDK without requiring a downloaded runtime just to compile.

Slice 3 also fixed command-text retention when deleting a source alias or receiving a tombstoned late acknowledgement. Android service window creation now binds an explicit Display and handles missing/uninitialized ownership safely; actual native service creation was verified after the fix. Simulator interaction completed the previously unverified Open-App confirmations and actual widget tap.

Initial integration decisions and review findings:

- Expired/revoked leases terminate the local session and require fresh explicit admission. Network, phone-call, and competing-recorder interruptions pause the session until deliberate resume. Shared fixtures must assert these actual states rather than normalize terminal states into paused states.
- Historical import candidates must bind the actual message payload to independent exporter evidence; matching source metadata and a caller-provided digest alone are insufficient.
- Voice output identity must reject stale data across account/context changes even when external session/generation values collide. Revocation callbacks must be scoped to the lease they revoke.
- The component owners fixed these cases and independent QA verified them. No remaining reproduced material failure was reported in this exercised offline scope.

## Remaining gates and next integration point

- The scoped Android/iOS runtime gaps are closed. Future regressions can use the [tracked hardware-renderer workflow](../../apps/ai-pet-android/README.md#runtime-verification-on-this-mac), which verifies actual GLES selection and preserves settings. This successful run did not pause avatar apps or alter iOS. Physical-device qualification and service integration remain separate next milestones; no user decision is pending for the completed emulator checks.
- [Readiness matrix](readiness.md): canonical APIs, actual external ownership, catalog/voice rights, and distribution/device evidence are explicitly open.
- [Backend contract requests](backend-contract-requests.md): concrete source/spec/sandbox evidence needed for login, catalog, history/export, deletion, voice leases, and subscriptions. This artifact has not been sent to external teams.
- Android development cross-app overlay/service behavior and iOS generic installed-widget/deep-link behavior have passed the documented emulator/simulator checks. Native microphone/provider audio, provisioned App Group sharing, widget refresh/expiry/sign-out cache clearing, production/OEM/background scheduling, physical-device power and six-market/language service behavior remain separate gates. These local checks do not close them.
- Existing production desktop code and generated AIChat runtime sources were not changed. Desktop history/migration/voice-ownership adapters begin once canonical account/exporter/lease contracts are available.
- Native follow-up requires real development App Group configuration for shared preview behavior, broader OS/device qualification and production service/store evidence. Generic widget rendering and app-link handling are verified and no longer grouped with the untested shared-container behavior.
- Next service integration step: map the unpublished local contracts onto verified service contracts, then add actual platform adapters behind the tested core interfaces. Preserve the current offline development mode for repeatable regression checks.
