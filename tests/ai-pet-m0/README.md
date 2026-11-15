# Independent M0 QA probes

QA harness version: **0.1.0-dev.7**. No product code, external service or hardware adapter is implemented here. Execute from the repository root:

```sh
node --test contracts/ai-pet/test/*.test.cjs tests/ai-pet-m0/*.test.cjs
sh tests/ai-pet-m0/run-native-conformance.sh
```

Install contract dependencies using that component's documented setup first. The native script uses Swift/CLT and the Android owner's local JDK/Gradle-bundled Kotlin compiler; it downloads nothing. Override `AI_PET_QA_JAVA` and `AI_PET_GRADLE_LIBS` for equivalent local installations. Build artifacts are placed in a fresh temporary directory printed by the script. The compiler fallback does not prove the pinned Android Gradle Plugin/SDK app build.

The Node probes execute actual candidate contracts for independently attested migration payloads, wrong-account rejection, resume admission, stale leases and fail-closed unsupported destructive operations. No source-text matching or fake substitute implementation is used.

The native probes compile actual platform core sources. Kotlin tests prior-account output with deliberately colliding session/fence/turn fields plus visibility/manual resume. Swift tests output interruption, ignored stale revocation callbacks, manual resume, encoded widget field allowlist and late old-account writes across sign-out/account switch. Ports are in-memory test doubles; passing does not prove microphone behavior or production authorization.

Owner suites separately consume the shared scenario JSON and have wider local coverage. See [verification](../../docs/ai-pet-m0/verification.md) for actual outcomes and unresolved device/service gates.

Slice 2 adds seven independent history/journal probes for unknown outcomes, context isolation, atomic invalid imports, source tombstones, ordinary deletion, JSON key-order-independent duplicates and removal of deleted command plaintext. The Swift probe now also writes and reopens a real temporary snapshot file, verifies physical removal, rejects corruption/unknown schema, clears a cold-start snapshot and rejects identity-bearing links. Temporary files contain synthetic data only. Append-only development journals retain old synthetic action text; these tests do not claim production erasure or authenticated storage loading.

After stable iOS native build handoff, inspect actual app/widget metadata and Mach-O executables:

```sh
python3 tests/ai-pet-m0/inspect-ios-artifacts.py apps/ai-pet-ios/DerivedData/Build/Products/Debug-iphonesimulator/AIPetDevelopment.app --expected-dev-version VERSION --expected-build BUILD
```

Use the handed-off development version/build. This checks platform, versions, embedded Widget identity, generic URL scheme and absence of media/background authority; it does not claim runtime or App Group provisioning.

Runtime evidence is reviewed separately from executable probes. For the owner-run iOS simulator smoke, inspect `.cache/simulator-smoke.log`, launch/deep-link screenshots, and explicit disposable-device cleanup evidence. A successful `simctl openurl` or live process does not prove the app handled a link: a system Open-App confirmation can still be pending. Record app install/launch, actual app-level safe/unsupported link outcomes, Widget rendering and App Group sharing as separate results. QA reads owner evidence without controlling its simulator or repeating the native build.

Earlier iOS dev.3/build 3 evidence passed install/launch/process survival and visible offline UI on iOS 26.5/iPhone 17. The screenshot still shows the system Open-App prompt, so interactive safe/unsupported deep-link handling is unverified pending the optional UI tool approval. Read-only inspection found the disposable device-set directory empty after smoke. Widget home-screen rendering, provisioned App Group sharing, devices and live services remain separate open gates.

The dev.4 slice targets compact history checkpoint restore with host-supplied binding/fresh activation, user-started Android overlay service ownership, and actual iOS deep-link/Widget UI evidence. Earlier results remain historical; new acceptance is recorded only after changed implementations and stable owner handoffs are available.

Slice 3 supersedes the earlier iOS prompt-only limitation: actual generic Home Screen Widget render/tap and unsupported-link rejection were independently viewed; safe-link status was owner-verified through accessibility text. Real App Group sharing remains unverified. Five checkpoint probes and two deletion-order/alias probes were added; the Android probe now covers service ownership and one-use volatile start admission.

Final dev.4 slice results: 9 history + 5 checkpoint cases passed; together with the 7 existing contract probes covered by the integration run, the independent Node suite has 21 cases. Changed Kotlin service/admission probes passed. Android dev.3 native build and isolated API 35 service evidence were reviewed, including Home persistence, three Stop paths, revoke cleanup and no automatic restoration. See verification.md for incremental-build details, 21 lint warnings, permission setup and untested notification-denial/device paths.

Dev.5 adds `asset-conformance.test.cjs` with independent PNG construction and adversarial byte/approval/decode checks, and `python3 tests/ai-pet-m0/inspect-localization.py` for six-locale resource completeness and placeholder parity. This does not certify translations. The native harness creates an isolated resource-aware Swift Package from actual core sources/resources, then runs actual Kotlin sources; it selects installed Xcode per command when DEVELOPER_DIR is unset and does not alter the global toolchain.

Dev.5 final bounded QA: 26 independent Node cases (5 new asset cases), resource-aware Swift and Kotlin probes, and six-locale completeness checks pass. Runtime evidence is partial: Android inset fix built but final APK could not be exercised after boot timeouts; iOS Japanese/Speaking/static Widget observed, with remaining motion/link/pose checks unverified. See the final Slice 4 verification record for screenshot attribution and retained review-device state.

Dev.6 adds `python3 tests/ai-pet-m0/test_runtime_harness.py`: independent actual-helper checks for deadline-preserving readiness after timeouts and visible measured system-bar bounds. These do not substitute for native runtime acceptance.

Dev.7 runtime evidence regressions exercise the actual shared capture/toggle helpers: successful capture followed by an exit-success error cannot reuse old XML, a confirmed dump with failed read cannot fall back to local evidence, and a changed but unrestored toggle is rejected. The independent runtime-harness suite now has five cases.
