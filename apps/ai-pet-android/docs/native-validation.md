# Native Android development validation (historical dev.2 record)

Current code, scripts and generated `build/native-evidence/` are described in [dev.3 service validation](service-overlay-validation.md); the results below document the prior Activity-scoped slice.

This bounded dev.2 slice adds an actual APK build and an Activity-scoped synthetic overlay experiment. It remains disconnected from backend contracts and real audio.

## Reproducible entry points

Run from `apps/ai-pet-android`:

1. `python3 scripts/setup-android-sdk.py` explicitly downloads/extracts the macOS ARM64 SDK lock. Downloads are opt-in and verified against Google's package-manifest SHA-1 and recorded SHA-256 values. Existing package revisions are checked, not silently upgraded.
2. `scripts/build-android.sh` requires the scoped SDK and JDK 17, runs core scenarios, debug packaging and Android lint, and prints the APK path on success. It never installs SDK packages or treats missing prerequisites as success. Gradle may resolve pinned Maven dependencies on the first build. It creates an app-local debug key, not a release key.
3. Optional emulator packages are installed by `python3 scripts/setup-android-sdk.py --emulator`. This adds a pinned ARM64 emulator and AOSP API 35 image; it does not create/sign in to a Google account.

Paths under `.toolchains/` are ignored: SDK, JDK, Gradle dependencies, download cache, Android preference/AVD paths and debug keystore. `android-env.sh` sets these for each command without changing global developer selection. **ADB exception:** official platform-tools 37.0.1 initializes `~/.android` (and may store its default host authentication key there); upstream ADB does not honor Android SDK tools' user-directory variables for this path. We do not overwrite HOME, replace existing settings, or target a physical device. Emulator validation must use a dedicated ADB server/explicit emulator serial.

## Pins and provenance

- JDK: scoped Temurin 17.0.21+9 (existing prior-slice download).
- Gradle 8.11.1 (wrapper distribution SHA-256 pinned), AGP 8.9.2, Kotlin 2.2.10.
- Android command-line tools 19.0 / build 13114758, platform API 35 revision 2, Build Tools 35.0.0, platform-tools 37.0.1.
- Optional emulator 37.2.13 / build 16740729; AOSP `system-images;android-35;default;arm64-v8a` revision 2.
- API 26 minimum, API 35 target/compile are development pins; they are not a claim of current store eligibility.

Official sources checked on 2026-11-13: [SDK repository manifest](https://dl.google.com/android/repository/repository2-3.xml), [AOSP system-image manifest](https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml), [SDK setup](https://developer.android.com/tools/sdkmanager), [AGP compatibility](https://developer.android.com/build/releases/agp-8-9-0-release-notes), [Kotlin compatibility](https://kotlinlang.org/docs/gradle-configure-project.html), [overlay windows](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#TYPE_APPLICATION_OVERLAY), [overlay permission](https://developer.android.com/reference/android/provider/Settings#canDrawOverlays(android.content.Context)), [foreground service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [emulator command line](https://developer.android.com/studio/run/emulator-commandline).

## Evidence

Validated on 2026-11-13, Asia/Tokyo, version **0.1.0-dev.2**, versionCode **2**:

- `scripts/build-android.sh --console=plain`: **BUILD SUCCESSFUL**. Core **19 local scenario groups + 5 shared scenarios** passed; debug APK assembled; lint **0 errors / 15 warnings** (12 development UI localization, one backup declaration, one missing launcher icon, one intentional physical-coordinate overlay gravity).
- `scripts/check-core-portable.sh`: the same **19 + 5** scenarios passed using the existing bundled Kotlin 2.0.20 compiler. The Gradle build separately compiled Kotlin 2.2.10 and the real Android sources.
- `python3 scripts/smoke-emulator.py`: **passed** on isolated API 35 AOSP ARM64, emulator 37.2.13. Verified install/Activity launch, permission-denied fallback, native Settings navigation, explicit real overlay show and drag, tap removal, cleanup on Home/Activity stop, and no automatic restoration. The crash buffer contained no fatal Java exception. Emulator audio/cameras were disabled and no real accounts were added.
- `aapt dump badging/permissions`: package `com.keepwork.aipet.dev`, minimum API 26, target/compile API 35, only `SYSTEM_ALERT_WINDOW`; no network/microphone permissions.
- APK: `app/build/outputs/apk/debug/app-debug.apk` (debug signing only), SHA-256 `b81a2d17104e69d7c4ed0bf596d05fb98d42cafbdc9ea8a9eb576e97e8f1833b` for the owner-built artifact. A clean rebuild may produce a different archive digest; verify its version/permissions independently.
- Runtime artifacts: `build/native-evidence/offline-shell.png`, `overlay-visible.png`, `overlay-permission-settings.png`, `launch.txt`, `runtime-checks.json`, `crash.txt` and emulator/ADB logs. Build outputs and device data are ignored, not source-controlled. The test emulator and dedicated ADB server were stopped after the run.

Resolved build/setup findings: Kotlin/AGP classloader visibility initially failed with missing `BaseVariant` after hoisting Kotlin; the final root build conditionally loads AGP alongside Kotlin only for `-Pandroid=true`. Directly extracted emulator/command-line packages required local SDK package metadata for avdmanager discovery; setup now registers their locked generic metadata. Test navigation uses explicit clear-top launch when returning from Settings, and reads WindowManager geometry for the nonfocusable overlay rather than assuming it appears in the Activity's accessibility tree.

Physical-device, OEM/rotation/IME/touch-through, continuous background service, real microphone, production accounts/catalog/history/voice/billing and distribution remain separate gates.

## Overlay experiment boundaries

The app offers separate permission-settings, show and remove buttons. Permission return alone never displays the pet. The synthetic 132 × 80 dp view is a real `TYPE_APPLICATION_OVERLAY`, not a second Activity or a mock drawing inside the content view. It uses a nonfocusable small touch region, native touch slop and clamped dragging; tapping removes it. A denied permission or native attach failure keeps the ordinary in-app controls available. Activity stop, explicit removal and detected revocation remove the native view. No service, boot receiver or microphone is introduced.

This deliberately does not prove persistent cross-app behavior, OEM policies, all display insets/rotations, IME behavior, accessibility drag alternatives, real audio or FGS eligibility. Its physical coordinate gravity is intentional for this bounded spike (lint reports `RtlHardcoded`); localized production layout remains pending.

`python3 scripts/smoke-emulator.py` checks prerequisites, creates only `AiPetOfflineApi35` under the ignored local AVD directory, uses emulator ports 5584/5585 and dedicated ADB server port 5039, and refuses occupied ports. It boots with audio and cameras disabled, installs the debug APK, uses only its explicit emulator serial, collects `build/native-evidence/` screenshots/logs, and stops its emulator/server afterward. Permission Settings navigation is exercised natively; permission grant/revoke test setup uses emulator-only appops and is not presented as a completed real-user consent flow. WindowManager geometry drives overlay assertions because the nonfocusable overlay is not in the active Activity's UIAutomator tree.
