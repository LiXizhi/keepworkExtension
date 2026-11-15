# M0 readiness and evidence gates

## Current checkpoint — 2026-11-15

The offline dev.4 mobile runtime slice is accepted in its tested scope: iOS visible checks/restoration passed; unchanged Android final APK now passes both targeted and full API35 emulator smoke on verified Apple M5/Metal host GLES. Normal/2× Stop, strengthened stop/revoke and actual interactive reopen gaps are closed. Settings and dedicated runtime cleanup records were independently reviewed; avatar workloads and iOS were unchanged during this successful Android follow-up. QA harness dev.7 includes five passing independent runtime-evidence tests; root reports all 13 integrated harness tests (8 owner + 5 QA), localization and layout checks passed.

**Production M0 remains open.** Real service/identity/rights/retention contracts, App Group, physical devices, broader OS/OEM/accessibility/performance coverage and distribution qualification remain required. Historical pending/failed checkpoints below are retained chronologically and do not override this current offline-runtime result. Detailed proof and limitations are in [verification](verification.md).

Evidence date: 2026-11-13 (Asia/Tokyo). Accepted baseline: [plan](../ai-pet-cross-platform-plan.md), [specification](../ai-pet-implementation-spec.md), repository `6332c09`. **M0 remains open.** Offline fixtures and native core scaffolds can proceed; no production service integration or release readiness is claimed. Accountable roles below are responsibilities to assign, not invented named people or proof of staffing.

## Current native-tooling status — slice 2

| Area | Current evidence | Remaining boundary |
| --- | --- | --- |
| Android SDK/JDK | App-local JDK 17 and SDK API 35/build-tools installed; official archive checks independently verified | No global SDK/account change needed. |
| Android app | Service overlay dev.3/code 3 APK independently verified through root runner; lint 0 errors/21 development warnings | Declares overlay, FGS, specialUse FGS and notifications permissions only. New API 35 service smoke passed and evidence independently inspected; prior dev.2 Activity-only smoke is historical. Physical devices remain untested. |
| Swift core/storage | Independent core/disk probes pass; executable owner suite 24/24 passes | Host compile is not an iOS SDK build. |
| Full Xcode | Installed Xcode 26.6 (17F113), version plist independently inspected | License/first-launch gate resolved. QA independently built app + embedded Widget using SDK 26.5, dev.3/build 3, ARM64+x86_64. iOS 26.5 simulator install/launch and offline UI observed; generic Widget render/tap and application-level safe/unsupported links now verified; global selection unchanged. |
| External services | Offline fail-closed adapters only | All canonical account/catalog/exporter/voice/billing/retention gates remain open. |

## Initial slice inventory (historical; see current status below)

Commands actually executed: `node --version`, `npm --version`, `python3 --version`, `java -version`, `swift --version`, `xcode-select -p`, `xcodebuild -version`, `xcrun --find simctl`; PATH lookup for `gradle`, `adb`, `kotlinc`, `pod`, `flutter`, `dart`.

| Tool | Observed | Consequence |
| --- | --- | --- |
| Host | Darwin arm64 | Host checks are not Android/iPhone tests. |
| Node / npm | 26.5.0 / 11.17.0 | Built-in `node:test` available for offline contract/conformance checks. |
| Python | 3.14.6 | Documentation/fixture inspection available. |
| Java | `/usr/bin/java` exists but reports no runtime; `/Library/Java/JavaVirtualMachines` empty | A binary path alone is not a functioning JDK. |
| Android | No `gradle`, `adb`, `kotlinc` on PATH; default `~/Library/Android/sdk` absent | No Android APK/device verification from this initial toolchain. A workstream-local compiler, if later provided, proves only its recorded scope. |
| Swift | Apple Swift 6.3.3, arm64 macOS | Pure Swift package/core compilation can run with writable scratch/cache locations. |
| Xcode | Active directory `/Library/Developer/CommandLineTools`; `xcodebuild -version` fails; `simctl` absent; no Xcode app in `/Applications` | SwiftUI/WidgetKit iOS builds, simulator and signed device tests remain unverified. |
| VibeTunnel | `vt title` reports outside a VibeTunnel session | Harmless title update failure; work continues. |

No global tool installation, account/configuration change, microphone capture, or live AIChat request was performed for this inventory.

## Canonical-service evidence inventory

| Repository evidence | What it proves | What it does not prove |
| --- | --- | --- |
| `src/core/aichatRuntime.ts:31` authenticated model request; `src/core/messaging.ts:124` profile fetch | Existing desktop-side call sites | Supported independent mobile login, refresh, recovery, service-region assignment, persisted shared history |
| `src/core/aichatPresence.ts:69–79` receives a desktop login and hashes Origin plus local owner capability | Local ownership/presence mechanism | Verified cloud account identity or eligibility to export local transcripts |
| `src/core/personas.ts`; `src/mcp/personaHttp.ts`; `docs/personas.md` | Owner-bound local private personas and operations | Public official catalog, redistribution rights, cloud synchronization or qualified consumer-history exporter |
| `src/core/vendor/aichat-runtime/manifest.json`; `scripts/sync-aichat-runtime.cjs:6–12` | Generated runtime subset with source revision; expected canonical sibling source | Complete canonical frontend/service repository or API-owner sign-off |
| `apps/aichat-rust/src-tauri/src/remote_voice/asr.rs:14,165` | Existing speech endpoint and segmented PCM/`asr_end` protocol | Continuous mobile call entitlement, regional capacity, full-duplex interruption or one-account lease fencing |
| Accepted plan's external `official-personas` reference | Prior reference to a package name | Verified catalog interface or any character/voice license |

Repository absence means evidence unavailable here, not proof a service does not exist elsewhere. Do not promote the reference proposal's hypothetical routes into live endpoints.

## Gate matrix

All external rows are **OPEN / evidence missing** unless explicitly stated otherwise. Detailed requested artifacts are in [backend contract requests](backend-contract-requests.md). Acceptance cases and execution status are in [verification](verification.md).

| Gate | Required external contract / accountable role | Available / missing evidence | Local work that proceeds | Closure criteria |
| --- | --- | --- | --- | --- |
| G0 Scope | Product owner | Accepted plan/spec and ADRs available | All bounded offline work | **Accepted**; retain approved scope and separate persona/appearance/account. |
| G1 Ownership/canonical sources | Delivery owner + backend owner | Generated subset available; canonical access, assigned team and capacity missing | Document assumptions and interfaces | Accessible canonical source/spec, actual responsible team acknowledgement, package estimates and dependency map; dates based on capacity. |
| G2 Account/region | Identity/backend owner | Existing profile/presence calls; mobile auth/region lifecycle missing | Synthetic account partitions and sign-out tests | Versioned supported login/refresh/revoke/recovery/deletion; authoritative stable account/home-region mapping; sandbox wrong-account/region denial. |
| G3 Official catalog/assets | Catalog/product owner | Local private personas only; catalog and rights missing | Synthetic clearly labelled selections, asset manifest validators | Stable IDs/versions, eligibility and withdrawal policy, approved character/voice rights per market, authorized cache behavior and asset integrity proof. |
| G4 Conversation/stream | History/backend owner | Inference call site; shared-history/order/status API missing | Pending/draft/cursor/late-event models | Canonical append/read/cancel/status/sync; stable request IDs, ordering, uncertain-outcome reconciliation and mixed-capability test evidence. |
| G5 Migration | Desktop + backend owners | Local store cannot attest cloud owner/consumer provenance; exporter missing | Reject-by-default eligibility and import-only fault fixtures | Supported exporter with verified owner/region/official mapping, bounded revisions, stable source identities, batch receipts, no inference side effects, duplicate/crash/multiple-install tests. |
| G6 Deletion/retention | Backend + operations owners | Accepted policy; service/provider/backup guarantees missing | Tombstone/suppression fixtures | Deletion reaches devices/imported mapped copies, suppresses reimport, survives offline/retry; provider/backup schedule and transient raw-audio policy documented and demonstrated. |
| G7 Voice/legacy fencing | Voice + desktop/backend owners | Segmented ASR implementation; mobile lease/admission/TTS/legacy mapping missing | Pure lifecycle, session/turn fencing and watchdog models | Authoritative lease generation/expiry/takeover, all consumer entry points admitted or refused, bounded partitioned-client shutdown; actual provider and regional/language tests. |
| G8 Entitlement/usage | Billing + product owners | Accepted monthly/trial model; commercial/API/channel contracts missing | Synthetic admission, idempotency and exhaustion cases | Verified purchase/restore/refund/revoke; reservation/settlement idempotency, no overlapping grants; units/amounts/refill/cost/text policy agreed. |
| G9 Native feasibility | Android/iOS + QA owners | Host inventory above; device evidence missing | Core state reducers, offline UI and widget projections | Installable native spikes, current/min OS and routes, real lock/background/interruption/resume/cleanup; timing and power evidence with device metadata (M1). |
| G10 Distribution/markets | Release + operations owners | Six markets/languages accepted; channel/signing/access evidence missing | Localization and release checklist | Selected mainland channels/Play/iOS storefronts, signing ownership, policy review, six-market connectivity and six-language ASR/TTS evidence before launch. |

M0 closure requires G1–G8 evidence/ownership resolved to supported contracts, not just placeholder signatures. G9–G10 contain later device/store closure work, but their accountable owners, dependencies and validation plans must be assigned during M0. Never relabel missing required voice/history features as optional launch fallbacks. M4 desktop continuity remains a prerequisite to M5 Android launch.

## Tool/API references checked

Use the built-in [Node test runner](https://nodejs.org/api/test.html), without another QA test framework. Apple states that [simctl and xcodebuild require Xcode](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference). Android's [while-in-use foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) require separate eligibility checks; an overlay or reconnect is not microphone admission. These references guide validation, not a claim that a native service was exercised.

## Toolchain follow-up during the parallel implementation

The Android owner supplied a **repository-local** JDK 17.0.21+9 and Gradle 8.11.1 bundle under `apps/ai-pet-android/.toolchains/`. QA used its bundled Kotlin 2.0.20 compiler to compile and execute core sources in `/tmp`; this supersedes the initial lack of any executable Java for local core validation. It does not install a system JDK or provide an Android SDK/APK/device result. Swift core compilation succeeded with writable module caches. The CLT installation lacks the `Testing` module; the iOS owner replaced that test entry point with a dependency-free executable policy harness. See the final run record in [verification](verification.md).

## Slice 2 tooling verification in progress

QA independently hashed the existing Gradle artifacts and compared them with the [official Gradle checksum reference](https://gradle.org/release-checksums/): Gradle 8.11.1 binary ZIP `f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6`, Wrapper JAR `2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`; both match. The wrapper pins its distribution SHA-256. `git check-ignore -v` confirms Android `.toolchains/` and app build outputs, plus iOS `.build/` and `.cache/`, are ignored. Native SDK installation/build results will replace the initial inventory where demonstrated, rather than being inferred from downloaded archive presence.

Slice 2 independent provenance checks completed: the local Temurin 17.0.21+9 ARM64 macOS archive SHA-256 `78b08c7f5a0598242d5719c022e19479cb4a3aa45c37c19726a757a469ed1c15` matches the [official release checksum](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz.sha256.txt). QA independently retrieved [Google repository metadata](https://dl.google.com/android/repository/repository2-3.xml) and matched all four locked SDK archive names, sizes and published SHA-1 values: command-line tools 19.0, platform 35 revision 2, Build Tools 35.0.0, platform-tools 37.0.1. All four completed local archives match their locks. The publisher metadata for these archives supplies SHA-1; this check must not be described as a publisher-supplied SHA-256 verification. The SDK setup uses official `dl.google.com` HTTPS URLs and verifies the lock before extraction. No alternate mirror was introduced by QA.

## Slice 2 inventory update: Android native build available

The app-local SDK is installed: Android API 35 platform revision 2, Build Tools 35.0.0 and platform-tools 37.0.1 (`source.properties` independently read). An actual debug APK now exists. QA used the installed `aapt2` to inspect the artifact: `com.keepwork.aipet.dev`, versionCode `2`, versionName `0.1.0-dev.2`, min SDK 26, target/compile SDK 35, debuggable, label `AI Pet Offline Dev`. The preliminary baseline APK declared no permissions; the final overlay APK supersedes it and declares only `SYSTEM_ALERT_WINDOW`. This supersedes the initial “Android SDK absent / APK not built” blocker for this slice. Emulator/device runtime, overlay/audio and service integration remain separate evidence gates; completed APK existence alone does not pass them. App-local SDK JARs, debug keystore and generated outputs are ignored by Git.

Optional emulator provenance also independently checked: emulator 37.2.13 ARM64 archive matches the separately fetched Google repository SHA-1; AOSP API 35 ARM64 revision 2 archive matches its independently fetched [system-image metadata](https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml), including full expected byte size and SHA-1. QA did not control emulator lifecycle. The Android owner's tooling documentation records one upstream exception to app-local paths: official ADB may initialize the current user's `~/.android` host-key directory; HOME was not overridden, and no physical device/account was targeted.

## Slice 2 native readiness at original handoff (historical)

Android SDK/toolchain absence is resolved; APK + lint build and isolated API 35 emulator smoke now have evidence. QA independently rebuilt the stable APK and inspected owner-produced runtime logs/assertion manifest/screenshots, without controlling the emulator. Tests covered explicit overlay lifecycle and permission-denied fallback; device/OEM/background audio and consumer service gates remain open.

Full Xcode absence is also resolved: `/Applications/Xcode.app/Contents/version.plist` independently reports **26.6 / 17F113**. The owner attempted the native build and received the Apple license gate (underlying SDK/build command exit **69**). The exact remaining user prerequisite is to open Xcode, review/accept the Xcode and Apple SDK agreements and complete required first-launch components. Root has already asked the user; QA neither accepts the terms nor retries before the user's action. The Simulator SDK's bundle presence does not prove usability. No iOS `.app` or installed widget is claimed. `xcode-select -p` remains `/Library/Developer/CommandLineTools`; future builds use per-command `DEVELOPER_DIR`.

## Current iOS post-license evidence

The user accepted Xcode's license, and QA subsequently observed successful native build through `AIPET_DERIVED_DATA=/tmp/ai-pet-qa-ios-native-dev3 node scripts/build-ai-pet-native.cjs ios` (approved cache access). The app and embedded Widget are real **iPhoneSimulator SDK 26.5** artifacts, development **0.1.0-dev.3 / build 3**, minimum iOS **17.0**, both **ARM64 and x86_64**. Independent artifact inspection and focused Swift voice/disk regression passed. The independent native build log contains no warning/error. **The license and native compilation blockers are resolved; no further user acceptance is required for those steps.**

The iOS owner installed runtime **iOS 26.5 (23F73)** and ran a disposable iPhone 17 simulator. QA read the smoke log and visually inspected the initial screenshots: app install/launch, PID 63896 remaining live in the latest owner run (initial run: 62315), and the dev.3 offline development screen are evidenced. The initial deep-link screenshot shows the system “Open in AI Pet Dev?” confirmation, so successful `openurl` requests do not establish application-level safe-link acceptance or unsupported-link rejection. QA re-inspected the latest screenshots and found the same confirmation boundary. The optional interactive UI attempt is waiting on tool approval; no approval rejection is reported. Read-only filesystem inspection found the app-local `.cache/smoke-devices` directory empty after smoke; the script has bounded shutdown/delete cleanup. This supports disposable-device removal, without claiming a separately logged successful shutdown command. Rendered home-screen Widget, provisioned App Group sharing, physical devices and external service gates remain open.

## Slice 3 current iOS UI evidence

The earlier Open-App prompt limitation is resolved by the owner’s completed interactive run on a dedicated iPhone 17 / iOS 26.5 device, using the unchanged dev.3/build 3 artifact. QA independently viewed `ui-unsupported-link.png`, `ui-widget-home.png`, and `ui-widget-open.png`: the unsupported link is rejected in app, the actual Home Screen Widget displays generic “Preview unavailable / Open offline app”, and Widget tap opens the app’s “No current authorized development preview” state. Safe-link status was recorded by the owner’s accessibility inspection; its standalone screenshot shows the app but crops that status below the viewport. Shared controls remain disabled and voice unavailable. The optional UI approval is no longer pending.

QA read the ownership/cleanup record and confirmed the dedicated normal-inventory device directory is absent; the separate app-local smoke device set is also empty. App Group shared-preview publication/refresh/expiry/sign-out and OS cached-content clearing remain unverified, as do physical devices and external services.

## Slice 3 current local readiness

Contracts and QA are **dev.4**; Android is **dev.3/code 3**, iOS remains **dev.3/build 3**. Compact checkpoint checks pass, including host binding/fresh activation, uncertain-outcome reconciliation, deletion aliases and retained replay fences. This does not erase old journals/backups or supply trusted service identity. Android service native build and API 35 cross-app overlay/Stop/revocation/no-auto-restart smoke pass; QA inspected artifacts, assertions, screenshots and cleanup logs. Lint has 21 development warnings and no errors. iOS generic installed Widget rendering/tap and app-link handling pass in unavailable-sharing mode. Detailed evidence and limits are in verification.md. All authentic backend, provisioning/shared-preview, physical-device and store gates remain open.

## Slice 4 current checkpoint (2026-11-14)

Contracts/QA are dev.5; both mobile artifacts are dev.4/build or code 4. Independent asset probes (5), resource completeness, native core motion/persistence probes and artifact metadata checks pass. iOS resource-aware QA includes the combined reduced-motion/visibility/activity mouth gate and preserved voice/account/disk conformance. Actual App and Widget bundles include the six-locale resource payload. Android APK contains the six locale configurations and retains the four approved development overlay/FGS/notification permissions; lint is 0 errors / 6 warnings. Owner native builds and core suites passed.

New dev.4 UI evidence is **not yet accepted**. Android cold boot timed out before application checks; its retry was stopped to avoid competing with iOS. iOS boot readiness also reached its 600-second limit before the app ran. Device cleanup/final runtime handoff is tracked in verification.md. Prior dev.3 Widget human review and overlay runtime evidence remain historical, not verification of new poses, mouth controls, layout or persisted language. Genuine rights, translation quality, shared App Group/device/service/store gates remain open.

### Slice 4 final bounded checkpoint

The later authorized iOS review-device run supersedes the initial all-UI-blocked status for a limited scope: Japanese language/persistence, Speaking mouth, owner-observed maximum text-size scrolling, generic static Widget and App/Widget language isolation. QA visually confirmed Japanese Speaking and Home Screen Widget screenshots; the saved Dynamic Type image is Home Screen, so App large-text layout remains owner-observed only. Reduce Motion system toggle, all individual poses and unsupported-link delivery are still unverified on dev.4. Review simulator is retained, not cleaned up; dev.3 human review is historical.

Android uncovered an actual bottom-control overlap. Owner fixed ScrollView insets and rebuilt; final hash `afb8995888d1a3c5f97065c6b32481d33fd598f1cd544b9a04df97d65856da40`, lint 0 errors/6 warnings. Final APK runtime remains unverified after bounded boot failures; pre-fix language/pose/overlay partial evidence is not final acceptance. QA probes/resources/build checks pass, but full mobile UI acceptance and external M0 gates remain open.

## Runtime recovery current checkpoint (2026-11-14)

This checkpoint supersedes the earlier Slice 4 UI-pending entries above. QA harness is dev.6; contracts remain dev.5 and mobile artifacts remain dev.4. Five runtime-harness regression checks pass. iOS current visible runtime checks now pass: all seven poses/six languages, actual Reduce Motion comparison, genuine large-text App capture, application-level safe/unsupported links and refreshed Widget tap-open. Installed artifact hashes match; Japanese preference, Reduce Motion and text size were restored. Invisible background mouth state remains policy-test evidence; physical VoiceOver and App Group/service gates remain open.

Android final inset APK remains runtime **UNVERIFIED**. Measured bounded RAM/host-condition/Vulkan comparisons reached OS readiness but repeated System UI ANRs blocked real controls. Traces evidence compositor-service waiting without establishing its root cause. Requested 2048 MiB was actually clamped to 2560 MiB. Original font/airplane settings were read back restored, and owner emulator/private ADB cleanup is evidenced. No pre-fix UI result is promoted to final-APK acceptance.

Root is awaiting the user's decision about temporarily pausing unrelated avatar workloads for one controlled run. No additional run or unrelated workload change is authorized yet. The retained iOS review device was temporarily shut down by root for the controlled comparison; root reboot succeeded, but App launch timed out at 30 seconds; the iOS follow-up observed a white launch surface and no responsive App content. Saved Japanese/large-text/Reduce Motion-off values are preserved, but responsive foreground restoration remains unconfirmed. Earlier successful iOS runtime evidence remains valid. Full mobile runtime acceptance and M0 remain open. Detailed artifact identities, evidence and remaining checks are in [verification](verification.md).

### Authorized recovery follow-up (22:49 JST)

The user authorized one lower-load comparison; root paused the two identified avatar processes under a 20-minute automatic resume guard. iOS has the first runtime slot, Android waits. New outcome and workload restoration evidence are pending; earlier feature evidence and remaining acceptance gaps remain unchanged.

Lower-load iOS follow-up: responsive dev.4 foreground is now confirmed by owner interaction and QA-inspected actual App screenshot. Japanese/large text/Reduce Motion-off remain intact; safe-link state is correct. The earlier white-launch restoration blocker is resolved. Android final runtime outcome and root-owned workload resumption are still pending.

### Lower-load run outcome (23:10 JST)

Final Android APK now has segmented locale/pose/preview, overlay and permission/force-stop lifecycle evidence, superseding the earlier entirely blocked status for those scopes. The full run still does not pass: final normal/2× Stop visibility and actual click remain unverified after a foreground App focus-event ANR and unsuccessful bounded relaunch. QA inspected the ANR main-thread sample (message loop, differing from earlier System UI GPU-query wait); no unique root cause or justified product fix is established.

Dedicated Android AVD/ADB cleanup is documented. The root guard records both paused avatar processes resumed by 23:10:03 JST. iOS recovery succeeded before Android, then the review device was deliberately shut down for serial testing; final post-Android interactive restoration is pending. M0 and full runtime acceptance remain open.

### Final minimized attempt (23:36 JST)

The second authorized lower-load window produced **zero new passing checks**: System UI ANR blocked the actual-UI gate before normal/2× Stop checks. Final APK is unchanged; settings restoration and owned Android runtime cleanup were independently inspected. Previous segmented results do not establish the newly strengthened live-before/absent-after in-app Stop/revoke assertions or stable reopened App UI; those and final Stop remain open. No more Android experiments are planned this turn. iOS review restoration and second-window workload resumption remain pending final confirmation. Production M0 gates are unchanged and open.

Final iOS restoration (23:38 JST) is confirmed by owner-observed dev.4 Japanese UI and responsive scrolling; retained settings remain unchanged. Only second-window host-process resumption confirmation remains pending for environment handoff; Android acceptance gaps above remain open.

### Final environment handoff (23:40 JST)

Both avatar processes were resumed in both authorized windows; QA read guard events, and root verified R/S running states with CPU use afterward. Android dedicated runtime is cleaned; retained iOS dev.4 is responsive with Japanese, large text and Reduce Motion off preserved. Environment recovery is complete. Runtime acceptance remains partial: normal/2× final Stop, strengthened live-before in-app Stop/revoke, and stable reopened UI are unverified; unresolved App/System UI ANRs remain recorded. No production M0 gate is closed by this recovery work.

## Hardware-GLES follow-up (2026-11-15)

QA dev.7 adds three real-helper evidence regressions; all five independent runtime-harness tests pass. Same final APK now passes the formerly open targeted checks on observed Apple M5/Metal GLES: normal/2× complete bottom Stop and real session end, live-before/absent-after in-app Stop/revoke, restored-permission and force-stop interactive reopen without resurrection. QA inspected result records, screenshot and unchanged settings readbacks. Full corrected long-sequence smoke remains pending. Avatar processes and iOS remain unchanged; all external production M0 gates remain open.
