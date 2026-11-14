# AI Pet M0 implementation tracking

Started: 2026-11-13, Asia/Tokyo. Scope: implement the accepted plan's backend-independent foundation and make external M0 gates concrete. The [accepted plan](../ai-pet-cross-platform-plan.md) and [implementation specification](../ai-pet-implementation-spec.md) remain the product baseline.

Status: initial offline implementation slice complete and independently reviewed. **M0 overall remains open** for canonical external contracts, ownership, rights, and service evidence.

Human review confirmed on 2026-11-14 (Asia/Tokyo): the user tested the iOS Simulator Widget and confirmed that it opens the app correctly, then authorized committing and pushing the branch. See the [human review record](../../apps/ai-pet-ios/HUMAN-REVIEW.md). This acceptance does not close the remaining external M0 gates.

Current slice (2026-11-13) is complete: compact history checkpoints passed component and independent QA checks; actual iOS deep-link routing and generic Home Screen Widget display/tap checks passed; the user-started cross-app Android overlay passed build, lint and isolated emulator lifecycle checks. No user decision or pending UI approval remains for this delivered scope. External M0 gates remain open.

Native iOS follow-up: full Xcode setup, Simulator SDK builds and independent artifact verification passed. On iPhone 17/iOS 26.5, native UI interaction completed both Open-App confirmations: the safe link showed no authorized preview, while the identity-bearing URL was rejected. The actual Home Screen Widget rendered its unavailable state, and tapping it opened the app without voice activation. The dedicated test device was removed and its absence verified. See [interactive validation](../../apps/ai-pet-ios/INTERACTIVE-VALIDATION.md).

Follow-up slice on 2026-11-13: the same four Astra/medium chats delivered scoped Android tooling and native builds, an emulator-tested Android overlay experiment, durable iOS widget snapshots and Widget Extension source, an offline history reducer/journal, and independent QA. Full Xcode 26.6 is installed. Its original license/first-launch blocker is resolved; SDK compilation now succeeds without waiting for a Simulator runtime.

## Parallel ownership

The user requested multiple conversation sessions using Astra at medium reasoning effort. Four local chats share this checkout with disjoint file ownership. The orchestrator owns integration and this status index; each chat reports its own validation and limitations.

| Chat | Model / reasoning | Owned paths | Chat ID | Status |
| --- | --- | --- | --- | --- |
| AI Pet M0 — Contracts and Fixtures | gpt-6-astra / medium | `contracts/ai-pet/**` | `01a1d0a6-8108-7190-9271-020b39926d0d` | Complete: compact checkpoints, fresh-activation restore and deletion fixes |
| AI Pet M0 — Android Foundation | gpt-6-astra / medium | `apps/ai-pet-android/**` | `01a1d0a6-9b06-79a3-b058-e9193e90acb4` | Complete: cross-app overlay service, native build/lint and emulator lifecycle checks |
| AI Pet M0 — iOS Foundation | gpt-6-astra / medium | `apps/ai-pet-ios/**` | `01a1d0a6-b0a0-7200-b35d-a5b81782a8cc` | Complete: actual deep-link and generic installed-widget checks; device cleaned up |
| AI Pet M0 — Readiness and QA | gpt-6-astra / medium | M0 readiness/request/verification documents; `tests/ai-pet-m0/**` | `01a1d0a6-bb71-75c3-983f-89817f3dcd91` | Complete: independent checkpoint/native checks, final runtime evidence and cleanup review |

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
| [Candidate contract package](../../contracts/ai-pet/README.md) | `0.1.0-dev.4` | Candidate contracts, history reducer/journal and compact checkpoints; expected-binding/fresh-activation restore, query-only uncertain recovery, replay fences and deletion suppression; 76 component checks passed |
| [Android foundation](../../apps/ai-pet-android/README.md) | `0.1.0-dev.3` / code 3 | User-started cross-app overlay foreground service; build/lint passed with zero errors and 21 development warnings; 21 local scenario groups plus five shared scenarios passed. Independent build verification and API 35 ARM64 service lifecycle smoke passed |
| [iOS foundation](../../apps/ai-pet-ios/README.md) | `0.1.0-dev.3` / build 3 | Native App/Widget build and independent artifact checks; prior 24 core checks; iPhone 17/iOS 26.5 actual safe/unsupported link outcomes, generic Home Screen Widget rendering/tap-open and unavailable sharing/voice boundaries verified; no product-code change in this interactive slice |
| [Independent QA probes](../../tests/ai-pet-m0/README.md) | `0.1.0-dev.4` | Twenty-one JavaScript contract/history/checkpoint probes plus Kotlin/Swift native probes; APK/artifact/lint checks, service admission checks and independently reviewed native UI evidence |

The orchestrator separately ran the contract suite and the Android/iOS/QA/layout aggregate successfully. QA independently confirmed the aggregate and native probes. Full run details and the distinction between owner tests and independent probes are in the [verification ledger](verification.md).

## Run the local checks

After preparing the local dependencies/toolchains documented in each component README:

```sh
node scripts/check-ai-pet-m0.cjs
```

This root command runs `contracts`, `android`, `ios`, `qa`, `native-qa`, and `layout`. Pass component names to select a subset, or `--list` for usage. It installs nothing, does not contact consumer services, and returns failure if a required local check/toolchain is missing. The Android fallback compiles core Kotlin with the Gradle-bundled compiler; it is not an APK build. Swift uses the executable assertion harness because this CLT installation lacks the `Testing` module; it is not an iOS device run.

Native builds have a separate entry point after preparing the platform tools:

```sh
node scripts/build-ai-pet-native.cjs android
node scripts/build-ai-pet-native.cjs ios
```

With no platform argument, this command attempts both and reports every failure. Android produces a debug APK and runs lint; iOS produces an unsigned Simulator app. Missing SDK/Xcode fails the requested build rather than silently passing. Build tools can resolve their pinned dependencies; the command does not install SDKs, launch apps, or publish releases. Platform READMEs own toolchain setup and artifact paths.

The latest contracts suite has 76 passing checks and independent JavaScript QA has 21 passing probes. The orchestrator ran the component/QA/layout aggregate and the final added checkpoint probe; all passed. Compact checkpoints remove historical actions and known deleted plaintext from their returned representation, preserve replay/cursor/cancellation/tombstone fences, and require an independently supplied expected binding plus fresh activation to restore. This is a synthetic codec: old journal copies, real disk transactions, authenticity, rollback resistance and secure erasure remain unimplemented. Do not persist real consumer history through these development helpers.

The latest Android emulator smoke verified Home persistence and cross-app drag, pet/in-app/notification Stop, service/window removal, background permission revocation, permission restoration without restart, and forced-process-stop/reopen without resurrection. Test permissions used emulator-only setup; this does not prove a complete real-user consent flow. The final crash buffer was empty; the test emulator/private ADB server were stopped. An earlier System UI ANR was rejected as evidence and the dedicated AVD resource profile was corrected. Reproduction and boundaries are in [service overlay validation](../../apps/ai-pet-android/docs/service-overlay-validation.md); [dev.2 validation](../../apps/ai-pet-android/docs/native-validation.md) remains historical.

Follow-up failures fixed and rechecked: ordinary history deletion incorrectly required migration provenance; deleted conversation state retained pending command text; Swift first-run storage mishandled missing-file errors and cached file metadata; Kotlin/AGP plugin separation broke Android class loading; extracted emulator tools needed local package registration. The user resolved the iOS license requirement; first-launch components are installed, and the build now explicitly selects the Simulator SDK without requiring a downloaded runtime just to compile.

Slice 3 also fixed command-text retention when deleting a source alias or receiving a tombstoned late acknowledgement. Android service window creation now binds an explicit Display and handles missing/uninitialized ownership safely; actual native service creation was verified after the fix. Simulator interaction completed the previously unverified Open-App confirmations and actual widget tap.

Initial integration decisions and review findings:

- Expired/revoked leases terminate the local session and require fresh explicit admission. Network, phone-call, and competing-recorder interruptions pause the session until deliberate resume. Shared fixtures must assert these actual states rather than normalize terminal states into paused states.
- Historical import candidates must bind the actual message payload to independent exporter evidence; matching source metadata and a caller-provided digest alone are insufficient.
- Voice output identity must reject stale data across account/context changes even when external session/generation values collide. Revocation callbacks must be scoped to the lease they revoke.
- The component owners fixed these cases and independent QA verified them. No remaining reproduced material failure was reported in this exercised offline scope.

## Remaining gates and next integration point

- [Readiness matrix](readiness.md): canonical APIs, actual external ownership, catalog/voice rights, and distribution/device evidence are explicitly open.
- [Backend contract requests](backend-contract-requests.md): concrete source/spec/sandbox evidence needed for login, catalog, history/export, deletion, voice leases, and subscriptions. This artifact has not been sent to external teams.
- Android development cross-app overlay/service behavior and iOS generic installed-widget/deep-link behavior have passed the documented emulator/simulator checks. Native microphone/provider audio, provisioned App Group sharing, widget refresh/expiry/sign-out cache clearing, production/OEM/background scheduling, physical-device power and six-market/language service behavior remain separate gates. These local checks do not close them.
- Existing production desktop code and generated AIChat runtime sources were not changed. Desktop history/migration/voice-ownership adapters begin once canonical account/exporter/lease contracts are available.
- Native follow-up requires real development App Group configuration for shared preview behavior, broader OS/device qualification and production service/store evidence. Generic widget rendering and app-link handling are verified and no longer grouped with the untested shared-container behavior.
- Next service integration step: map the unpublished local contracts onto verified service contracts, then add actual platform adapters behind the tested core interfaces. Preserve the current offline development mode for repeatable regression checks.
