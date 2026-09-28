# KP Local Helper for managed Android tablets

This application is the managed-device Android host for the Keepwork loopback
services. A single signed APK contains:

- Android-safe MCP on `127.0.0.1:8089`
- local speaker embedding on `127.0.0.1:18089`
- the signed ERes2Net ONNX model from `../local-model-runtime`
- a Device Policy Controller for company-owned tablets

It is not part of the VSIX, does not contain Electron or Node.js, and does not
download a model after installation. Release APKs contain only `arm64-v8a`.
Debug APKs also contain `x86_64` so CI can run Android emulators.

## Managed-device provisioning

Provision a factory-reset tablet before adding accounts or handing it to a
user. For development:

```sh
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell dpm set-device-owner com.keepwork.localhelper/.policy.KeepworkDeviceAdminReceiver
adb shell am start -n com.keepwork.localhelper/.MainActivity
```

Production enrollment should use Android Enterprise QR or the tablet vendor's
batch provisioning. The administrator must set an 8+ character maintenance PIN
before delivery. An EMM can instead set the managed configuration
`adminPinSha256` to a lowercase SHA-256 digest.

Device Owner policy blocks uninstall, force-stop/application controls, safe
boot and unauthorized factory reset. Release builds also disable debugging.
The application is not a kiosk launcher: Chrome and other allowlisted business
apps remain usable.

## Runtime behavior

Opening the application starts both services. `LOCKED_BOOT_COMPLETED`,
`BOOT_COMPLETED`, `USER_UNLOCKED` and `MY_PACKAGE_REPLACED` also start the
foreground supervisor. There is no user-facing stop action. Android can still
reclaim a process under memory pressure; `START_STICKY` and the supervisor
restore it. The notification is ongoing and contains no stop button.

The local-model process is separate from the MCP process. It verifies the model
size, SHA-256, package checksums, config binding and Ed25519 manifest signature
again on every process start. Model inference loads lazily and unloads after ten
idle minutes while port 18089 remains available.

MCP always requires the bearer token shown in the app. File tools can access
only the folder explicitly granted with Android's Storage Access Framework.
There is no shell, arbitrary absolute path, desktop control or browser-control
tool. Both HTTP servers bind only to `127.0.0.1`.

## Build

Requirements are Node.js 22, JDK 17, Android SDK 35, Gradle 8.9, `tar`, and the
installed dependencies of `apps/local-model-runtime`.

```sh
npm ci --prefix apps/local-model-runtime
node apps/android-helper/scripts/prepare-runtime.cjs
cd apps/android-helper
gradle testDebugUnitTest assembleDebug
```

`prepare-runtime.cjs` pins sherpa-onnx `1.13.8` by URL, byte size and SHA-256,
extracts only the named JNI libraries without unpacking arbitrary archive paths,
and copies the already signed model package from `apps/local-model-runtime`.

Release signing is supplied only through `KP_ANDROID_KEYSTORE`,
`KP_ANDROID_STORE_PASSWORD`, `KP_ANDROID_KEY_ALIAS`, and
`KP_ANDROID_KEY_PASSWORD`. Do not commit keystores or passwords.

## Release

`.github/workflows/android-helper.yml` runs source checks, Android 10/13/14/15
emulator cold-boot tests, a real ARM64 embedding smoke on the self-hosted
`keepwork-android-arm64` runner, signature/ABI inspection, and then Qiniu
publication. It uploads and verifies the immutable versioned APK before
replacing `latest.json` at:

`https://cdn.keepwork.com/keepwork/KP-Local-Helper-Android/latest.json`

The first release is internal and signed with the Keepwork internal Android
key. Model changes require an APK version/versionCode increase; there is no
model hot update.
