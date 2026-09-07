# Windows Computer Use

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

Windows interactive user sessions only. No UAC/secure desktop, elevation bypass, secondary-monitor targeting, arbitrary scripts, key chords, drag-and-drop, held keys, or unattended approval. Use the existing DOM-based browser tools for web work whenever possible.

Run `node --test scripts/computer.test.cjs` and `npm run check:shared`. Automated tests mock input, parse the helper and compile the native overlay without controlling the desktop. Real screenshot exclusion, DPI alignment, foreground restoration, Unicode typing, reclaim during typing and renewed consent require a user-supervised smoke test in a disposable application before production use. Multi-monitor capture and UI Automation element targeting remain follow-up work.