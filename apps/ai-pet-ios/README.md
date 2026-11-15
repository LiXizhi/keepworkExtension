# AI Pet iOS — offline development foundation

Independent development component **0.1.0-dev.4**, policy contract `ios-offline-policy-v1`.
No real account, backend, microphone, provider, billing or licensed catalog is connected.
The Swift package has no external dependencies or cross-app imports.

Current presentation verification and walkthrough: [SLICE4-VALIDATION.md](SLICE4-VALIDATION.md).
[HUMAN-REVIEW.md](HUMAN-REVIEW.md) remains the dated dev.3 review record.

## Portable checks

From this directory:

```sh
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.cache/modules" \
CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang" \
swift run --disable-sandbox --scratch-path .build \
  --cache-path .cache/swiftpm --config-path .cache/config --security-path .cache/security \
  AIPetCoreChecks
```

The executable suite uses throwing assertions/nonzero failure exit because this host's
CommandLineTools installation lacks `Testing`. `swift test` is not its entry point.
`--disable-sandbox` disables SwiftPM's nested build-script sandbox (unsupported inside
this host sandbox), not host permissions. No plugins/downloads run. Outputs are ignored.
Swift 6 language mode; iOS 17/macOS 14 minimum candidates.

The five shared voice scenarios are read directly from
`../../contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json`; unknown scenarios/events
fail. `wrong-account-migration` is explicitly outside this native component. Shared
integer turn generations map to fresh local UUID fences, and lease generations map
directly. Every supplied checkpoint is asserted. Mock admission checks are not service
authority; local domain models are not production wire schemas.

## Native build (separate, installs nothing)

```sh
./scripts/build-simulator.sh
# For a nonstandard installation, without changing global xcode-select:
DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer ./scripts/build-simulator.sh
```

The script uses an explicit SDK-only target build, so compilation does not require
a bootable simulator runtime. It requires full Xcode plus the iOS Simulator SDK, fails if missing, builds
the app and embedded widget, and reports the verified `.app` artifact path under
`DerivedData/Build/Products/Debug-iphonesimulator/`. It does not download components,
accept licenses, sign in, change developer selection or boot a simulator.
Use `AIPET_DERIVED_DATA="$PWD/.cache/qa-derived-data"` for an independent QA build;
its module cache and products stay separate from the owner build. Xcode's system
services/user package caches still require normal host access in sandboxed environments.
Signing is disabled for this development build. `com.example.keepwork.aipet.dev` and
its `.widget` child are development/example bundle IDs, not approved distribution IDs.
Setup/download remains separate from this command and from portable tests.

After a successful build and with the iOS 26.5 runtime installed:

```sh
./scripts/smoke-simulator.sh
```

The smoke script creates a disposable iPhone 17 in `.cache/smoke-devices`, installs
and launches only this offline app, records screenshots, submits allowed/rejected
synthetic link requests, then shuts down/deletes only its own device. iOS may require
Open confirmation; link requests alone do not establish app-level delivery. Boot and
operations have explicit timeouts. It uses the same optional
`AIPET_DERIVED_DATA`. `AIPET_SIM_RUNTIME` and `AIPET_SIM_DEVICE_TYPE` may override the
pinned defaults. Downloads remain separate; see Apple's official component installer.
The automated smoke alone does not assert Widget interaction. Separate
[interactive validation](INTERACTIVE-VALIDATION.md) verified generic Home Screen
Widget rendering, tap/open and both in-app link outcomes; App Group sharing is still unconfigured.

See `VALIDATION.md` for the current toolchain and actual native build evidence.

## Implemented policy

- Main-actor voice owner with isolated native I/O/provider interfaces and test doubles.
- Explicit start/resume checks context, microphone, entitlement, audio session,
  native start eligibility, transport and lease validity. OS/network recovery and
  visibility changes cannot start capture; mute survives interruption.
- Session/lease/local-epoch/turn fences, monotonic output sequence checks, stop/flush,
  best-effort cancellation, late-output rejection and fresh fences per turn/recovery.
- Expiry/revocation ends and releases the lease; fresh explicit admission is required.
  Delayed revoke callbacks cannot terminate a newer lease. Permission/allowance loss,
  end, sign-out and account/persona/conversation changes release local resources.
- Six locale identifiers: `zh-CN`, `en-US`, `es-ES`, `ko-KR`, `ja-JP`, `fr-FR`.
  Identifier coverage is not completed translation or ASR/TTS validation.

The production adapter must deliver interruptions/revocations, run a bounded monotonic
lease watchdog, map server expiry to a trustworthy deadline and discard buffered audio.
The injected `Date` policy is deterministic; clock-skew handling, native audio,
background scheduling and watchdog timing remain gates. Cold launch never starts voice.

## Durable widget snapshots

`FileWidgetStorage` stores a fixed filename in a dedicated app-owned directory using
atomic replacement, bounded reads, restricted file permissions and explicit throwing
I/O. It rejects symlinks/nonregular files, malformed JSON, unsupported schema versions,
invalid identifiers and oversized data. The read-only static API lets WidgetKit read
without creating directories or clearing state. Filesystem IDs never form paths.
The app is the sole writer; the widget is a read-only consumer. This is atomic visibility,
not a claim of power-loss-proof filesystem transactions or multi-writer synchronization.

`WidgetSnapshotStore` scopes callbacks to an ephemeral token. Sign-out/account change
invalidates the token before clearing storage; cold app initialization clears previous
snapshots before authorization. Failed I/O is exposed as `lastStorageError`; publication
and local presentation fail closed until a successful clear/reselect. An OS-denied
removal can leave a previous disk file; this is surfaced as failure, never claimed as
successful deletion. Retrying clear is required. Tests cover genuine temporary-file
replacement/removal, concurrent readers, corruption, size/schema limits, symlink
isolation, failure/retry and cold/account transitions.

Snapshot fields contain only opaque persona/appearance/conversation IDs, locale and
timestamp, with no message, account ID, credential, URL or audio. Future real-account
integration still needs an authorized catalog/identity adapter and retention review.

## Widget development path

The Xcode project embeds a real `AIPetDevelopmentWidget` extension using a static
WidgetKit timeline. The app can publish/clear a synthetic snapshot, request timeline
reload and handle only the exact `aipet-development://preview` link. Links contain no
account/conversation ID and cannot activate voice. Unsupported URLs are rejected.
The widget renders generic text, not opaque IDs or private conversation content.

Sharing is **unconfigured by default** and fails closed. Both targets read the optional
`AIPetDevelopmentAppGroup` Info.plist value from `AIPET_APP_GROUP`. No App Group
entitlement or production group identifier is fabricated. To test actual shared
containers, a developer must supply their own registered development group, add the
matching entitlement to both targets and configure their signing team as needed.
`Config/Local.xcconfig` and `Config/*.local.entitlements` are ignored for local setup.
The shared bridge accepts only the three synthetic dev IDs. A future production
adapter must replace that fixture gate using verified current-account authority.

The app clears snapshots at cold start and on development sign-out and requests
`WidgetCenter.reloadTimelines`. The widget also supplies an unavailable timeline entry
at the synthetic snapshot's 15-minute expiry. OS reload scheduling/cached rendering is
not synchronous and still requires device validation; no immediate on-screen purge
claim is made. There is no continuous animation, overlay, background audio or auto-voice.

## Outstanding gates

Native app/widget compilation and iPhone 17 simulator install/launch are verified;
UI screenshots and precise scope are recorded in VALIDATION.md. Device
App Group sharing, shared-preview widget updates/sign-out, 30-minute background/lock audio, Bluetooth,
phone/recorder interruptions, echo/speech detection, power and latency remain unverified.
Backend account/home-region identity, catalog rights, history, leases/providers,
quota/settlement, billing, production translations/speech quality, signing and distribution remain external.

Official references checked 2026-11-13 (Asia/Tokyo):

- [Xcode resources](https://developer.apple.com/xcode/resources/)
- [Xcode App Store](https://apps.apple.com/us/app/xcode/id497799835)
- [Swift Package Manager](https://docs.swift.org/main/documentation/packagemanagerdocs/)
- [Audio interruptions](https://developer.apple.com/documentation/AVFAudio/handling-audio-interruptions)
- [Creating a Widget Extension](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension)
- [Widget timelines](https://developer.apple.com/documentation/widgetkit/timelineprovider)

## Development presentation (dev.4)

App copy is bundled for zh-CN, en-US, es-ES, ko-KR, ja-JP and fr-FR. The language
picker persists a device-local preference independently of account/home region.
The static widget uses system language unless a validated, unexpired synthetic
shared snapshot supplies a language; selecting an app language does not publish it.
Both app and extension include the Swift Package JSON resource bundle. Direct
swiftc policy harnesses compile without Bundle.module and do not exercise resources.

The original geometric pet has seven manual demo poses and a synthetic speaking
mouth slider. It has no catalog identity, microphone, timer, or continuous animation.
Reduce Motion, inactive/background and invisible states suppress animation and
close the mouth. Text uses system fonts and scrolling layout; the pet has a localized
VoiceOver label, and pose/language pickers and mouth slider expose native controls.
