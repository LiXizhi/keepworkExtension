# KeepWork 第二大脑

An independent Electron window for `https://keepwork.com/chat`, with native folder grants,
workspace files and PTY terminals. Keepwork MCP runs as a separately supervised bundled
NodeRuntime. The existing KP Local Helper is not replaced; speaker models are not included.

## Develop and verify

### VS Code startup and debugging

Open the `keepworkExtension` repository or this `apps/aichat-desktop` folder in VS Code.
After installing dependencies, choose **Terminal → Run Task → KeepWork 第二大脑: Start**.
For main-process breakpoints, choose **KeepWork 第二大脑: Debug** in Run and Debug and
press **F5**; its pre-launch task builds the Electron source and source maps automatically.
Windows and both Mac architectures use the locally installed Electron executable.
Task/F5 sets `AICHAT_DESKTOP_LOCAL_SOURCE=1`: the app serves the sibling
`apps/official/apps/tools/AIChat` checkout over loopback HTTP, starting at port 3001
and skipping occupied ports. Set `AICHAT_SOURCE_DIR` if that checkout lives elsewhere.
The terminal prints the actual source URL. An explicit `AICHAT_DESKTOP_DEV_URL` takes
priority for an existing Live Server. Missing source fails visibly instead of opening
the published website. The owned HTTP server stops on Quit. Closing the window destroys
the page and leaves that server running so the tray can open a new window.
The development app automatically uses `apps/mcp-runtime/staging/<platform>-<arch>` if
present; `AICHAT_MCP_RUNTIME_DIR` overrides it. No runtime is required for native files
or user terminals. Use the tray menu's **退出** before starting a fresh debugging session.
These tasks build only the desktop shell, never the AIChat website.

From this repository, install root dependencies and `npm ci --prefix apps/aichat-desktop`.
Run `npm run check --prefix apps/aichat-desktop` and
`node apps/aichat-desktop/scripts/native-smoke.cjs` on each target OS. Native dependencies
must load inside the pinned Electron runtime, not merely the system Node executable.
Run `scripts/electron-smoke.cjs` from a workspace that also has the AIChat source checkout;
the release workflow does not clone that private cross-repository dependency.

Use `npm start --prefix apps/aichat-desktop` for the live website. For local AIChat source,
set `AICHAT_DESKTOP_DEV_URL` to the actual loopback Live Server URL. This override is
ignored in installed builds. Never use AIChat's Vite/build/upload commands for validation.
Set `AICHAT_MCP_RUNTIME_DIR` to a staged native MCP runtime for development or packaging.
Source mode remains usable without it: native files/terminal work and MCP reports unavailable.

`npm run stage --prefix apps/mcp-runtime -- --platform win32 --arch x64` produces a Windows
runtime. On native Mac runners use `darwin` and `arm64`/`x64`. Smoke-test that runtime, then
set its absolute staging directory as `AICHAT_MCP_RUNTIME_DIR`. Use `make:win` or `make:mac`
in the desktop package. Packaging rejects missing or wrong-platform runtimes.

## Lifecycle and data

The custom top title bar combines the K icon, File / Edit / View / Help, product title
and native window controls in one row. It is installed by the isolated preload only after
main-process URL validation; embedded tools receive neither the title bar nor its menu IPC.
Clicking a menu posts `aichat.desktop-menu.v1` into the AIChat page, which draws it.
File starts a chat, opens a folder, reloads, checks updates, toggles login startup and quits.
Edit is undo, redo and the clipboard. View toggles the history sidebar and file panel, zoom,
fullscreen and settings. Help shows Keepwork MCP status, Dashboard, restart, the browser
entry, and the local or published page. Page actions stay in AIChat; native actions return
through `runMenuCommand`. The tray keeps the same service actions when the window is closed.
The address stays visible (including fullscreen): `localhost:<port>` for local source
or `keepwork.com/chat` for the published app. Click it to open the configured entry in
the external browser; the adjacent refresh icon reloads the current desktop page.
macOS retains its normal system application menu and traffic-light window controls.

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

- Single application instance. Closing the window destroys it and releases the page,
  renderer process, and native terminal sessions. The tray process stays, and Keepwork MCP
  keeps running (including a daemon owned by VS Code or Local Helper). The tray icon remains
  in the taskbar notification area; **打开 KeepWork 第二大脑** or a tray click creates a new
  window. Login startup (`--background`) starts the tray and MCP without loading the page.
  **退出** closes native terminals and desktop-owned MCP only.
- Login startup is off by default and optional in the application menu.
- Electron's per-user application directory stores the persistent `aichat` browser session,
  `folder-grants.json`, settings, and MCP runtime installation records. Never upload grants.
  The original `AIChat Desktop` installed profile directory (development: `aichat-desktop`),
  application ID and update feed stay stable across the product rename.
- **Open Folder** grants a canonical directory and connects it to AIChat. Reopening a saved
  cloud workspace does not authorize access. Select its folder again on a new device.
- Symlink/junction names are visible. Targets outside granted roots require another grant.
- Native terminal input is user-operated; agent `run_terminal` still uses MCP and existing
  confirmation. Disabling MCP does not remove native files or terminal tabs.

## Bridge v1

Only the main AIChat window may invoke `aichat-desktop:v1`. Preload exposes
`window.aichatDesktop` with `version`, `capabilities`, `roots`, `pickFolder`, `revokeFolder`,
`file`, `terminal`, `status`, `checkUpdates`, and `onFolderSelected`. File calls use opaque
root IDs plus relative paths. Native folder grants cannot be created from renderer arguments.
Frame, webContents and exact page URL checks run on every invocation. Embedded tools and
previews do not receive the preload. No generic IPC, filesystem, shell or Node objects escape.

## Three independent update streams

The live website changes on launch/reload. Shell and MCP updates download at startup and
every six hours, and activate after **Quit** and restart. Closing the window is not a restart.
MCP updates verify platform, size, SHA-256, source commit and launch metadata before staging;
health checks promote them on startup. Failed startup falls back to the prior installed or
bundled runtime. A compatible daemon owned by VS Code/Local Helper is attached and never
stopped by this app; its owning application must restart it to update that running instance.

The stable runtime feed is `https://cdn.keepwork.com/keepwork/mcp-stable/<target>.json`.
Archives live in immutable version directories. The every-main six-file feed is unchanged.
Desktop updater feeds are under `https://cdn.keepwork.com/keepwork/aichat-desktop/<platform>-<arch>/`.
Each target also publishes `latest-client.json` for the AIChat website's single client-download
button. That manifest always points to the target ZIP; installer and updater artifacts remain
available in the same directory but are not exposed by the website download flow.

## Release prerequisites

The **Build KeepWork 第二大脑** workflow builds Windows x64 and both Mac architectures. Default
runs retain internal artifacts only. Public publication requires its publish input and the
`aichat-desktop-production` environment. Configure Qiniu credentials as CI secrets. The current
workflow publishes unsigned Windows and Mac builds, matching the repository's existing desktop
release infrastructure. Signed Windows and notarized Mac distribution remain a separate release gate.

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
