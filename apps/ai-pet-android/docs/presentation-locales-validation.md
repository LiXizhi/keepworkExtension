# Android dev.4 presentation and locales

Version 0.1.0-dev.4, versionCode 4. This is an offline development shell, not a production voice client or licensed catalog.

## Behavior

The interface language selector supports zh-CN, en-US, es-ES, ko-KR, ja-JP and fr-FR. All six Android resource sets contain 49 matching string keys and format placeholders. Selection is stored only in the app-local development-presentation preference, independently of account, catalog selection and home region. Unknown locales fall back to English; supported language families normalize regional variants. Locale uses a local Configuration context, without changing the device locale. Translation quality still needs native-speaker review.

Changing language recreates the Activity and ends its fake voice session; it does not grant admission, resume capture or start an overlay. An already running overlay keeps its service/window ownership; its accessibility copy and Stop notification refresh from the new locale. No service start token is issued by language updates.

The developer pet is original Canvas geometry, with idle, happy, listening, thinking, speaking, sleeping and error poses. The synthetic mouth slider affects only speaking. There are no imported images, production catalog assets, microphone-derived levels, animation timers or recurring frame callbacks. Drawing occurs on invalidation. Mouth level is bounded and gated by attachment, visibility, Activity activation, screen interactivity, keyguard, the local Reduce motion switch and Android animator enablement. Hidden previews draw nothing. The overlay uses the static idle pose. Existing service permission watchdog polling is not an animation loop.

Controls have scalable text and at least 48 dp minimum heights. The language and pose controls have labels; the pet and slider have localized accessibility descriptions. Full TalkBack, OEM and physical-device accessibility acceptance remains pending.

## Reproduce

Run `scripts/build-android.sh` for resource parity, core scenarios, debug APK and lint. Run `JAVA_HOME="$PWD/.toolchains/jdk-17.0.21+9/Contents/Home" scripts/check-core-portable.sh` for the separate Kotlin 2.0.20 fallback. Use the explicit hardware-GLES launcher and attached smoke commands in [README](../README.md#runtime-verification-on-this-mac) for the owned AOSP API 35 AVD. Generated evidence is ignored under `build/native-evidence`.

In the app, select an interface language, select a pose, choose Speaking and adjust Synthetic mouth level, then toggle Reduce motion and Show preview. The preview does not start services. Overlay behavior still requires explicit permission, notification availability and Show; pet tap, in-app Remove and notification Stop release ownership. No boot restart or saved start admission is introduced.

## Evidence

Both the pinned Kotlin 2.2.10 core check and separate Kotlin 2.0.20 portable check: 23 deterministic groups and five shared scenarios passed. Debug APK assembled. Android lint: zero errors and six warnings. Resource parity: six complete sets, 49 keys each. Native runtime checks are reported in `build/native-evidence/runs/<run-id>/runtime-checks.json` only after the complete smoke run passes; screenshots alone are not proof of all lifecycle behavior.

Core tests explicitly cover all six stored locales, fallback, normalization, failed persistence, all seven poses, every mouth gate and non-finite/out-of-range inputs. No production account, backend, microphone, billing, store submission or physical-device qualification was exercised.

Implementation references: [Android multilingual resources](https://developer.android.com/guide/topics/resources/multilingual-support), [configuration contexts](https://developer.android.com/reference/android/content/Context#createConfigurationContext(android.content.res.Configuration)), [system animator enablement](https://developer.android.com/reference/android/animation/ValueAnimator#areAnimatorsEnabled()). Prior dev.3 service evidence remains in [service-overlay-validation.md](service-overlay-validation.md).

## Current runtime acceptance — 2026-11-15

The final dev.4 APK SHA-256 is `afb8995888d1a3c5f97065c6b32481d33fd598f1cd544b9a04df97d65856da40`. Its system-bar/display-cutout inset fix is now verified at normal and 2x font: the final Stop is fully visible above navigation controls and actual Active→clicked Stop→Ended completed in 8.134 and 17.603 seconds, measured before Start input. Both are below the 25-second gate, excluding the 30-second fake lease expiry as an explanation.

Target `early-target-20261115-001339-def87f` also passed strengthened live-before window/service assertions for in-app Stop and revocation, absence afterward, no resurrection after permission restoration and force-stop/reopen, and a real preview-toggle interaction round trip after both reopens. Font/app-op/notification settings restored exactly. The full long-sequence smoke **also passed** on the same retained host-GLES instance: `20261115-001746-22e38f/runtime-checks.json`, scope `full`. It verified six language selections, French process-restart persistence, all seven poses, preview controls, 2x language selection, permission fallback/Settings intent, Home/drag, three Stop paths, running language-switch service/window invariants, revoke/restore, force-stop/reopen, and final normal/2x Stop at the end. Crash buffer is empty. Font/airplane originals restored exactly; final readback also confirmed original overlay/notification permissions. Emulator PID and dedicated ports were verified closed. All scoped final-APK emulator acceptance gates are complete; real-device and production gates above remain.

The verified renderer is Apple M5 hardware GLES (`host`), recorded by `host-20261115-000732-0fa975`. Prior auto/software startup and later focus ANRs are preserved in [runtime-diagnostics.md](runtime-diagnostics.md), clearly separated from current results. No native source or APK rebuild occurred during stabilization. Harness corrections cover bounded readiness, fresh uniquely named UI dumps, actual foreground and interaction checks, measured system-bar bounds, and slower status-row scrolling at large font.
