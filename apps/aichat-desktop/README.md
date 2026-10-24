# KeepWork 第二大脑

An independent Electron window for `https://keepwork.com/chat`, with native folder grants,
workspace files and PTY terminals. Keepwork MCP runs as a separately supervised bundled
NodeRuntime. The existing KP Local Helper is not replaced; speaker models are not included.

## Develop and verify

### VS Code startup and debugging

Open the `keepworkExtension` repository or this `apps/aichat-desktop` folder in VS Code.
After installing dependencies, choose **Terminal → Run Task → keepwork Desktop: Start**.
For main-process breakpoints, choose **keepwork Desktop: Debug** in Run and Debug and
press **F5**; its pre-launch task builds the Electron source and source maps automatically.
Windows and both Mac architectures use the locally installed Electron executable.
Task/F5 sets `AICHAT_DESKTOP_LOCAL_SOURCE=1`: the app serves the sibling
`apps/official/apps/tools/AIChat` checkout over loopback HTTP, starting at port 3001
and skipping occupied ports. Set `AICHAT_SOURCE_DIR` if that checkout lives elsewhere.
The terminal prints the actual source URL. An explicit `AICHAT_DESKTOP_DEV_URL` takes
priority for an existing Live Server. Missing source fails visibly instead of opening
the published website. The owned HTTP server stops on Quit. Closing the window hides
the page and shows the floating pet; the tray restores the same live window.
The development app automatically uses `apps/mcp-runtime/staging/<platform>-<arch>` and
`apps/local-model-runtime/runtime-staging/<platform>-<arch>` if present;
`AICHAT_MCP_RUNTIME_DIR` and `KP_LOCAL_MODEL_RUNTIME_DIR` override them. No runtime is required for native files
or user terminals. Use the tray menu's **退出** before starting a fresh debugging session.
The Start task (`npm start`) synchronizes the shared AIChat runtime, rebuilds the
standalone MCP bundle and Desktop shell, then launches that exact MCP bundle using
local Node. It stops an identified existing Keepwork MCP via its authenticated admin
endpoint and verifies the new process PID before opening Desktop. A conflicting
service or failed build/start aborts startup; no cached or downloaded MCP is selected.
Development MCP updates are disabled and Desktop owns its process until Quit.
Install dependencies in `apps/mcp-runtime` as well as the repository and Desktop.
MCP builds without a sibling AIChat checkout use the manifest-verified committed
runtime copy. The local AIChat page still requires its checkout when
`AICHAT_DESKTOP_LOCAL_SOURCE=1`; that is separate from building MCP.
Quit an already-running Desktop from its tray before starting this task again.
F5/Build keep their existing shell-only behavior. Neither path builds the AIChat website.

On macOS, the application menu is named **Keepwork**. Development builds prepare an
ad-hoc-signed private Electron bundle under ignored `.dev-runtime/Keepwork.app`;
Start and F5 use it because Cocoa reads the menu name from the bundle's
`CFBundleName`. The installed Electron SDK is left untouched. Published Mac
packages declare the same name; the product title and existing data directories
remain KeepWork 第二大脑 and the original profile paths.

From this repository, install root dependencies and `npm ci --prefix apps/aichat-desktop`.
Run `npm run check --prefix apps/aichat-desktop` and
`node apps/aichat-desktop/scripts/native-smoke.cjs` on each target OS. Native dependencies
must load inside the pinned Electron runtime, not merely the system Node executable.
Run `scripts/electron-smoke.cjs` from a workspace that also has the AIChat source checkout;
the release workflow does not clone that private cross-repository dependency.
After building, run `node apps/aichat-desktop/scripts/permissions-smoke.cjs` from the
repository root to check repeat/reload/restart consent using Electron's synthetic media
devices and an isolated profile. It does not record the real microphone or camera.
For macOS microphone acceptance, also test the signed app with a real input device:
Hardened Runtime requires `com.apple.security.device.audio-input` in the signing
entitlements as well as `NSMicrophoneUsageDescription` in Info.plist. Synthetic
devices do not validate this OS gate. Changing entitlements requires repackaging
and signing the desktop app; reloading the website cannot repair an installed app.

Use `npm start --prefix apps/aichat-desktop` for the live website. For local AIChat source,
set `AICHAT_DESKTOP_DEV_URL` to the actual loopback Live Server URL. This override is
ignored in installed builds. Never use AIChat's Vite/build/upload commands for validation.
Set `AICHAT_MCP_RUNTIME_DIR` to a staged native MCP runtime for development or packaging.
The Electron builder packages the existing stage; it does not rebuild the MCP runtime.
Restage after changing shared MCP source, then smoke-test it before packaging. Packaging
checks that the staged runtime's source commit matches the checkout and rejects stale stages.
Source mode remains usable without it: native files/terminal work and MCP reports unavailable.

`npm run stage --prefix apps/mcp-runtime -- --platform win32 --arch x64` produces a Windows
runtime. On native Mac runners use `darwin` and `arm64`/`x64`. Smoke-test that runtime, then
set its absolute staging directory as `AICHAT_MCP_RUNTIME_DIR`. Use `make:win` or `make:mac`
in the desktop package. Packaging rejects missing, stale, or wrong-platform runtimes.

## Lifecycle and data

The custom top title bar combines the K icon, File / Edit / View / Help (Windows only), product title
and native window controls in one row. It is installed by the isolated preload only after
main-process URL validation; embedded tools receive neither the title bar nor its menu IPC.
Clicking a menu posts `aichat.desktop-menu.v1` into the AIChat page, which draws it.
File starts a chat, opens a folder, reloads, checks updates, toggles login startup and quits.
Edit is undo, redo and the clipboard. View toggles the history sidebar and file panel, zoom,
fullscreen, settings, simple/professional modes and light/dark appearance. The title bar
shares the page CSS palette, including custom skin colors, and syncs resolved colors to
native window buttons. Help shows Keepwork MCP status, Dashboard, restart, the browser
entry, and the local or published page. Page actions stay in AIChat; native actions return
through `runMenuCommand`. The tray keeps the same service actions when the window is closed.
The address stays visible (including fullscreen): `localhost:<port>` for local source
or `keepwork.com/chat` for the published app. Click it to open the configured entry in
the external browser; the adjacent refresh icon reloads the current desktop page.
macOS uses its normal system application menu without duplicate in-window menus, and retains traffic-light window controls.
Theme changes still update native appearance and saved preferences on macOS; title-bar overlay colors are applied only on Windows/Linux when Electron exposes the overlay API.

The tray menu, and **Help** inside the window, include **Keepwork MCP Server**:
**查看状态** probes the live service and displays ownership, version, PID and workspace;
**打开 Dashboard** opens `http://127.0.0.1:8089/dashboard` in the browser;
**重启 Keepwork MCP Server** restarts the desktop-owned runtime or starts it if offline.
Services owned by VS Code or Local Helper must be restarted in their owning app; the
status is refreshed and an explanation is shown. Repeated restart clicks are coalesced.

**AIChat 服务器 → 使用本地源码服务器…** selects a folder containing `AIChat.html`
and serves it on loopback, without a website build. **使用线上服务器** returns to the
published entry. This selection applies to the current app session. Local pages reload
without cache via the refresh icon, menu or Ctrl/Cmd+R, and automatically after a successful
MCP restart. Local source changes are read directly from disk. Only the selected entry
gets the desktop bridge; Dashboard and embedded pages do not gain native privileges.

- Single application instance. Closing hides the main window and shows the floating pet;
  its renderer, draft, terminals, active call and text/agent tasks remain alive. Simple and
  PRO are unchanged. **打开 KeepWork 第二大脑** or a tray click restores the same window.
  The tray's **显示桌面宠物** preference is device-local and defaults on; disabling it
  ends dictation, live calling and wake-word capture without cancelling text tasks.
  Re-enabling never starts recording. Login startup (`--background`) remains tray-only.
  **退出** destroys both windows and closes native terminals and desktop-owned MCP only.
- Login startup is off by default and optional in the application menu.
- Electron's per-user application directory stores the persistent `aichat` browser session,
  `folder-grants.json`, `media-grants.json`, settings, and MCP runtime installation records. Never upload grants.
  The original `AIChat Desktop` installed profile directory (development: `aichat-desktop`),
  application ID and update feed stay stable across the product rename.
- Microphone and camera consent is remembered separately for the trusted top-level page,
  including across reloads, window recreation and app restarts. Local source and published
  pages have separate grants. Concurrent identical requests share one prompt. Denial is
  not saved, so a later explicit attempt can ask again. OS privacy permissions still apply.
  To reset these app-level grants, quit the app and remove `media-grants.json` from its
  user-data directory; this does not reset the system microphone/camera permissions.
- **Open Folder** grants a canonical directory and connects it to AIChat. Reopening a saved
  cloud workspace does not authorize access. Select its folder again on a new device.
- Workspace file operations follow symlinks/junctions inside a selected root, including external targets, matching MCP file access. Absolute paths and parent traversal remain rejected; replaced roots require reselection. Recursive scans detect link loops, and deleting a link preserves its target. Terminal working directories still require a grant for external targets.
- Native terminal input is user-operated; agent `run_terminal` still uses MCP and existing
  confirmation. Disabling MCP does not remove native files or terminal tabs.

## Bridge v1

Only the main AIChat window may invoke `aichat-desktop:v1`. Preload exposes
`window.aichatDesktop` with `version`, `capabilities`, `roots`, `pickFolder`, `revokeFolder`,
`file`, `terminal`, `status`, `checkUpdates`, `installUpdate`, `onUpdateStatus`, and `onFolderSelected`. File calls use opaque
root IDs plus relative paths. Native folder grants cannot be created from renderer arguments.
Frame, webContents and exact page URL checks run on every invocation. Embedded tools and
previews do not receive the preload. No generic IPC, filesystem, shell or Node objects escape.

## Three independent update streams

The live website changes on launch/reload. Shell and MCP updates download at startup and every six hours. **Help → 检查更新…**
opens a dedicated update window; File and tray entries open the same window. It shows
installed and latest versions separately for MCP and desktop, MCP build date (`builtAt`),
and desktop release date when supplied by the feed. Missing dates are shown as unavailable;
failed checks retain the last successful metadata and mark it stale. External MCP ownership
and its running version are shown separately from the desktop's installed runtime.

A newly downloaded MCP release produces one notification. Click it, or **更新 MCP** in the
window, to confirm restarting MCP now; running MCP operations are interrupted. **稍后**
keeps it staged for the next full application launch. Closing/reopening the chat window,
ordinary MCP restart, and heartbeat recovery do not activate pending updates. Manual apply
never stops an externally owned service. Failed candidates roll back and are not downloaded
again until a different release is published. The desktop shell version does not change.

**更新桌面应用** asks for confirmation before quitting and installing a downloaded shell
update. Closing the update window does not cancel downloads; ordinary Quit does not silently
install a shell update. Local-model remains installer-managed.
MCP updates verify platform, size, SHA-256, source commit and launch metadata before staging;
health checks promote them on startup. Failed startup falls back to the prior installed or
bundled runtime. At startup, the desktop checks the existing Keepwork MCP on the configured
loopback port (currently **8089**, not 8099) against the newest valid local runtime, including
the bundled and staged copies. If its `runtimeVersion` (never the protocol `version`) is lower, the
desktop rechecks service identity, forcibly terminates that specific PID, waits for the
listener to disappear, and starts its own runtime. Equal/newer or unknown versions remain
attached; unrelated services, local-model services and invalid/self PIDs are never killed.
Missing local runtimes or termination failures do not start a competing service. Manual
restart and Quit still stop only desktop-owned processes.

The stable runtime feed is `https://cdn.keepwork.com/keepwork/mcp-stable/<target>.json`.
Archives live in immutable version directories. The every-main six-file feed is unchanged.
Desktop updater feeds are under `https://cdn.keepwork.com/keepwork/aichat-desktop/<platform>-<arch>/`.
Each desktop package bundles both the MCP Node runtime and the `local-model` Node runtime
(including the signed model package). Each target also publishes `latest-client.json` for the AIChat website's single client-download
button. That manifest points to the fixed `KeepWork-SecondBrain.zip` alias in its target
directory (`win32-x64`, `darwin-arm64`, or `darwin-x64`). The publisher uploads and verifies
the alias from the versioned ZIP before promoting the manifest. AIChat declares
`CLIENT_RELEASE_VERSION` in `js/client_download.js`; update it with each website release.
Manifest requests use that version and package requests append `?v=<manifest version>`
to separate CDN cache entries. The fixed alias always serves the current release, not an
archive of older releases. Versioned ZIPs remain available for updater metadata.
Installer and updater artifacts remain
available in the same directory but are not exposed by the website download flow.

## Release prerequisites

The **Build KeepWork 第二大脑** workflow builds Windows x64 and both Mac architectures. Default
runs retain internal artifacts only; Mac development ZIPs receive a coherent ad-hoc signature.
Public publication requires its publish input and the `aichat-desktop-production` environment.
Configure Qiniu credentials plus `KP_MAC_CSC_LINK`, `KP_MAC_CSC_KEY_PASSWORD`, `KP_APPLE_ID`,
`KP_APPLE_APP_SPECIFIC_PASSWORD`, and `KP_APPLE_TEAM_ID` as environment secrets. Public Mac
artifacts pass strict code-signature, Gatekeeper, and notarization-ticket checks when Apple secrets
are configured. Without them, the workflow publishes a coherent ad-hoc-signed Mac ZIP; macOS users
may need to approve it in System Settings. Windows publishing and bundled `local-model` remain
mandatory gates.

The **Coordinated Keepwork stable release** workflow requires matching committed MCP/VSIX
versions and a `keepwork-v<version>` tag or manual dispatch. It publishes the npm CLI and
the matching VSIX, then promotes the verified stable CDN feed. Configure npm trusted publishing
for `keepwork-mcp-runtime` and this workflow, an npm dist-tag token (`NPM_DIST_TAG_TOKEN`),
Qiniu secrets and Entra OIDC publisher access (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`). Register
the package/publisher first; the workflow cannot claim an npm identity without account access.
The VSIX is compiled without auto-incrementing its version. Retry failed jobs using their
original artifacts; never overwrite an immutable version with a fresh build.

npm is the public package registry. China users may install the CLI through
`npm install -g keepwork-mcp-runtime --registry=https://registry.npmmirror.com`; mirror
propagation can lag. Desktop users download complete runtimes from Keepwork CDN and need
neither npm nor a global Node installation. No VS Code Marketplace downloads occur in the app.

Before public rollout, verify installed N→N+1 updates, signing/Gatekeeper, Keepwork login,
microphone/camera prompts, local HTML previews, offline retry, tray lifecycle and coexistence
with an already running extension on Windows and both Mac architectures.


### Update-window verification

Run `npm run check --prefix apps/aichat-desktop`, then
`node apps/aichat-desktop/scripts/updates-smoke.cjs` for real Electron menu/window/IPC and
version/date rendering with an isolated profile and no remote downloads. The smoke writes
`.test-runtime/aichat-updates.png`. Runtime tests cover staged activation, metadata-only
checks, integrity failures, health identity verification and rollback.

To release MCP independently, publish a new version through **Coordinated Keepwork stable
release** (the existing matching MCP/VSIX version and tag requirements still apply). Desktop
clients check the stable manifests and download the immutable runtime archive without a
new desktop package. This change itself needs one desktop release to deliver the window.
Before rollout, verify packaged N→N+1 activation on all three supported targets; source
Electron smoke does not substitute for installer/signing acceptance.


### Floating pet verification

`src/petWindow.cjs` owns a packaged, transparent, always-on-top companion with its own
sandboxed preload. Only its exact main frame may call the restricted pet IPC channel;
files, terminals and arbitrary Node APIs are absent. The main AIChat renderer publishes
bounded presentation snapshots and handles commands through optional v1 `floatingPet`
capability methods. Closing retains one chat runtime; a pet is never a second conversation.
No native credential or model configuration is projected into the pet window.

Run `node --test apps/aichat-desktop/tests/pet-*.test.cjs` from the repository root.
`node apps/aichat-desktop/scripts/pet-smoke.cjs` exercises the real sandboxed pet window
without building, starting MCP or using real accounts. Set `PET_SCREENSHOT` to an absolute
PNG path for a visual artifact. Speech/call responses in this smoke use fixtures; real
microphone permissions/audio, multi-monitor movement and OS focus behavior require native
acceptance on Windows and macOS.

Desktop pet menu and click stability (2026-10-23): right-click opens a native
menu with 0.5–4× size, current AIChat pet/default dragon appearance, a MagicHaqi
appearance-management link, Open AIChat, and Hide. Size/appearance are desktop
preferences saved in settings.json. Hide persists the tray visibility setting and
stops capture without canceling work; use the tray to restore the pet.

The transparent work-area canvas stays fixed on composer toggles and incoming
replies. Only pet/chat pixels intercept input; dragging moves those layers and the
composer fits above or below the pet. Artwork styles update only on changes.
Opening the composer plays a 460 ms jelly animation and a short composer entrance;
reduced-motion users get neither animation.

Regression `DESKTOP-PET-CLICK-STABILITY-001` is covered by
`tests/pet-window.test.cjs` (no native bounds changes on click, including drag-end;
movement to the display top; menu settings/hide), `tests/pet-renderer.test.cjs`,
and `scripts/pet-smoke.cjs` (real native popup, saved settings, unchanged click
bounds and jelly/reduced-motion behavior). All 10 focused tests, Electron smoke,
and TypeScript checking passed. A temporary copy of HEAD's old petWindow.cjs
fails the new click-stability test; evidence is in
`.test-runtime/proofs/pet-click-stability/historical.log`. No build, packaging,
publication, live microphone or multi-monitor hardware acceptance was performed.

Full exit from the pet menu (2026-10-23): “完全退出…” opens a confirmation bubble
above the pet (or below when there is no room). It requests the current account's
persona names and enabled channel labels through the existing host bridge and
shows Feishu/DingTalk labels without credentials or workspace paths. A loading
state disables confirmation, failures explicitly report an unavailable list,
and shared MCP runtimes get different impact wording. Continue/Escape cancels;
Confirm calls the existing app.quit shutdown path once. Hide/reset/account changes
invalidate the prompt. `pet-window.test.cjs` and `pet-smoke.cjs` cover native
confirmation, cancellation, stale IDs and displayed names. App quit is stubbed in
the smoke; live services were not stopped. 11 native tests and TypeScript checks
passed, along with the AIChat host's 7 unit and Edge integration tests.
