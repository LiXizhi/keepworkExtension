# Desktop launcher releases

The native launcher runs on Windows x64, Apple Silicon and Intel Macs. Users extract the launcher ZIP and keep the executable or app in a permanent location. First launch needs network access. The launcher downloads the signed release manifest, the shared app ZIP and the dependency ZIP for that machine. Download progress is visible and interrupted transfers can resume. Subsequent launches use the locally installed release. Desktop checks again after startup and every six hours. The update window can apply a staged release by restarting Desktop.

## Publish

Use **Actions → AIChat Desktop launcher release** on keepworkExtension main. Enter a Desktop semantic version and the full commit SHA of the AIChat GitHub source backup. The workflow builds one portable archive from these sources. Run with **publish** disabled to inspect build artifacts without changing the CDN.

| Mode | Use | CDN changes |
| --- | --- | --- |
| initial | Set up this channel once | One shared ZIP, three native dependency ZIPs, three small launcher downloads, the signed stable manifest and the website's platform download descriptors |
| code | Change menus, window behavior, web UI, MCP implementation, local-model code, skills or pet code | One shared ZIP and the signed stable manifest |
| refresh-platforms | Change Electron, Node, native packages, locked runtime dependencies, or bundled model data | Rebuild the platform dependency archives and shared archive, then promote the manifest |

The app and native builds record a dependency contract. Code promotion checks it against all three platform descriptors in the previous signed manifest. A contract change requires refresh-platforms. Desktop, MCP and local-model retain their respective product versions and protocol capabilities. Each archive has an immutable SHA-256 CDN key. The publisher uploads and verifies the objects before replacing stable.json. A greater release sequence can also reissue known-good application code.

Configure the **aichat-desktop-production** environment before the first public release.

- Set the variable `KP_DESKTOP_LAUNCHER_PUBLIC_KEY` to the base64 encoding of the raw 32-byte Ed25519 public key.
- Put the corresponding PEM private key in the secret `KP_DESKTOP_MANIFEST_PRIVATE_KEY`. Keep the same public key across code and dependency releases. A replacement trust root requires distributing a new launcher.
- The publisher uses the existing `KP_QINIU_ACCESS_KEY` and `KP_QINIU_SECRET_KEY` secrets. The Mac launcher builder accepts a Developer ID identity and notarization keychain profile. The Windows builder accepts a certificate thumbprint from the signing machine. The manifest signature authenticates downloaded archives independently of OS signing.

The signed channel lives under `https://cdn.keepwork.com/keepwork/aichat-launcher/v1/`. The mutable file is `stable.json`. Packages use `objects/<sha256>.zip`. Initial publication points the website's existing per-platform latest-client.json files to Keepwork-Launcher ZIPs under the corresponding aichat-desktop/win32-x64, darwin-x64 and darwin-arm64 directories. Those bootstrap download descriptors describe the initial release. Launcher clients discover subsequent code versions through the signed channel.

Existing full installations continue to use their previous updater. Users can switch by fully quitting Desktop and opening the new launcher. The process uses the existing Desktop profile and Keepwork web origin. The legacy installer and standalone MCP release commands remain available. Use the launcher workflow for code-only Desktop publication.

## Package contents and activation

The shared archive contains compiled Desktop main and preload code, the AIChat web resources from the selected commit, the Keepwork SDK used on startup, the MCP bundle and skills, pet scripts and local-model service code. The platform archive supplies Electron (shared by Desktop and the standalone pet), Node executables, external Node dependencies, local-model data and the pinned Tailwind script. Built-in web startup scripts are available offline. Online chat and remote tools still require their respective services.

The launcher validates the manifest signature, selected platform, compressed size and digest before unpacking. It builds a new release from verified objects using hard links within the per-user store. The app and dependency trees must be disjoint. macOS framework links and executable modes are preserved. A failed candidate stays separate from the current release. After the Desktop startup acknowledgment, the launcher atomically updates state and retains the previous release. Application settings and conversations live outside the launcher cache.

The store is under `%LOCALAPPDATA%\Keepwork\DesktopLauncher` on Windows and `~/Library/Application Support/Keepwork/DesktopLauncher` on macOS. Standard per-user NTFS/APFS installations support the hard links used by the store.

## Verification

Run `go test ./...` in this directory on either supported OS. The local HTTPS fixture exercises first installation and a menu-only update for all target descriptors. To exercise real artifacts, set `KP_LAUNCHER_TEST_PACKAGES` to the directory containing app.json, the native target descriptor and both ZIPs, then run `go test -count=1 -run TestPackagedRuntime -v`. This runs native PTY checks and opens the packaged chat page in a hidden Electron window with remote API traffic disabled and an isolated browser profile.

Run `npm run check --prefix apps/aichat-desktop` from the repository root for the Desktop suite. Initial and platform-refresh workflows exercise native packages on each target runner.

The coordinated Marketplace release calls this same workflow in code mode after MCP promotion. It builds from the extension release commit and the checked-out AIChat backup main revision, and uses the globally unique Actions run ID for the signed sequence. Installed launcher clients retain cached platform archives.
