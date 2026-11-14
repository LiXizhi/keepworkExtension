# Interactive simulator checks — 2026-11-13

Artifact: **0.1.0-dev.3 / build 3**. No product source or configuration changed in
this validation slice; the existing compiled app/widget were exercised.

Environment: Xcode 26.6 (17F113), iOS 26.5 (23F73) arm64 runtime, dedicated iPhone 17
named `AI Pet Widget Check 20261113`. Owned UUID:
`90A8A326-49A5-4798-B478-37B763862488`.

This device was created specifically for interactive testing in the normal simulator
inventory so Simulator's UI could identify its unique window title. No existing
personal device was selected or changed. Creation, boot, install and launch were
bounded. UI operations used the native Simulator accessibility/screenshot tool.
The device was shut down and deleted after testing, and its absence was verified.
Global `xcode-select` remained on CommandLineTools.

## Observed results

| Check | Actual evidence | Result |
| --- | --- | --- |
| Safe `aipet-development://preview` | Accepted the ordinary iOS **Open** prompt; app accessibility text changed to `No current authorized development preview.` | Passed |
| Identity-bearing `aipet-development://preview?account=synthetic-other` | App accessibility text changed to `Unsupported link.`; no account or conversation selected | Passed |
| Unconfigured shared container | Publish and clear/sign-out controls remained disabled; no shared snapshot could be written | Passed for unavailable mode |
| Installed Widget discovery | Found `AI Pet Dev` in the actual Home Screen Widget gallery; selected the small `AI Pet Development` configuration | Passed |
| Actual Home Screen render | Added Widget displayed `AI Pet · Development`, `Preview unavailable`, `Open offline app` | Passed |
| Widget tap | Tapping its rendered surface opened the app and produced `No current authorized development preview.` | Passed |
| Voice boundary | App remained in `Voice unavailable`; no microphone dialog appeared; owned-device TCC query found no microphone authorization row for app or extension | Passed within offline simulator scope |
| Synthetic shared preview | No App Group entitlement/configuration supplied | Not tested |
| Real account/device/service behavior | No real identity, microphone, provider or physical device used | Not tested |

The first Widget accessibility-element click did not open the app. A normal coordinate
tap on the visibly rendered Widget did open it, with the expected in-app result.
This is recorded as UI-tool targeting behavior, not a product defect.

## Reproduction procedure

1. Build via `scripts/build-simulator.sh`; create a newly named disposable iPhone 17
   with iOS 26.5. Record its UUID before operating it; never use a generic `booted`
   selector when other simulators exist.
2. Boot with a bounded wait, install the built `.app`, launch it and verify the unique
   Simulator window title before interacting.
3. Send the safe URL with `simctl openurl <owned UUID> ...`. Confirm the ordinary Open
   prompt in that owned window, then inspect the Widget development section.
4. Send the identity-bearing URL and verify `Unsupported link.`. Verify disabled shared
   controls and `Voice unavailable` in the same app.
5. Press Home; enter Edit mode, choose **Edit → Add Widget**, search `AI Pet`, choose
   `AI Pet Dev`, and add its small Widget. Finish editing, inspect actual rendering,
   and tap the Widget. Verify the expected in-app unavailable-preview message.
6. Shut down/delete only the recorded UUID and confirm it no longer exists.

This follows Apple's [Home Screen Widget instructions](https://support.apple.com/en-gb/guide/iphone/iphb8f1bf206/ios).
The ordinary Open-App confirmation was already authorized; no Apple license or account
agreement was accepted during these checks.

## Local evidence

Ignored files under `.cache/`:

- `ui-safe-link.png`: safe-link app state (status also verified by accessibility text).
- `ui-unsupported-link.png`: rejected identity-bearing URL, disabled controls, voice unavailable.
- `ui-widget-home.png`: actual installed Home Screen Widget.
- `ui-widget-open.png`: app state after tapping Widget.
- `ui-microphone-evidence.json`: empty app/extension microphone authorization rows from
  this device's TCC database, read-only. This does not prove physical audio behavior.
- `interactive-device-id.cleaned`: ownership/cleanup record.

No App Group or team identity was invented. Shared-preview publication, refresh,
expiration and sign-out across real shared containers remain distinct unverified
integration gates. Generic unavailable rendering and Widget-to-app opening are now
verified and should no longer be grouped with those remaining gates.
