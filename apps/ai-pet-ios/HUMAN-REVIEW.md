# iOS Simulator human review

Review scope: **offline development build 0.1.0-dev.3 / build 3**.
This build demonstrates local controls, a generic Widget and safe link handling.
Login, AI conversation, microphone/voice, licensed character artwork and shared
App Group previews are not connected.

## Open the prepared app

For the 2026-11-14 review, use the Simulator window named
**AI Pet Human Review 2026-11-14** (iPhone 17, iOS 26.5). The installed app is
**AI Pet Dev**. This device is left available for your review, unlike the automated
smoke script, which deletes its own temporary device.

The review device ID and installed artifact path are recorded locally in
`.cache/human-review-device.json` (ignored by Git).

## Walkthrough

| Action | Expected result |
| --- | --- |
| Open AI Pet Dev | Title `AI Pet · Development`, version `0.1.0-dev.3`, and an offline/synthetic notice. |
| Change the Language picker | Six locale identifiers are available. The developer UI remains English; this is not a translation test. |
| Tap **Select local preview** | Text becomes `Local preview selected`; the button changes to **Clear local preview**. |
| Tap **Clear local preview** | Text becomes `No preview selected`. |
| Scroll to **Widget development** | `App Group sharing is not configured.` The publish and clear/sign-out buttons are disabled. |
| Scroll to **Voice unavailable** | The app explains that it does not request microphone access or connect to services. |

## Add and use the Widget

1. Click the **Home** button in the Simulator toolbar.
2. Click and hold an empty area of the iPhone Home Screen until editing begins.
3. Choose **Edit → Add Widget**, search for **AI Pet**, and choose **AI Pet Dev**.
4. Add the small **AI Pet Development** widget, then finish editing.
5. Expect `AI Pet · Development`, `Preview unavailable`, and `Open offline app`.
6. Click the widget. It should open the app. Scroll to **Widget development**:
   the status should read `No current authorized development preview.`

Selecting a local preview does not publish a shared Widget snapshot. The unavailable
Widget state is the intended result while App Group sharing is unconfigured.

## Optional link checks

In Terminal, replace `YOUR_REVIEW_DEVICE_ID` with the ID from the local review record.
Run one command at a time and accept the ordinary iOS **Open** prompt if shown:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun simctl openurl YOUR_REVIEW_DEVICE_ID 'aipet-development://preview'
```

Expected Widget development status: `No current authorized development preview.`

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun simctl openurl YOUR_REVIEW_DEVICE_ID 'aipet-development://preview?account=synthetic-other'
```

Expected status: `Unsupported link.` No account should be selected and no voice
session should start.

## Review result

**Confirmed by the user on 2026-11-14 (Asia/Tokyo):** the installed Widget opens
the app correctly. The user confirmed human review and authorized committing and
pushing the branch. This records the reported Widget-to-app check; it does not
claim that the user ran every optional check above.

This review accepts the demonstrated offline foundation; it does not close the
remaining service, shared-container, audio or release gates.

Native build: `scripts/build-simulator.sh`. Detailed engineering evidence:
[VALIDATION.md](VALIDATION.md) and [INTERACTIVE-VALIDATION.md](INTERACTIVE-VALIDATION.md).
