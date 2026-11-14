# AI Pet: mobile-first development and desktop continuity

Status: accepted. Accepted by the user on 2026-11-13, Asia/Tokyo.

Acceptance record: “Confirmed, this captures our shared understanding. Mark the plan as accepted.”
Repository evidence baseline: `6332c09`. Source inspection only; no builds, native device tests, or service integration tests performed for this plan.

Implementation started on 2026-11-13. Track current work and validation separately in the [M0 implementation record](ai-pet-m0/README.md); the evidence baseline above describes the planning review.

## Purpose and accepted direction

Develop the current AI Pet concept into an AIChat companion for conversation and useful assistance across desktop, iOS, and Android.

| Decision | User answer | Consequence |
| --- | --- | --- |
| Primary purpose | AIChat companion and useful assistant | Center the experience on useful conversations; personality and light interactions support this purpose. |
| Initial audience | New adult consumers, public launch | Plan onboarding, account recovery, permission explanations, support, and public distribution; an existing Keepwork setup cannot be assumed. |
| Delivery order | Mobile first; maintain existing desktop | Investigate mobile architecture and platform constraints first. Preserve both existing desktop implementations while deciding which receives later enhancements. |
| Estimation approach | Milestones as suggested | Establish staffing, external ownership, and integration evidence before assigning dates. The source proposal's 4–6 weeks is not an accepted schedule. |
| Launch markets | Mainland China, US, Spain, South Korea, Japan, France | Validate distribution and service access in all six launch markets before each platform's public launch. |
| First useful jobs | Everyday questions, summaries, planning | Center onboarding and acceptance examples on those tasks. Automatic cross-app reading or remote desktop execution is not selected launch scope. |
| Mobile product | Dedicated pet-focused app; no desktop required | Provide mobile account access, conversation, and voice without requiring a running or paired desktop. See [ADR 0001](adr/0001-independent-mobile-pet-app.md). |
| Continuity | Persona, appearance, conversation history | Map existing identity and history into an explicit cross-device contract. Long-term memory and live voice handoff are separate decisions. |
| Mobile release order | Android first, then iOS | Prove iOS constraints early, then release iOS after Android. Each platform's public release serves all six selected markets. |
| Launch feature floor | Text, Android overlay, iOS widget, and continuous voice conversations | Continuous voice is a launch requirement; repeated tap-to-record alone does not meet it. |
| Voice turn taking | Hands-free conversation with spoken interruption | Capture and echo handling must support interruption during playback; cancel the superseded response and reject stale audio. |
| Voice lifecycle | Continue through other-app use and locked screen | Voice-session ownership must be independent of the visible pet surface. User start/stop, native controls, interruptions, and resource cleanup are release criteria. |
| Desktop launch gate | macOS and Windows continuity at Android launch | M4 is required before M5. Maintain the pet UI; integrate persona/appearance/history and voice-session ownership through existing AIChat owners. |
| Language coverage | Simplified Chinese, English, Spanish, Korean, Japanese, French | All six cover UI, text chat, speech recognition, and spoken replies. Language selection is distinct from home service region. |
| Regional continuity | Home service region; no travel-triggered region migration | Travel retains account service ownership. This is distinct from accepted automatic desktop-history migration. See [ADR 0002](adr/0002-home-service-region.md); region assignment and deployment details remain open. |
| Persona selection | Official character/persona catalog | Offer authorized official characters in onboarding; private custom agents are a separate scope. Verify the canonical catalog contract and rights. |
| Mobile architecture | Kotlin Android; Swift/SwiftUI iOS | Share contracts, assets, and fixtures; retain the existing desktop frameworks. See [ADR 0003](adr/0003-native-mobile-platforms.md). |
| Backend access | Service-owner contracts are a prerequisite | No canonical source/API specification was supplied. M0 owns contract delivery; integration does not assume absent APIs already exist. |
| Existing history | Automatically migrate verified consumer history | Same-account consumer conversations, official-character mapping, and supported exporter required; preserve originals and show status. Private/operational/unfinished/unmapped history stays local. See [ADR 0004](adr/0004-automatic-history-migration.md). |
| Voice concurrency/recovery | One active session per account; deliberate takeover/resume | A second device asks before replacing an active session. Phone-call/recorder/network interruptions pause capture until deliberate resume; app switching and lock do not. |
| Voice business model | Monthly subscription with voice allowance; separately granted free trial | Define server-authoritative entitlement, metering, store reconciliation, and visible exhaustion behavior. Prices and allowance sizes follow cost measurements. |
| Retention | Text until deletion; no retained raw microphone audio | Propagate deletion across devices and prevent reimport; verify provider and backup deletion/retention behavior before launch. |
| Visual scope | Licensed 2D catalog appearances and simple mouth animation | Matching catalog appearance; idle/happy/listening/thinking/speaking/sleeping/error animations. Custom avatars, a skin shop, and 3D are deferred. |

The product interview decisions are settled. The [implementation specification](ai-pet-implementation-spec.md) records the accepted technical baselines, subject to their documented validation gates. Backend/provider/catalog evidence, quantitative service budgets, actual staffing, and distribution-channel details remain explicit implementation gates. “Public launch” is the destination; it does not skip internal or device-testing gates.

The [mobile reference proposal](AI_Pet_iOS_Android_Implementation_Plan.md) is design input. Its section 11 implementation instructions are not authorization to start implementing. This document extends its mobile analysis to the existing desktop products and records changes in scope explicitly. [Terminology](../CONTEXT.md) separates appearance, persona, and conversation.

## Changes from the reference proposal

- Continuous voice is required for launch, replacing the reference proposal's later-phase treatment. A repeated tap-to-record demo is not sufficient evidence for that requirement.
- Android launches before iOS; both mainland China and selected international markets are in the first release's scope.
- A phone works independently of the desktop. Persona, appearance, and history continuity on macOS and Windows is required at Android launch, so desktop maintenance explicitly includes this integration work. A desktop UI rewrite or universal upgrade of desktop voice is not implied by that decision.
- Mobile continuous voice includes spoken interruption, other-app use, and locked-screen continuation; the reference proposal's foreground-only MVP and deferred interruption no longer describe this plan.
- Users choose the official AIChat character/persona catalog. This checkout's private owner-bound persona service is not sufficient evidence of that catalog.
- Eligible existing history migrates automatically, subject to verified account and conversation mapping; the earlier suggestion of manual import was not accepted. Travel still does not trigger region migration.
- Confirmed long-term memory, timed focus sessions/Live Activities, PiP, and remote desktop actions have not been selected as launch requirements. Evaluate any later inclusion explicitly rather than inheriting all reference features.

## Verified starting point

| Area | Existing evidence | Planning implication |
| --- | --- | --- |
| Electron pet | `src/pet/` supplies the shared window, renderer, preload, and permission UI. `apps/aichat-desktop/src/petWindow.cjs` re-exports the shared host. | Maintain the existing host and its behavior; avoid a parallel pet conversation engine. |
| Conversation ownership | `apps/aichat-desktop/src/main.ts` forwards pet commands to the retained main AIChat renderer. Pet snapshots carry a context and chat/persona target. | The current context is not proven equivalent to a durable cross-device conversation or pet ID. |
| Tauri pet | `apps/aichat-rust/src/pet.ts`, `src/petAudio.ts`, and `src-tauri/src/app/pet_host.rs` implement a separate native host and renderer. | Specify shared observable behavior; sharing contracts does not imply sharing native window code. |
| Voice | Tauri supports visible-pet capture with identity/context/document-bound audio delivery; the main page owns recognition and the destination draft. | Mobile needs an explicit lifecycle and conversation owner; it cannot assume a hidden desktop webview runs indefinitely. |
| Permission companion | `apps/pet-companion` launches the pet/permission bubble; `src/pet/companion.cjs` deliberately rejects chat commands. | It is not a ready standalone chatting app. Preserve approval behavior when shared pet UI changes. |
| Local personas | `docs/personas.md` documents machine-local transcripts, requests, approvals, and schedules under owner-scoped `/agents/personas`. | This is not a cloud synchronization backend. Use the accepted migration policy and verified eligibility; do not copy the entire local store. |
| External AIChat | Canonical runtime sources and the browser application are maintained outside this checkout. This repository includes generated runtime copies. | Confirm external maintainers and API availability; changes belong in canonical sources, not generated copies. |
| Mobile | No native Android/iOS application found. `apps/keepwork-family-pad` is an HTML demo with simulated accounts. | Reuse research and UX lessons; budget actual app/authentication work. Mobile icon directories do not establish native app support. |
| Assets | Current snapshots project raster/sprite artwork; no portable licensed character catalog was found. | Define a versioned animation manifest and establish character/voice redistribution rights. |

The proposed `/v1/conversations`, `/v1/voice/sessions`, `/v1/pets`, `/v1/memories`, and `/v1/companion-sessions` routes are unimplemented suggestions in the reference document, not verified existing Keepwork APIs. External equivalents remain an evidence gap.

### Integration evidence from the follow-up inspection

| Capability | Concrete reference | What remains unverified |
| --- | --- | --- |
| Model inference | `src/core/aichatRuntime.ts` sends authenticated requests to `/core/v0/gpt/chat` and handles streaming responses. | Mobile login/refresh and cloud history persistence are not established by this inference contract. |
| Account access | `src/core/aichatPresence.ts` receives credentials from an already authenticated desktop AIChat page; `src/core/messaging.ts` uses `/core/v0/users/profile`. | Independent mobile authentication, recovery, and token lifecycle need canonical API evidence. |
| Existing voice turns | `apps/aichat-rust/VALIDATION.md` describes capture sending to recognition while listening and discarding audio while muted, thinking, or speaking. | Hands-free sequential turns are distinct from speaking over a reply to interrupt it. Full-duplex interruption is not demonstrated by current desktop behavior. |
| Native transcription | `apps/aichat-rust/src-tauri/src/remote_voice/asr.rs` implements a `ready` → PCM16 audio → `asr_end` → `done` protocol at `speechrtc.keepwork.com`, with one-minute segments. | This is a useful protocol reference, not evidence of continuous-call capacity, authenticated mobile entitlement, or a supported public service contract. |
| Regional services and usage | Existing model and speech paths target Keepwork hosts. No pet region-routing or usage-entitlement contract was found in the checkout. | Verify service availability, account/data behavior, voice providers, quotas, and billing with canonical service owners. Absence here does not prove absence in external services. |

The expected sibling AIChat source checkout and configured source overrides were not available in the inspected project locations. The committed runtime is a generated, provenance-backed subset, not the complete frontend or speech SDK. An accessible canonical repository or service contract is an M0 dependency; inventing endpoints does not discharge it.

### Persona catalog evidence

`src/core/personas.ts` lists personas for the exact owner and stores their prompts, models, local brain bindings, and private messages. Its type and HTTP contract do not establish public publication, visibility, licensing, or catalog entitlements. `apps/aichat-rust/VALIDATION.md` mentions an external `official-personas` package, which is evidence of a package name rather than a verified consumer catalog.

Q22 selected official characters rather than private configured agents. The eventual contract needs stable identity/version, eligibility, selection semantics, access revocation, and a separation between persona and appearance. Whether selecting an official template creates a user-owned persona or references a shared definition remains downstream of that catalog evidence. No user's private transcript or prompt becomes public by appearing in a selector.

The migration inspection also found that local user/assistant message rows can include scheduled prompts, peer exchanges, and operational notes. Owner keys bind an Origin and a capability, not a verified cloud account. Role names, avatar/name matches, and a current login are insufficient migration evidence. The actual official-character history exporter remains an external contract dependency.

## Platform constraints

- Android can offer an authorized cross-app overlay, subject to system restrictions and other apps hiding overlays. Its window, input focus, keyboard, and touch regions require native validation. A desktop full-screen transparent canvas is not a portable implementation. See [WindowManager overlay rules](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#TYPE_APPLICATION_OVERLAY) and [touch rules](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_NOT_TOUCHABLE).
- Overlay permission and microphone eligibility are separate. An already-visible overlay is required for the relevant Android 15+ background-start exemption; microphone services have additional while-in-use restrictions. Starting initial MVP voice from a visible Activity is the accepted implementation baseline, not the only legal platform path. See [FGS restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
- A `specialUse` foreground service requires an accurate use-case declaration and review. Treat overlay service/distribution feasibility as an early gate. See [FGS service types](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use).
- iOS should use an app and supported companion surfaces. Widgets have budgeted refreshes and can support simple interactions. They and Live Activities support brief state-update animations, not a continuously executing pet renderer. See [widget refresh](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date) and [animation constraints](https://developer.apple.com/documentation/widgetkit/animating-data-updates-in-widgets-and-live-activities).
- Live Activities fit genuine bounded activities if the product chooses one. Apple documents an eight-hour active limit, up to four additional lock-screen hours, and 4 KB combined state. See [ActivityKit](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities). Their inclusion is not yet accepted MVP scope.
- Video-call PiP does not receive custom view touch events; it cannot supply a general interactive floating pet. See [Apple PiP documentation](https://developer.apple.com/documentation/avkit/adopting-picture-in-picture-for-video-calls). No supported general-purpose transparent cross-app iOS pet surface was identified in these public APIs.

These facts were checked against official documentation during discovery. Recheck target SDK and distribution requirements before implementation and release.

### Continuous voice: accepted capabilities and verification

Q11 and Q12 require all three capabilities below for mobile launch. They remain separate contract capabilities so unsupported older desktop/service peers can degrade accurately. Their implementation and device validation are still pending.

| Capability | Implementation consequence | Feasibility evidence |
| --- | --- | --- |
| Hands-free sequential turns | Detect speech endpoints and return to listening after playback; retain an explicit stop control. | Several turns complete without another record-button press; cancellation and no-speech handling are observable. |
| Background/locked-screen continuation | The native voice owner survives changes to pet/app visibility. iOS uses a genuine audio session/background mode; Android uses a legally started microphone foreground service. | Real-device app-switch/lock tests plus phone-call, permission, competing-recorder, and process-termination behavior. |
| Spoken interruption during a reply | Capture during playback with echo handling; stop playback, cancel the superseded response, and discard its late/queued audio. | User speech is recognized without the pet transcribing itself; speakerphone, headset, and Bluetooth paths are tested separately. |

Apple documents simultaneous input/output and locked-screen audio in [playAndRecord](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord), and background recording through the audio background mode in [record](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record). Android explicitly supports continued background capture through a [microphone foreground service](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone). These APIs support a legitimate active voice session, not indefinite UI execution or permanent microphone availability.

Apple's [voiceChat mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat) needs the appropriate voice-processing audio path for echo cancellation; Android [AEC availability](https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler) varies by device. A suggested M1 experiment is a 15–30 minute multi-turn call including app switching, lock/unlock, incoming call, Bluetooth changes, network loss, mute, and stop. Record observed outcomes rather than treating API availability as a passing device test.

## Architecture and implementation specification

The independent mobile product, stable home service region, native mobile platforms, and automatic eligible-history migration are accepted in ADRs 0001–0004. The [implementation specification](ai-pet-implementation-spec.md) turns those decisions into module responsibilities, contract requirements, work packages, and accepted initial acceptance thresholds subject to M0/M1 validation.

1. Map account, official character, user selection, conversation, appearance, and transcript ownership to canonical AIChat services. New shared history belongs to the account's home-region service; qualify old history through a supported exporter.
2. Build Kotlin Android and Swift/SwiftUI iOS applications with native lifecycle/audio owners; keep pet rendering independent from voice-session ownership. Mobile development does not rewrite the existing desktop hosts.
3. Define capability-negotiated contracts and language-neutral fixtures for presentation state, commands, request identity, cancellation, audio, and asset manifests. Keep platform UI and permission handling native where required.
4. Adapt desktop hosts to approved contracts incrementally. Preserve legacy floating-pet behavior and current renderer ownership until an explicitly approved migration exists.
5. Reuse existing supported backend APIs where verified. Specify missing contracts with external owners before creating a new gateway or service directory.

Repository constraints: applications do not import one another; existing shared runtime stays CommonJS-compatible; generated AIChat runtime copies are not hand-edited; the local MCP daemon stays loopback-only. Mobile integration cannot be implemented by exposing port 8089 on the network. New capabilities must degrade gracefully with older clients and services.

## Purchase and voice-usage integration

The accepted business model is a separately granted free trial followed by a monthly subscription with voice allowance. Prepaid packs are not selected launch scope. The app-granted trial is distinct from a store subscription introductory offer.

Use store-specific purchase adapters with a server-verified entitlement and usage record as the accepted architecture. Keep home service region, current location, purchase channel, and store country separate. A home-region decision does not establish which payment options a storefront permits.

- For Apple distribution, plan StoreKit purchases as the baseline for digital voice access and evaluate actual storefront/program exceptions before release. Apple's payment rules also distinguish subscriptions from purchased credits, which cannot be assigned an expiry indiscriminately. See [App Review payment rules](https://developer.apple.com/app-store/review/guidelines/#payments).
- For Google Play distribution, plan Play Billing as the baseline; applicable alternative programs depend on country and enrollment. Mainland-China Android distribution needs selected channels and their own purchase rules/adapters. See [Google Play payments policy](https://support.google.com/googleplay/android-developer/answer/9858738).
- Server-side verification and reconciliation should handle duplicate or missing notifications, renewal, cancellation, pending transactions, refunds, and restored access. Use the [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi) and [Play backend integration](https://developer.android.com/google/play/billing/backend) as the relevant platform references.

Accepted acceptance baseline: one sandbox purchase → verified grant → voice consumption → reinstallation/sign-in recovery → refund/revocation for each selected purchase channel. No duplicate grant or double-spending after retries or device changes. Track voice use separately from store transactions; the billing unit, session reservation/settlement rules, expiry/refill semantics, and exhaustion UX require the final service contract and product decision.

## Milestones and evidence gates

| Gate | Work | Exit evidence |
| --- | --- | --- |
| M0 — Product and ownership | Use the accepted design; inventory backend/auth support, data ownership, asset rights, and delivery capacity. | Accepted scope, responsible teams, API evidence, and explicitly bounded unresolved dependencies. |
| M1 — Platform feasibility | Test Android overlay/input/service/microphone lifecycle and iOS chosen companion surfaces; validate real authentication, streamed chat, and selected continuous-voice behavior across all six launch markets. | Installable device spikes, recordings/logs, tested OS/device list, documented fallbacks, and measured voice turn/interruption behavior. Mock-backed work is identified separately. |
| M2 — Mobile vertical slice | Onboarding, authorized existing-persona selection, appearance, text conversation, cancellation, reconnection, and shared-history integration. | An adult new user can select an available persona and complete an everyday question, supplied-text summary, and simple planning task; duplicate/late responses and account/persona switches behave correctly. |
| M3 — Companion and continuous voice | Complete Android overlay, continuous voice, and the shared contracts needed by the later iOS app/widget. | Resource cleanup, permissions, turn taking, interruption, offline, and background/lock behavior meet the approved contract on real devices. Text remains usable when voice is unavailable. |
| M4 — Desktop continuity and compatibility | Integrate persona/appearance/history, automatic eligible-history migration, and consumer voice-ownership adapters on macOS/Windows while preserving existing Electron/Tauri UI. | Continuity/migration and cross-device voice exclusion pass on both OSes, including partitioned/legacy clients; compatible chat, approval UI, drafts, drag behavior, and voice cleanup remain correct. |
| M5 — Android public release | Complete M4; evaluate selected countries/devices, six-language scope, support, onboarding, reliability, latency, paid voice entitlements, and power usage. | Installable release candidates, measured results, service ownership, verified billing/restore/exhaustion behavior, release/rollback procedures, and distribution status recorded separately for each market. |
| M6 — iOS public release | Deliver the independent iOS app, widget, and agreed continuous voice; reuse approved contracts and Android integration lessons. | Real-device lifecycle/audio/widget acceptance and market-specific service validation, followed by distribution review and rollout. |

Desktop regression checks run whenever shared behavior changes; M4 is not permission to defer regression discovery until after mobile implementation. Workstream staffing and calendar estimates follow M0/M1 evidence.

M4 must pass before M5. Run mobile work and desktop adapters in parallel after their shared service contract is established; preserving the current desktop UI alone is insufficient evidence of continuity.

## Acceptance and outstanding evidence

- A specific recurring user task and its measurable completion criterion; engagement targets need an agreed baseline and observation window.
- Cross-device scenarios: phone and desktop used concurrently, offline messages, duplicate submission, cancel from another surface, and account/persona switches during generation or playback.
- Separate meanings for cancel generation, stop playback, end recording, hide pet, sign out, delete conversation, and delete confirmed memory.
- A state model that distinguishes conversational activity, emotion, visibility, connectivity, and permission state. The reference document's seven animation labels are useful inputs, but a single enum may conflate independent states.
- Desktop validation preserves existing Electron pet window/lifecycle/renderer tests, Tauri renderer/audio tests, and relevant Rust host tests. Native smoke tests verify focus, capture, monitors, and hit regions; unit tests alone do not establish those outcomes.
- Mobile validation covers denied/revoked permissions, keyboard focus, screen lock, system termination, network loss, audio interruptions, accessibility, reduced motion, and stale companion displays.
- Accepted initial measurable thresholds and device coverage are in the implementation specification; provider availability, actual per-language performance, asset rights, operating costs, and distribution approval require evidence. Text-until-deletion and transient microphone audio are accepted retention requirements.
- For each selected persona, establish its identity, visibility/access rights, prompt/profile portability, and available mobile capabilities. A desktop-bound persona cannot silently claim that its local files or tools are available on an independent phone.
- Meter interrupted turns, concurrent devices, reconnects, trial expiry, purchase restoration, refund/revocation, and exhausted allowance consistently. Billing must not depend on the visibility or liveness of a pet window.

## Design tree and interview record

Round 1 accepted purpose, audience, mobile-first priority, and milestone-based estimation. Round 2 accepted both markets, everyday assistance, an independent pet-focused app, persona/appearance/history continuity, Android-before-iOS, and continuous voice. Round 3 accepted spoken interruption, background/locked-screen voice, macOS/Windows continuity at Android launch, five international languages, a stable home service region, existing-persona selection, and trial-plus-paid voice allowances. Round 4 confirmed six countries and full six-language coverage, native Kotlin/Swift, external contracts as a prerequisite, automatic eligible-history migration, the official persona catalog, single-session/manual-resume voice rules, and monthly subscription allowances. Round 5 accepted verified consumer-history eligibility, text until deletion/transient microphone audio, and 2D catalog appearances with simple mouth animation. Staffing is not yet assigned; missing backend access is an acknowledged M0 dependency.

Product-question frontier: empty. The user confirmed shared understanding of the consolidated plan, technical baselines, work packages, and explicit evidence gates on 2026-11-13. Plan acceptance does not change the recorded implementation or validation status.

Delivery gates retained after plan acceptance:

| Prerequisites | Next decisions |
| --- | --- |
| Consolidated design | Accepted by the user on 2026-11-13; interview and final shared-understanding review complete. |
| Canonical service/catalog/exporter evidence (M0) | Bind concrete identifiers/endpoints, migration formats, persona selection/version semantics, account-region assignment, auth, deletion guarantees, and catalog rights. |
| Provider/store/device evidence (M0/M1) | Select channel/provider adapters, validate language coverage and retention, measure voice cost, and freeze pricing/allowances, operational budgets, and device support before release work. |
| Assigned delivery capacity (M0) | Name accountable owners and estimate calendar dates against the work packages; no unsupported fixed delivery promise. |

Accepted ADRs: [0001 — Independent mobile pet application](adr/0001-independent-mobile-pet-app.md), [0002 — Stable home service region](adr/0002-home-service-region.md), [0003 — Native mobile platforms](adr/0003-native-mobile-platforms.md), [0004 — Automatic eligible-history migration](adr/0004-automatic-history-migration.md). Final confirmation of shared understanding is complete; external evidence gates remain and are not claims of implemented services.
