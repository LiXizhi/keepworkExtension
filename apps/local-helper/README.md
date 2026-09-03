# KP Local Helper

KP Local Helper packages the existing Keepwork MCP server as a per-user Windows tray application for people who use the web AIChat without VS Code. It is built from this repository and imports the same `src/core` and `src/mcp` implementation as the extension and CLI.

## Repository layout

- `src/core`, `src/mcp`: shared implementation
- `apps/vscode-extension/src/cli.ts`: CLI entry point embedded in the VS Code application
- `apps/vscode-extension/src/extension.ts`, `apps/vscode-extension/src/vscode`: VS Code integration
- `apps/local-helper`: Electron tray, login startup, notification bridge, update and installer configuration

The nested package owns the helper's packaging metadata, release version and desktop-only dependencies. It is not a separate repository or a copy of the MCP implementation. The repository root is a private shared-runtime package, not a product manifest.

## End-user flow

1. Download the signed `KP-Local-Helper-Setup-<version>-x64.exe` from the Keepwork website.
2. Run the installer once. It installs for the current Windows user without an administrator prompt and starts the tray helper.
3. Open [https://keepwork.com/chat](https://keepwork.com/chat). AIChat continues to use the local MCP endpoint exactly as it does with the VS Code extension.
4. On later Windows logins, the helper starts in the system tray automatically. The tray menu shows service status and provides workspace, update, log, and exit actions.

Uninstalling removes the application and its login entry. It intentionally keeps `%USERPROFILE%\.keepwork-mcp`, including the user's workspace and logs, so uninstall cannot delete user-created files.

## Local development

```bash
npm ci
npm run check:shared
npm ci --prefix apps/local-helper
npm --prefix apps/local-helper run check
npm --prefix apps/local-helper run pack
```

The helper `pack` script is useful for local development of the Electron shell. The supported release target is Windows x64. A packaged helper starts the MCP server on the configured loopback port, attaches when a compatible Keepwork MCP is already running, writes bounded logs under `%USERPROFILE%\.keepwork-mcp\helper.log`, and exposes status/actions through the system tray.

## Windows installer

Build Windows x64 on Windows so the bundled `node-pty` native files are rebuilt and tested against the selected Electron version:

```powershell
npm ci
npm ci --prefix apps/local-helper
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
  "KP_HELPER_PUBLISH_URL": "https://cdn.keepwork.com/downloads/kp-local-helper/windows-x64"
}
```

`KP_WINDOWS_CSC_LINK` is a local PFX path in this file. Alternatively, leave the PFX fields empty and set `KP_WINDOWS_CERT_SUBJECT` to the subject of a certificate installed in the Windows certificate store. HSM or cloud signing requires the provider-specific Electron Builder signing adapter.

`build.local.json` is ignored by Git and must remain local. A public build must set `KP_REQUIRE_CODE_SIGNING` to `true`, so packaging fails instead of silently producing an unsigned installer.

## Run the Windows CI build

1. For a GitHub-hosted Windows runner, configure repository secret `KP_WINDOWS_CSC_LINK` with the base64-encoded PFX and `KP_WINDOWS_CSC_KEY_PASSWORD` with its password. Use `KP_WINDOWS_CERT_SUBJECT` only on a self-hosted runner where that certificate is already installed.
2. Open GitHub Actions, select **Build KP Local Helper for Windows**, and run the workflow. Leave **require signing** enabled for any public build.
3. Optionally enter the stable HTTPS update-channel URL. This embeds the updater feed and adds `latest.json` to the CI artifact.
4. Download the `kp-local-helper-windows-x64` artifact. The workflow has already rejected a missing or invalid Authenticode signature when signing is required.
5. Publish the verified files to the CDN in a separate release step with production upload credentials.

## Update and download publication

Set `KP_HELPER_PUBLISH_URL` in `build.local.json` while building a release to embed an `electron-updater` generic feed. It must be a stable Windows update-channel directory, not a version-specific directory, because installed clients keep checking that URL for later releases. The build produces the updater metadata next to the installer. Generate the web download manifest after signing:

```powershell
node apps/local-helper/scripts/generate-release-manifest.cjs `
  --file apps/local-helper/release/KP-Local-Helper-Setup-0.1.15-x64.exe `
  --version 0.1.15 `
  --protocol-version 0.1.2 `
  --base-url https://cdn.keepwork.com/downloads/kp-local-helper/windows-x64 `
  --output apps/local-helper/release/latest.json
```

Upload the signed installer, `latest.yml`, block map, and `latest.json` to that stable HTTPS object-storage/CDN directory. Keep older installers available by their versioned file names. The workflow intentionally creates a CI artifact but does not upload to a production CDN until its provider and credentials are explicitly configured.
