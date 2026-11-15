# Development presentation validation — dev.4

Date: 2026-11-14 (Asia/Tokyo). Version `0.1.0-dev.4`, build `4`.
The dated dev.3 HUMAN-REVIEW.md and INTERACTIVE-VALIDATION.md are preserved.

## Completed checks

- Final Xcode simulator build succeeded for the app and embedded WidgetKit extension
  (arm64 and x86_64, iOS 17 minimum, iOS 26.5 SDK, signing disabled).
- Both built Info.plists contain build 4 / dev.4; both bundles contain
  AIPetCore_AIPetCore.bundle/development-copy.json with all six locales.
- Xcode SwiftPM executable checks: **27/27 passed**. Includes complete localized
  resource keys, persisted device preference, system fallback, widget language
  isolation and expiry/future timestamp boundaries, all seven poses, amplitude
  clamping/nonfinite input, Reduce Motion/invisible/inactive suppression, and all
  previous voice/session/disk snapshot/link rejection regressions.
- Resource access uses Bundle.module under SwiftPM, Bundle.main otherwise, so the
  direct swiftc contract harness can compile policy types without generated accessors.
  Resource coverage must run via SwiftPM; a bare swiftc build is not a localization test.

Reproduction (from this directory):

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.cache/modules" \
CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang" \
xcrun swift run --disable-sandbox --scratch-path .cache/slice4-build \
  --cache-path .cache/swiftpm --config-path .cache/config \
  --security-path .cache/security AIPetCoreChecks
./scripts/build-simulator.sh
```

Host note: an initial plain `swift run` hit CommandLineTools SDK/cache errors.
The explicit Xcode invocation above passed without changing global xcode-select.
No external packages or downloads were needed. Build logs are local ignored evidence.

## Current manual walkthrough

1. Launch AI Pet Dev and verify dev.4. Language defaults to supported system language
   (English fallback); choose any of 简体中文, English, Español, 한국어, 日本語, Français.
   All explanatory/status copy should change. Terminate/relaunch to check persistence.
2. Scroll to the geometric pet. Select Idle, Happy, Listening, Thinking, Speaking,
   Sleeping and Error (labels follow selected language). Speaking enables the synthetic
   mouth slider; other poses keep it disabled. No microphone permission is requested.
3. Enable Reduce Motion on a disposable simulator: mouth closes, slider disables and
   motion-paused text appears. Background/inactive or invisible presentation also
   suppresses mouth/animation; no timer or ongoing renderer is installed.
4. Increase Dynamic Type and inspect scrolling text and native picker/slider labels.
   Inspect VoiceOver labels for the pet's localized name + pose and slider percentage.
5. App Group is blank by default: publish/clear controls remain disabled. Add the
   static small Widget: it remains generic/unavailable and uses system language even
   if app preference differs. An authorized unexpired snapshot is the only locale override.
6. Open `aipet-development://preview` and accept the OS Open prompt if shown: the app
   reports no authorized current preview. Open `aipet-development://preview?account=x`:
   the app rejects it. Neither path starts voice or changes account/region.

## Scope

Original geometric demo only, with no licensed catalog claim. Six development-copy
resources do not establish production translation approval or speech quality. Widget
sharing with a real provisioned App Group, physical-device accessibility, background
voice/audio, services, account identity, signing and distribution remain external gates.

## Runtime attempt and blocker

Created only `AI Pet Slice4 Owner 20261114`, UUID
`626FA29E-2E50-411C-8089-2A0E0AF16623`, iPhone 17 / iOS 26.5.
`simctl bootstatus -b` timed out after 600 seconds; latest progress reported Data
Migration (`com.apple.managedconfiguration.migrator`). The device list said Booted
but CUA and `.cache/slice4-boot-blocked.png` still showed the Apple boot progress bar.
The first app installation timed out after 180 seconds, before app launch. One bounded
retry was attempted. This disposable-device attempt produced no dev.4 runtime
language/persistence/pose/link/widget or accessibility result; subsequent review-device
observations are recorded separately below. The previous dev.3 UI evidence is historical only.

At the stall, vm_stat reported 3,606 free 16-KiB pages (~56 MiB) and 575,814 pages
occupied by compressor (~8.8 GiB); this suggests resource pressure, not a proven cause.
Other booted devices were left untouched, including the protected human-review device
`391621B8-B9FB-4DBE-A2AD-8E47FD02DF0C`. No global simulator/service reset was attempted.
The current walkthrough above is a pending runtime acceptance procedure.

Final retry also timed out at 180 seconds. Owned shutdown and deletion both returned
zero; subsequent JSON device inventory confirmed its UUID absent. Cleanup evidence:
`.cache/slice4-device-id.cleaned`. No owned simulator is left running.

## Subsequent review-device verification

With explicit project authorization, updated the already booted project review device
`391621B8-B9FB-4DBE-A2AD-8E47FD02DF0C` to dev.4 (device preserved, no erase/shutdown).
Although install CLI timed out, tapping its existing widget opened the app showing
`AI Pet 0.1.0-dev.4`, proving the update had actually landed.

Owner-observed runtime results: six-language menu; English → Japanese immediately translated title,
body/status copy and pet accessibility label; seven translated pose choices; Speaking
enabled the slider and a drag updated its accessible value to 90%. Terminate/relaunch
retained Japanese. At maximum accessibility text size, content wrapped and scrolled,
including the native language control. This was observed live in CUA's accessibility
and screenshot output, not independently established by the saved screenshot file.
The delayed `.cache/slice4-dynamic-type.png` capture actually contains Home Screen
and must NOT be used as evidence of app Dynamic Type layout.

Restoration evidence: the initial read returned `large`; the restore command completed
with exit zero, and final live CUA app capture showed normal-sized text again. Thus
restoration is supported by command completion and visual observation, not merely an
issued command. No separate post-restore `content_size` readback was performed.

The Home Screen subsequently refreshed both existing widgets to the dev.4 geometric
pet, with English “Preview unavailable / Open offline app” while the app remained
Japanese: actual static rendering and language isolation observed. Initial widget tap
had opened dev.4 and shown the Japanese no-authorized-preview status after switching.

Further runtime checks encountered host/simulator response delays: Settings launched
but remained blank, so Reduce Motion was never changed; the unsupported-link request
`aipet-development://preview?account=x` timed out after 60 seconds without a verified
app-level result. Later widget tap attempts returned AXError.cannotComplete. Therefore
Reduce Motion UI, remaining pose selections, and explicit unsupported-link delivery
remain unverified on dev.4 (their policy tests pass). VoiceOver labels were inspected
through the accessibility tree; an actual VoiceOver speaking session was not tested.
No device erase, shutdown or service reset was performed. Dynamic Type was restored.

Settings termination returned zero, and launching the review app returned its existing
PID 51226. Final CUA inspection confirmed dev.4 foreground in Japanese with normal
restored text size and Idle pose. Device remains available for review. The six-language
menu is near the top; scroll to the pet section for pose and mouth controls. Historical
dev.3 acceptance instructions remain unchanged; this is the current dev.4 walkthrough.

One final unsupported-link retry after closing Settings also timed out after 45 seconds.
No rejection or permission-prompt result is claimed for this retry. Runtime evidence
is limited to the observed items above; compilation and 27/27 policy checks are unchanged.

Final handoff: no further runtime attempts are running. Settings was closed; Reduce
Motion was never changed. The review device remains retained with dev.4 installed.
Idle/Speaking and the seven-item menu were observed, but the other five poses were
not individually selected. Initial existing-widget opening was observed; a fresh tap
on the refreshed dev.4 widget was not verified. Explicit safe-link CLI delivery and
unsupported-link rejection were not established in this run. These limits remain
separate from the passing pure-policy tests and dated dev.3 evidence.

## Completed follow-up runtime checks (2026-11-14, 21:43–21:52 JST)

This section supersedes the earlier pending results while preserving the failed attempts.
No source changes, rebuild, simulator restart, erase or global reset were needed.
Eight-second bounded probes now completed: content_size 0.77 s (`large`), openurl
0.70 s. Earlier 45/60-second timeouts remain real historical failures; their resource
root cause is not established. Current observations do not justify claiming a resource
fix. The effective automation corrections were observing/accepting the OS Open prompt,
using screenshot-based coordinate clicks when AX widget activation did nothing, and
waiting for synchronous capture completion before navigating.

- Unsupported `preview?account=x`: accepted visible Open confirmation; app showed
  `未対応のリンクです。` (unsupported link), not a preview or voice transition.
- Safe `aipet-development://preview`: app showed current-authorized-preview absent;
  publish/signout controls disabled. Actual app outcome checked, not just CLI exit.
- All seven poses individually selected, with matching localized pet/selection AX
  labels; Speaking slider enabled normally. Earlier 90% mouth evidence remains valid.
- All six languages selected individually; corresponding localized headings observed,
  with localized explanatory copy in the UI. Restored Japanese, the starting preference.
  Earlier terminate/relaunch persistence result applies to the unchanged artifact.
- Actual OS Reduce Motion was initially 0, toggled to 1; Speaking then rendered a closed
  mouth, disabled slider and paused text. `.cache/slice4-reduced-motion.png` captured
  synchronously. Restored switch to 0 and observed it in Settings. Returning to app
  enabled Speaking slider again.
- Maximum accessibility text size checked in app; wrapped/scrolled text and native
  control visible. `.cache/slice4-dynamic-type-confirmed.png` was captured BEFORE
  navigation and reopened for inspection: it really contains the Japanese app, unlike
  the earlier misnamed Home screenshot. Restored size and read back `large`.
- Background/Home and foreground round trip succeeded with Speaking retained. Hidden
  background mouth state is not directly observable from Home; its suppression is
  covered by pure policy checks, not falsely inferred from a Home screenshot.
- Both refreshed static geometric widgets displayed English unavailable copy while
  app preference was Japanese. AX activation alone did nothing; coordinate tap inside
  the visible widget opened the app, showing Japanese no-authorized-preview status.

Installed app binary, widget binary and JSON copy resource SHA-256 each match the
unchanged built artifact; exact values are in `.cache/slice4-runtime-hashes.json`.
App SHA-256: `05253d867f4978535f05039aa2b336affe54e93759bf0b1d72abd484e7f25558`.
Widget SHA-256: `ad53761274ae80a3dc1b4965b27e71fe7debdc2cb2cc7beb1dc6caa4010c4d6e`.
Review device retained, dev.4 foreground, Japanese selected, Reduce Motion off, text
size large. No pending device command or temporary setting remains. Physical-device
VoiceOver speech and direct instrumentation of invisible background state remain
outside this UI observation; no production-service/rights/App Group claim is added.

## Environment restoration after root's Android comparison (22:19–22:21 JST)

Root reported temporarily shutting down this review device at 22:06 and rebooting it
with data preserved. This follow-up performed no restart, erase, build or setting change.
Two bounded probes (content_size read and app launch) each timed out after 10 seconds.
CUA showed the retained review device at Home with AI Pet installed; clicking its icon
opened a white launch surface, but the final AX observation had no app content. Thus
restoring a responsive dev.4 foreground is NOT confirmed after this later reboot.
This does not replace or invalidate the completed 21:43–21:52 interaction evidence.

Read-only inspection of this exact device's saved preference files confirmed:
- app `ai-pet.development.locale.v1` = `ja-JP`;
- UIKit `UIPreferredContentSizeCategoryName` = `UICTContentSizeCategoryL` (large);
- Accessibility `ReduceMotionEnabled` = 0.

These are persisted-setting checks, not claims that the white launch surface rendered
the settings. Device and app data remain retained; no other simulator or user app was
operated. No pending command remains. Responsive foreground restoration is still
limited by the current simulator launch delay; no further repeated attempts made.

## Foreground restoration confirmed during authorized lower-load window

After root reported temporarily pausing the two authorized avatar workloads, the same
10-second bounded probes completed: content_size 0.21 s (`large`), app launch 0.23 s
(exit 0, PID 20855). CUA confirmed dev.4 identity, Japanese selection, and a working
scroll interaction. Read-only device preference inspection confirmed
`ReduceMotionEnabled = 0`. Safe deep link completed in 0.20 s and changed the actual
app status to the Japanese no-authorized-preview message. Screenshot captured without
intervening navigation: `.cache/slice4-recovered-foreground.png`.

This supersedes the previous white-startup restoration blocker. No code/build,
restart, setting change or unrelated-app action was performed by this owner. The
review device remains running with interactive dev.4 foreground, Japanese, large text,
and Reduce Motion off. Runtime slot released to root/Android; root alone manages
resuming the temporarily paused workloads. Faster response coincides with lower load;
this observation alone does not prove a unique resource root cause.

## Final retained-device restoration (2026-11-14 23:38 JST)

After root explicitly released the final Android slot, booted the same retained review
device: boot exit 0 in 1.13 s; bootstatus completed in 30.07 s. Initial launch CLI hit
its 15-second bound. Clicking the installed AI Pet icon then produced the actual
`AI Pet 0.1.0-dev.4` Japanese UI; a subsequent scroll visibly updated the AX tree,
confirming responsiveness rather than merely a process ID or launch surface.
Read-only persisted settings remain `ja-JP`, `UICTContentSizeCategoryL`, and
`ReduceMotionEnabled = 0`. No setting changed, rebuild, erase or global reset occurred.
Device remains booted with responsive dev.4 foreground. Owner released runtime control
promptly to root to resume its paused workloads; no further iOS operations pending.
