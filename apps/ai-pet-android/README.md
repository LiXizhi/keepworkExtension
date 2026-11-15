# AI Pet Android — offline development foundation

Version **0.1.0-dev.4**. This standalone Kotlin project implements backend-independent M0 work. It is not a production client, launch catalog, account login, voice service, or billing integration. It imports no sibling app code.

## Components

- `core/`: pure Kotlin voice owner, monotonic lease expiry, session/turn/fencing identities with per-admission local epochs, admission checks, deliberate interruption recovery, mute, idempotent cleanup, simulated lease authority and deterministic audio/transport drivers.
- `core/`: synthetic catalog, account-bound selection, independent home region/language, six locale identifiers (`zh-CN`, `en-US`, `es-ES`, `ko-KR`, `ja-JP`, `fr-FR`) and transient bounded/reduced-motion presentation.
- `app/`: minimal native Activity with explicitly labeled offline controls. It can demonstrate fake start, reply, spoken interruption, network loss, transport restoration, deliberate resume, mute and stop. No audio bytes, credentials, history, raw microphone data or user content are persisted. A non-exported development `specialUse` foreground service owns a real small draggable overlay after explicit Show. It can remain on Home and has in-app, pet-tap and notification Stop controls. Overlay/foreground-service/notification permissions are declared; no network, microphone, billing or boot permission is present. See [service ownership and current evidence](docs/service-overlay-validation.md). The native development UI now has six selectable, independently persisted locales and an original geometric seven-pose pet with synthetic mouth controls. ASR/TTS remain unimplemented. See [presentation validation](docs/presentation-locales-validation.md).
- `scripts/prepare-shared-fixtures.mjs`: reads shared JSON fixtures and translates five explicitly supported voice scenarios to test-only TSV. Unknown scenarios/events/checkpoints fail. The wrong-account migration scenario is explicitly excluded because this app has no migration implementation.

All audio/transport ports are nonblocking, nonthrowing, non-reentrant contracts and called by a serialized owner. Future platform drivers must marshal callbacks onto the owner and convert hardware errors into pause/end events, never throw through cleanup. The current fake ports contain no hardware or consumer endpoint access.

## Run the core

Use JDK 17, Gradle **8.11.1**, Node 22+, and the pinned Kotlin Gradle plugin **2.2.10**:

```sh
./gradlew :core:check --no-daemon
```

Run from this directory. `check` prepares shared fixtures and runs the scenario executable as `:core:coreTest`; it is intentionally dependency-light and does not use JUnit. `:core:test` alone is not the scenario runner. Android plugin resolution is excluded by default so JVM checks do not need an Android SDK.

If Maven resolution is unavailable, the already downloaded Gradle distribution contains a Kotlin **2.0.20** compiler usable for a distinct portable compilation check:

```sh
JAVA_HOME="$PWD/.toolchains/jdk-17.0.21+9/Contents/Home" scripts/check-core-portable.sh
```

The fallback compiles the same production Kotlin sources and test sources, then runs them on the JVM; it does **not** compile Android code or verify the pinned Kotlin 2.2.10 Gradle configuration. Set `AI_PET_GRADLE_LIBS` if the Gradle 8.11.1 `lib` directory is elsewhere. Toolchains and generated outputs are ignored; no system-wide JDK/SDK install or account changes are needed.

## Native Android build

Use Python 3.11+, Node 22+ and JDK 17. The explicit setup installs pinned official SDK archives into the ignored app-local toolchain directory:

```sh
python3 scripts/setup-android-sdk.py
scripts/build-android.sh
```

Android plugin **8.9.2**, Gradle **8.11.1**, Kotlin **2.2.10**, JDK **17**; development minimum API **26**, compile/target API **35**, application ID `com.keepwork.aipet.dev`, versionCode **4**. These are development pins, not a statement of current Play submission eligibility. Production identifiers, signing, target SDK/store qualification remain release gates.

The build entry point runs core scenarios, debug packaging and Android lint, checks prerequisites, and prints the APK path on success. Tool downloads are separate from the build. Optional emulator setup and runtime evidence are described in [native validation](docs/native-validation.md).

Compatibility was checked against primary documentation on 2026-11-13: [AGP 8.9 requirements](https://developer.android.com/build/releases/agp-8-9-0-release-notes), [Kotlin Gradle/AGP compatibility](https://kotlinlang.org/docs/gradle-configure-project.html). Native microphone integration must separately satisfy [Android foreground-service type and permission rules](https://developer.android.com/develop/background-work/services/fgs/service-types).

## Runtime verification on this Mac

After the app-local emulator/system image and initialized `AiPetOfflineApi35` AVD exist, use the verified hardware-renderer profile from this directory:

```sh
python3 scripts/owned_emulator.py start --gpu host --boot-seconds 180
# Only after startup succeeds; stop the owned device even if smoke fails:
(
  trap 'python3 scripts/owned_emulator.py stop' EXIT
  python3 scripts/smoke-emulator.py --attach
)
```

The launcher requires actual hardware GLES in the emulator log and rejects a software fallback. It uses only the owned AVD, emulator ports 5584/5585 and dedicated adb 5039; it does not wipe initialized data or change global AVD settings. Evidence is written under `build/native-evidence/runs`. The optional `python3 scripts/targeted-runtime-checks.py --budget-seconds 300` checks font/Stop and removal/reopen behavior on the retained instance before full smoke. Other platforms can use their supported emulator renderer, but must verify the actual renderer and rerun acceptance; this Mac's auto/software profiles previously produced System UI ANRs. See [diagnosis and exact evidence](docs/runtime-diagnostics.md).

## Lifecycle policy and shared contract mapping

Capture starts only after an explicit start, a matching asynchronous grant, and fresh permission/entitlement/audio-focus/service-start eligibility checks. Lock/background affects presentation only. Phone calls, competing recording, audio-focus loss and network interruption discard playback and pause capture. Restoring transport cannot resume capture. Deliberate resume rechecks native eligibility and the still-live local lease. Muting persists across interruption/resume. End, sign-out, permission revoke, allowance exhaustion, takeover and expiry release audio and the lease, and cancel the owned turn. Late grants are released without disturbing an already active duplicate grant.

Output must match the exact session, fencing generation, current turn and per-admission local epoch (preventing stale output when a different account reuses synthetic identifiers); sequence must increase. Spoken interruption cancels the superseded turn and clears playback before accepting the next turn. A simulated second device needs explicit takeover. The old lease is immediately rejected by the fake authority and stops locally when notified or when its monotonic deadline is reached. The development fixture duration (30 seconds) and shell polling (500 ms while the process is scheduled) are **not** frozen production watchdog budgets or device timing measurements.

The shared `contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json` is consumed at test time. Its five voice scenarios pass through an explicit adapter. The agreed terminal expiry/revoke semantics require fresh explicit admission; the harness asserts native `ENDED` directly against the updated shared checkpoints, without normalization. A fresh explicit start and new lease are required; reconnect and `resume` cannot revive it.

`Lease.fence` corresponds conceptually to shared `leaseGeneration`, and `TurnKey.turn` to `turnGeneration`; Kotlin uses monotonic local expiry, whereas a future service adapter must validate authoritative expiry and derive a bounded monotonic deadline. These are local domain objects, not JSON DTOs. Home-region/device/usage-admission fields and canonical authentication, catalog eligibility/rights, stream codecs, error envelopes, entitlement and release settlement mapping still need verified service contracts. Do not serialize these local classes as if they were the shared schema.

## Evidence and remaining gates

- Pinned Gradle **8.11.1** / Kotlin **2.2.10** / scoped Temurin JDK **17.0.21**: `:core:check` **BUILD SUCCESSFUL**, 23 local scenario groups (including 100 concurrent revoke/output races) + all 5 shared voice scenarios passed.
- Pure Kotlin source compiled and executed on a scoped JDK 17 using the Gradle-bundled Kotlin 2.0.20 compiler: **23 deterministic local scenario groups + all 5 shared voice scenarios passed**.
- Native Android dev.4 debug APK built successfully; lint has 0 errors / 6 development warnings. Final APK full runtime smoke **passed on 2026-11-15**, using verified Apple M5 hardware GLES on the isolated API 35 emulator: six locale selections/persistence, seven poses/preview controls, normal/2x font final Stop, Home/drag, all three overlay Stop paths, revoke/restore and force-stop/reopen without resurrection. Separate early-session checks also passed real reopen interaction and timed Stop acceptance. See [presentation validation](docs/presentation-locales-validation.md) and [renderer/diagnostic evidence](docs/runtime-diagnostics.md). Original tested device settings were restored and read back; owned emulator/adb process and ports verified closed. No physical device tested.
- Real microphone, production-qualified foreground service and cross-app overlay/input behavior, echo cancellation, audio routes, lock/background OS scheduling, interruption latency/power, process-death recovery and permissions: not implemented/device-gated. The shell uses fake resources and ends them on Activity destruction; it is not evidence of native continuous voice.
- Login/recovery, official licensed catalog/assets, history sync/migration/deletion, remote authority/fencing, usage settlement, store billing, regional and six-language service quality: external-gated.
- No production deployment, signing, distribution, real-account copy, microphone use or consumer service connection occurred.
