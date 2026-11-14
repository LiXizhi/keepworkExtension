# iOS foundation validation

Date: 2026-11-13, Asia/Tokyo. Product **0.1.0-dev.3**, native build **3**.
Host: arm64 macOS 26.5.1 (25F80). Full Xcode **26.6 (17F113)** installed from the
official Mac App Store's last-compatible-version offer. Global developer selection
remains `/Library/Developer/CommandLineTools`; all Xcode work uses per-command
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

| Evidence | Result |
| --- | --- |
| Core Swift package/executable | Compiled; **24/24 checks passed** |
| App and embedded Widget Extension native build | **BUILD SUCCEEDED** via final `scripts/build-simulator.sh` |
| Architectures | App and widget both `arm64 x86_64` |
| SDK/minimum OS | `iphonesimulator26.5` / iOS `17.0` |
| Built version metadata | Both bundles: build `3`, development version `0.1.0-dev.3` |
| Final native build warnings/errors | No `warning:` or `error:` entries in final owner log |
| App → Widget dependency | Explicit target dependency and embedded `.appex` verified |
| Simulator smoke | Passed install/launch/process checks on disposable iPhone 17, iOS 26.5 (23F73) |
| Interactive deep links | Safe preview and identity-bearing unsupported link verified in-app after Open confirmation; see INTERACTIVE-VALIDATION.md |
| Home-screen Widget | Installed generic Widget rendered and tap opened the app; unavailable mode verified |
| App Group shared preview | Unconfigured and unverified; no entitlement invented |
| Real accounts/audio/providers/billing | Not connected or exercised |

## Native build artifact and commands

```sh
./scripts/build-simulator.sh
# Independent QA outputs:
AIPET_DERIVED_DATA="$PWD/.cache/qa-derived-data" ./scripts/build-simulator.sh
```

Owner artifact:

```text
DerivedData/Build/Products/Debug-iphonesimulator/AIPetDevelopment.app
  PlugIns/AIPetDevelopmentWidget.appex
```

The script selects `-target AIPetDevelopment -sdk iphonesimulator`, with app-local
`SYMROOT`, `OBJROOT` and module cache. This successfully compiles, links, packages,
and validates the app and extension without requiring a bootable runtime. The original
scheme/generic-destination invocation failed with `Found no destinations for the scheme`
before any runtime existed; the SDK-only target invocation fixes that build coupling.
It installs nothing and fails explicitly for absent Xcode/SDK or incomplete first launch.

Artifact plist inspection verified both IDs (`com.example.keepwork.aipet.dev` and its
`.widget` child), build/dev version, minimum OS and SDK. `lipo -archs` verified both
architectures. Neither bundle declares microphone access or audio background modes;
App Group configuration is empty. Signing remains disabled for simulator artifacts.

Actual native verification found and fixed:

- Custom `INFOPLIST_KEY_AIPetDevelopmentVersion` did not appear in the built bundles;
  both source plists now explicitly expand `$(AIPET_DEVELOPMENT_VERSION)`.
- Deprecated manual target ordering and header search defaults: enabled independent
  target parallel builds and set `ALWAYS_SEARCH_USER_PATHS=NO`. The explicit embedding
  dependency remains present; latest build logs have no warnings/errors.

Logs are ignored local evidence: `.cache/native-build.log`, `.cache/core-checks.log`.
Xcode/CoreSimulator require normal host service/user-cache access; sandboxed attempts
failed on user package-cache writes and XPC. Normal approved escalation completed the
build, rather than treating those failures as product failures or silently passing.

## Tool setup and simulator status

The user personally accepted the Xcode/Apple SDK license. Subsequently
`xcodebuild -runFirstLaunch` completed successfully through the normal elevation flow.
No agreement was accepted by the agent and no global developer directory was changed.
The initial runtime inventory was empty. Official download/install completed successfully:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -downloadPlatform iOS -buildVersion 26.5 -architectureVariant arm64
```

Installed runtime: **iOS 26.5 Simulator (23F73), arm64**, 8.52 GB download.
`simctl list runtimes` reports `isAvailable: true` and identifier
`com.apple.CoreSimulator.SimRuntime.iOS-26-5`. Apple's installer returned exit 0.
`.cache/runtime-download.log` records the official transfer/install result.

Executed smoke entry point:

```sh
./scripts/smoke-simulator.sh
```

The dedicated iPhone 17 in app-local `.cache/smoke-devices` completed first boot
(3m23s for the initial fresh runtime migration), installed and launched the app, and
reported a live `UIKitApplication:com.example.keepwork.aipet.dev` process. Screenshot
review confirmed the rendered offline UI and version `0.1.0-dev.3`.

The automated smoke submits synthetic links but does not confirm the iOS Open dialog;
its request-only result is deliberately narrow. Subsequent native-UI interaction on
a separately created, uniquely named owned device completed that confirmation and
verified both actual in-app outcomes, generic Home Screen Widget rendering and tap/open.
See [interactive validation](INTERACTIVE-VALIDATION.md) for exact evidence and cleanup.

The final bounded smoke script also reran successfully (exit 0); its second fresh
device completed boot readiness in 1m18s. A subsequent inventory of the app-local
device set returned an empty list. The later interactive device was separately
shut down/deleted and its absence verified. No approval rejection was received.

The script bounds device creation/boot initiation (120s), boot readiness (600s),
operations (180s), and each cleanup operation (60s), returning 124 on timeout. Its
trap shuts down/deletes only its own device; personal simulators are not selected.
Screenshots: `.cache/simulator-launch.png` and `.cache/simulator-unsupported-link.png`;
log: `.cache/simulator-smoke.log`. Home-screen widget rendering and App Group sharing
are not asserted by this app-launch smoke.

## Portable core and real filesystem evidence

```sh
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.cache/modules" \
CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang" \
swift run --disable-sandbox --scratch-path .build \
  --cache-path .cache/swiftpm --config-path .cache/config --security-path .cache/security \
  AIPetCoreChecks
```

Passed **24/24**, including all five shared voice scenarios and actual temporary-file
replacement/removal, concurrent readers during atomic replacement, account/cold-start
invalidation, corruption/size/schema rejection, symlink isolation, deletion failure/retry
and deep-link rejection. This executable uses throwing assertions because the original
CLT lacks `Testing`; `swift test` is not its entry point.

Earlier disk tests exposed Foundation's cached URL metadata and its two missing-file
error variants (Cocoa 4/260); storage now performs fresh attribute reads and handles
both. OS-denied deletion still surfaces an error and blocks local publication until
successful clear/reselect; it is never reported as successful deletion.

## Residual gates

Actual App Group provisioning, shared-preview timeline/reload behavior, device sign-out cache
purge, physical-device deployment, native microphones/background/lock/routes/echo,
clock/watchdog scheduling, latency/power, six-locale product copy/ASR/TTS, canonical
account/catalog/history/lease/provider/billing services, signing and distribution remain
open. The development widget only accepts synthetic IDs; links cannot activate voice.
No M0 service or release gate is closed by compile or offline policy checks.

## Follow-up interactive evidence

The earlier request-only deep-link limitation above is historical. The subsequent
[interactive validation](INTERACTIVE-VALIDATION.md) completed the Open confirmation,
verified both actual in-app link outcomes, added the real Home Screen Widget, and
verified generic unavailable rendering and Widget tap/open behavior on a newly owned
iPhone 17. No product code changed; version remains dev.3. The temporary device was
removed and absence verified. No pending UI approval or new human decision remains
for these completed generic checks. App Group shared-preview gates remain open.
