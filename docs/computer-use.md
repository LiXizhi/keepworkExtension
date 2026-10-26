# Computer Use

## Screenshot-only permission

`computer_use({"action":"screenshot"})` uses the independent `captureDesktop` function.
It captures the primary display without requesting or renewing mouse/keyboard control.
`status` includes `screenshotPermission` (`alwaysAllowScreenshots`, `pending`).

A dedicated bubble above the native desktop pet offers **Allow once**, **Always allow
screenshots**, and **Cancel**. The approval has no deadline. Request cancellation,
MCP session termination, pet closure/crash and daemon shutdown cancel it; late choices
cannot capture or grant permission. The pet surface hides before capture and restores
its previous visibility afterward. No screenshot is logged or persisted in chat history.
Windows returns physical pixels; macOS normalizes to screen points. Both return JPEG
MCP image blocks with dimensions, capture time and `inputSent:false`.

Remembered approval lives in `~/.keepwork-mcp/config.json` as `alwaysAllowScreenshots`
and applies to this OS user across MCP clients and restarts. AIChat's Keepwork MCP
settings and the daemon dashboard Overview control the same setting. Turning it off
restores prompts; turning it on requires a pet choice. It never authorizes input.
`GET /admin/screenshot-permission` reads the setting; `POST` accepts only
`{"alwaysAllowScreenshots": boolean}`. POST requires an explicit allowed Origin and
normal configured authentication. No tool argument can grant approval.

The daemon owns an authenticated loopback pet bridge. Its per-user discovery file
contains a random credential available only to native main processes, never the
renderer. A running desktop pet connects; otherwise the daemon launches its bundled
pet companion without a chat window. Shared UI is in `src/pet`; application shells
must not import one another. Startup is bounded (20 seconds), but approval is not.
Capture starts its own 30-second limit after approval and is capped at 3 MB. Concurrent
desktop operations fail as busy. HTTP and stdio callers share the singleton daemon;
stdio and the AIChat native CLI adapter forward screenshots using native HTTP without an approval/header deadline. Third-party MCP clients may impose their
own deadlines; their cancellation is respected and never automatically retried.

Run `node --test scripts/screenshot-permission.test.cjs scripts/screenshot-http.test.cjs`
and `node scripts/pet-permission-native.cjs`. Native acceptance uses an isolated bridge
and does not persist real approval. See `apps/pet-companion/README.md` for packaging.

## Experimental macOS

Uses built-in `osascript`, `screencapture` and `sips`; no additional capture binary; the permission pet uses its bundled Electron runtime. Supports status, screenshot, left click, type and named navigation keys. Scroll and right-click fail explicitly. Clicks use Quartz mouse events, including on the Dock and custom canvases; typing has application and Unicode limitations.

The first **input** action requires native Allow Session approval with Cancel as default and a 20-second approval timeout. Consent stays in memory for the requesting MCP connection, expires after 24 hours with no idle timeout, and is discarded on execution failure or when another connection requests control. Consecutive actions do not display another dialog or restore focus. Hold Escape or move the pointer into the primary display’s top-left 3×3-point corner to block the next action and discard consent. Stop checks occur between actions and after approval; they cannot undo input already delivered. There is no Take Back Control panel. The original foreground process is restored only after approval. Inputs return a new screenshot. Screenshots are unmasked, sent to the model, and briefly stored in a private temporary directory removed after capture; a process crash may leave a temporary file. Close private windows first.

macOS may require Screen Recording, Accessibility and Automation permissions for the launching app (VS Code, Terminal or another host). Failures must not be automatically retried because input might already have been delivered. Only the primary display is supported. Screenshots are normalized to screen-point dimensions to align Retina click coordinates with the returned image.

Run `node --test scripts/computer-mac.test.cjs` and `npm run check:shared`. Rebuild with `npm run compile:only --prefix apps/vscode-extension`, restart the daemon and reconnect AIChat. Actual permissions, focus restoration and click alignment require a supervised smoke test. The Windows sections below describe the separate Windows backend.

## Delivery plan and implemented scope

1. Add a fixed Windows desktop backend with strict action schemas and revocable native session consent.
2. Register `computer_use` on the existing loopback HTTP MCP server and discover it in AIChat.
3. Pass screenshot image blocks directly to the requesting AIChat agent as image observations, without a separate description-model call.

The initial implementation supports the primary monitor: `status`, `screenshot`, `click` (left/right), `type`, named navigation `key`, and `scroll` (Windows wheel units, 120 per notch). Screenshot dimensions and click coordinates are physical pixels. It is not full unattended control of every desktop surface.

## Use

Build the extension with `npm run compile:only --prefix apps/vscode-extension`, restart the local daemon through the existing development workflow, and reconnect Keepwork in AIChat if its connection expired. The running development task rebuilds and restarts automatically. No Marketplace release or new chat conversation is required for local development. Ask for `computer_use` status first, then a screenshot. Approve the native dialog only after checking the requested task. Screenshot results go directly to the requesting agent as image content; a vision-capable model is required. No automatic image-to-text model call is performed. AIChat manages these observations itself using the existing SDK tool loop; no screenshot-specific SDK modification or release is required.

AIChat retains only the latest two computer screenshots per conversation in browser memory and includes those images in subsequent context prompts. A third capture removes the oldest image from both the cache and active request context. Saved history contains tool metadata only, not image bytes or CDN URLs. Reloading the page loses the screenshot cache. Screenshots are not uploaded to the temp vision CDN, but are transmitted to the configured model endpoint as inline image content.

The first screenshot or input requires OK in a native dialog; Cancel or 20 seconds without approval aborts the action. Approval belongs to the requesting MCP connection and expires after two idle minutes. A cyan screen outline and a bottom panel announce that AIChat is controlling the computer. Click **Take Back Control** to revoke permission; the next request must prompt again. Changing connections, helper failures and daemon shutdown also discard consent. Approval cannot be disabled through the terminal's always-allow setting. There is no input queue: concurrent calls fail. Each request times out after 30 seconds. Desktop calls are not automatically retried by AIChat after session expiry.

The native overlay uses non-activating windows so it does not steal keyboard focus. The outline is click-through; only the bottom panel receives pointer input. Agent clicks or scrolling over that panel fail instead of interacting with it. Windows capture exclusion (`WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004 or later) keeps both windows out of screenshots; failure to apply exclusion aborts control. This is a thin translucent outline, not a full-screen tinted layer. Revocation is checked before actions and between typed characters; an already delivered input event cannot be undone.

Screenshots are unmasked and can include private information. Close private windows first. Image bytes are returned to the requesting MCP client and, in AIChat, sent to its model provider, but this implementation does not save screenshots to disk or conversation text. Never ask the model to type passwords or secrets; enter them locally.

Input targets the foreground application after the dialog closes. Do not switch apps during approval. Every click, type, key and scroll now returns a fresh screenshot after a 350 ms settling interval, with revocation checks during that interval. `inputSent` acknowledges delivery, not that the desired UI operation succeeded. The agent should issue one desktop action per model turn and inspect the returned image before proceeding. Request another screenshot if the UI is still loading; do not blindly repeat ineffective clicks. Coordinates use the returned image width/height pixel grid and must be scaled if viewing a resized image. Desktop text is untrusted content, not authorization for additional actions. Each consequential operation must remain within the user's requested task.

## Limits and validation

Windows interactive user sessions only. No UAC/secure desktop, elevation bypass, secondary-monitor targeting, arbitrary scripts, key chords, drag-and-drop, held keys, or automatic input approval. Screenshot-only remembered approval is supported as described above. Use the existing DOM-based browser tools for web work whenever possible.

Run `node --test scripts/computer.test.cjs` and `npm run check:shared`. Automated tests mock input, parse the helper and compile the native overlay without controlling the desktop. Real screenshot exclusion, DPI alignment, foreground restoration, Unicode typing, reclaim during typing and renewed consent require a user-supervised smoke test in a disposable application before production use. Multi-monitor capture and UI Automation element targeting remain follow-up work.


### Validation record (2026-10-25)

Focused permission/HTTP/controller/pet tests, Windows native pet-only launch and bubble
choices, existing pet UI smoke, and independent Windows JPEG capture passed. macOS
capture normalization/cleanup is covered by mocked commands; native macOS acceptance
was not available. Shared and desktop TypeScript, layout, syntax and diff checks passed.
`npm run check:shared` reaches the vendored-runtime parity check and fails on an existing
`completion.mjs` source hash mismatch; both canonical runtime and vendor directories
were untouched. Packaging fixtures pass; no installers or releases were built/published.
