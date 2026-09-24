# KP Local Helper

KP Local Helper packages the Keepwork MCP server and the independent local-model runtime as one per-user Windows x64 tray application. One installation provides MCP on `127.0.0.1:8089` and speaker embedding on `127.0.0.1:18089`.

## Repository layout

- `src/core`, `src/mcp`: shared implementation
- `apps/vscode-extension/src/cli.ts`: CLI entry point embedded in the VS Code application
- `apps/vscode-extension/src/extension.ts`, `apps/vscode-extension/src/vscode`: VS Code integration
- `apps/local-helper`: Electron tray, login startup, notification bridge, update and installer configuration
- `apps/local-model-runtime`: separately staged Node.js runtime, model service, ONNX artifact and integrity metadata

The nested package owns the helper's packaging metadata, release version and desktop-only dependencies. local-model remains a separate supervised process so model failures do not take down MCP. It has no independent installer or release manifest. The VS Code VSIX never includes its source, native dependency or model files.

## End-user flow

1. Download the internal unsigned `KP-Local-Helper-Setup-<version>-x64.exe` from the Keepwork website.
2. Run the installer once. It installs for the current Windows user without an administrator prompt and starts the tray helper.
3. Open [https://keepwork.com/chat](https://keepwork.com/chat). AIChat continues to use the local MCP endpoint exactly as it does with the VS Code extension.
4. On later Windows logins, the helper starts in the system tray automatically. The tray shows MCP and model status independently and provides unified recheck, update, log, and exit actions.

Uninstalling stops only processes started by this Helper and removes its login entry. It intentionally keeps `%USERPROFILE%\.keepwork-mcp`, AIChat IndexedDB speaker profiles, and user-created workspace files. A compatible service already occupying either port is attached, not killed.

## Local development

```bash
npm ci
npm run check:shared
npm ci --prefix apps/local-helper
npm ci --prefix apps/local-model-runtime
npm --prefix apps/local-model-runtime run check
npm --prefix apps/local-model-runtime test
npm --prefix apps/local-helper run check
npm --prefix apps/local-helper run pack
```

The helper `pack` script is useful for local development of the Electron shell. The supported release target is Windows x64. A packaged helper starts the MCP server on the configured loopback port, attaches when a compatible Keepwork MCP is already running, writes bounded logs under `%USERPROFILE%\.keepwork-mcp\helper.log`, and exposes status/actions through the system tray.

## Windows installer

Build Windows x64 on Windows so the bundled `node-pty` native files are rebuilt and tested against the selected Electron version:

```powershell
npm ci
npm ci --prefix apps/local-helper
npm ci --prefix apps/local-model-runtime
npm --prefix apps/local-model-runtime run runtime:stage -- --platform win32 --arch x64
npm --prefix apps/local-model-runtime run runtime:smoke -- apps/local-model-runtime/runtime-staging/windows-x64
npm run check:shared
npm --prefix apps/local-helper run check
npm --prefix apps/local-helper run make:win
```

Output: `apps/local-helper/release/KP-Local-Helper-Setup-<version>-x64.exe`.

The NSIS installer is per-user, does not request elevation, starts the helper after installation, and lets the helper register itself for login startup on first packaged launch.

## Code signing

Unsigned installers are only for internal testing. Copy the ignored local build configuration before packaging:

```powershell
Copy-Item apps/local-helper/build.local.example.json apps/local-helper/build.local.json
```

For an unsigned internal build, leave the certificate fields empty and keep `KP_REQUIRE_CODE_SIGNING` set to `false`. For a signed PFX build, edit the private file:

```json
{
  "KP_WINDOWS_CSC_LINK": "C:\\secure\\keepwork-code-signing.pfx",
  "KP_WINDOWS_CSC_KEY_PASSWORD": "the-pfx-password",
  "KP_WINDOWS_CERT_SUBJECT": "",
  "KP_REQUIRE_CODE_SIGNING": true,
  "KP_HELPER_PUBLISH_URL": "https://cdn.keepwork.com/keepwork/KeepworkExtension-Windows-Setup"
}
```

`KP_WINDOWS_CSC_LINK` is a local PFX path in this file. Alternatively, leave the PFX fields empty and set `KP_WINDOWS_CERT_SUBJECT` to the subject of a certificate installed in the Windows certificate store. HSM or cloud signing requires the provider-specific Electron Builder signing adapter.

`build.local.json` is ignored by Git and must remain local. The current release workflow intentionally produces an unsigned installer, so Windows identifies the publisher as unknown and may show a SmartScreen warning. When Authenticode credentials are available, set `KP_REQUIRE_CODE_SIGNING` to `true` so packaging fails instead of silently publishing an unsigned installer.

## Run the Windows release workflow

Configure repository Actions secrets `KP_QINIU_ACCESS_KEY` and `KP_QINIU_SECRET_KEY`. The values are used only by the Windows release job and must never be committed or printed. The workflow publishes unsigned internal releases to:

`https://cdn.keepwork.com/keepwork/KeepworkExtension-Windows-Setup/`

Open GitHub Actions and manually run **Build and publish KP Local Helper for Windows** to publish the current stable `X.Y.Z` version. On later pushes to `main`, the workflow compares `apps/local-helper/package.json` before and after the push. It publishes only when the version strictly increases; unchanged versions are skipped and invalid or decreasing versions fail. Releases are serialized so an older build cannot overwrite newer `latest` metadata.

The workflow builds on Windows x64, retains a versioned GitHub Actions artifact, uploads the installer with Qiniu multipart v2 and the smaller files with form upload before publishing `latest.yml` and `latest.json`, refreshes the CDN, and verifies every published file by SHA-256. Current releases are intentionally unsigned until Authenticode credentials and policy are enabled again.

## Update and download publication

Set `KP_HELPER_PUBLISH_URL` in `build.local.json` while building a release to embed an `electron-updater` generic feed. It must be a stable Windows update-channel directory, not a version-specific directory, because installed clients keep checking that URL for later releases. The build produces the updater metadata next to the installer. Generate the web download manifest after signing:

```powershell
node apps/local-helper/scripts/generate-release-manifest.cjs `
  --file apps/local-helper/release/KP-Local-Helper-Setup-0.1.16-x64.exe `
  --version 0.1.16 `
  --protocol-version 0.1.2 `
  --base-url https://cdn.keepwork.com/keepwork/KeepworkExtension-Windows-Setup `
  --output apps/local-helper/release/latest.json
```

The automated workflow stages and smoke-tests local-model, builds the unified installer, silently installs it, verifies both health endpoints and a real 512-dimensional embedding, then uploads the installer, block map, `latest.yml`, and `latest.json` in that order. `latest.json` declares `capabilities: ["mcp", "local-model"]`, `localModelProtocolVersion`, installer size and SHA-256. CDN bytes are verified before publication completes. Keep older installers available by versioned file name; only latest metadata is replaced.
