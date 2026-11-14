# Cross-app overlay development service — 0.1.0-dev.3

This replaces the prior Activity-scoped experiment with an explicitly user-started synthetic overlay owned by a non-exported native `OverlayService`. The previous [native build evidence](native-validation.md) is retained as a dev.2 historical record. No microphone, consumer network service, backend, billing or real account data is used.

## Ownership and stop behavior

- Only Show in the visible Activity issues a one-use, process-local admission token and calls `startForegroundService`. Permission return never starts anything. The service validates the token and both overlay/notification availability before attaching a window.
- The service, not the Activity, owns the native window. Home/background can retain it while the process/service remains alive. The window remains small, draggable and nonfocusable; tap is Stop. API 30+ resolves the default Display, creates a display-associated context, then creates the matching overlay window context. Unavailable display/context failure stops without assuming the owner was initialized; display removal also stops ownership.
- In-app Stop cancels pending admission and calls `stopService` with the explicit service component. Overlay Stop and the notification action remove the window, remove the foreground notification and stop the service. Cleanup is idempotent.
- Overlay or notification availability is checked on each start and by a scheduled one-second service watchdog. Revocation/native attach failure ends ownership; the polling interval is not a measured hard real-time bound while the OS suspends execution.
- `START_NOT_STICKY`, no boot receiver, no persisted admission, and process-specific token nonce prevent automatic revival. Null/unknown/replayed commands cannot create a window. Process death still relies on Android to release the process's windows; opening the app again requires Show anew.
- This dev experiment requires notification availability so its Stop affordance can be seen. Android itself does not require POST_NOTIFICATIONS permission merely to start an FGS; this is a stricter local development policy. Notification permission requests and settings changes do not automatically issue admission.

## Platform declaration and evidence boundary

Manifest permissions are exactly `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, and `POST_NOTIFICATIONS`. API 34+ uses the `specialUse` FGS type with an explicit development overlay subtype explanation. Older supported APIs use the ordinary foreground-notification call. There is no microphone/media service type, audio capture, network permission or boot restart.

Primary docs checked 2026-11-13: [specialUse types and review](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use), [foreground-service start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission), [display-associated window contexts](https://developer.android.com/reference/android/content/Context#createWindowContext(int,%20android.os.Bundle)). The start flow relies on a visible user action, not a speculative overlay exemption. Special-use declaration does **not** establish store eligibility; Play/channel review and distribution qualification remain open.

Minimum API 26 / target API 35 remain development pins. The SDK/JDK/Gradle/Kotlin pins and explicit setup/build entry points are unchanged. Only the isolated API 35 AOSP ARM64 emulator is available for runtime evidence; minimum API, current newer Android releases, physical devices/OEM behavior, lock/rotation/IME/accessibility, long-duration stability and power remain gates.

## Validation

Owner validation completed on 2026-11-13 (Asia/Tokyo), version **0.1.0-dev.3**, versionCode **3**:

- Native `scripts/build-android.sh --console=plain`: **BUILD SUCCESSFUL**, APK assembled, **21 local Kotlin scenario groups + 5 shared voice scenarios** passed. Android lint: **0 errors / 21 warnings** (18 development strings, backup declaration, launcher icon, intentional physical-coordinate overlay gravity). The false SAM-listener heuristic on explicit `stopService(Intent)` is locally explained/suppressed; it is not a listener removal.
- Portable Kotlin compilation/execution independently passed the same **21 + 5** scenarios.
- `python3 scripts/smoke-emulator.py`: **passed** on isolated AOSP API 35 ARM64. Verified native service/window creation with the display-associated context, Home persistence, real cross-app drag, overlay-tap Stop, in-app Stop, notification Stop, permission-denied fallback, revocation cleanup, permission restoration without restart and forced-process-stop/reopen without resurrection. Window absence and service-record absence were asserted after stops. The final crash buffer is empty.
- Emulator resource profile: 3 GB RAM, four virtual cores, automatic graphics, fresh disposable AVD data each run; host checked at 24 GB / 10 cores. An earlier 2 GB / two-core software-renderer attempt hit a **System UI** ANR; it was not counted as passing. No app fatal exception was found. Audio/cameras are disabled; emulator and dedicated ADB server are stopped by the harness.
- Packaged permissions were asserted to be exactly the four listed above. No actual microphone or consumer endpoint was used.
- APK: `app/build/outputs/apk/debug/app-debug.apk`; owner-build SHA-256 `4fe6dff96407b9663426218db79a0ffdc97456a85b6f6e9b06ac11011e0ea79d`. Debug signing only; archive digest may differ after another clean build.
- Evidence: `build/native-evidence/overlay-visible.png` shows the real overlay over Home; `overlay-notification.png` shows Stop; `runtime-checks.json`, `launch.txt`, `permissions.txt`, `windows.txt`, `services.txt`, `crash.txt` and emulator/ADB logs record the run. Generated evidence remains ignored/app-local.

Default-display removal and actual low-memory process death were not injected. Safe context-creation failure/nullable cleanup/display-listener code is implemented, and native attach rejection/recreation fencing are core-tested, but this is not a claim that every physical display/OEM failure mode was exercised. Reproduce using `scripts/build-android.sh` and `python3 scripts/smoke-emulator.py`; SDK setup is separate and opt-in. The emulator harness targets only its dedicated AVD and ports, wipes only that disposable AVD on each run, uses emulator-only notification/appops setup, and collects screenshots, window/service state and crash logs under ignored `build/native-evidence/`.
