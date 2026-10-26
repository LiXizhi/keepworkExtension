# Keepwork permission pet companion

This application supplies Electron for the shared native pet in `src/pet`. It launches
only the pet and permission bubble, not AIChat. The existing AIChat desktop pet reuses
the same UI and daemon bridge. No accounts or network artwork are required for approval;
a local emoji fallback remains visible if the configured pet art is unavailable.

Install development dependencies with `npm ci --prefix apps/pet-companion`, then run
`node apps/pet-companion/node_modules/electron/install.js` to prepare Electron 44.1.1.
The Electron package downloads lazily; `npm ci` alone may not fetch the executable.
The daemon does not download software at screenshot time. Missing runtime errors require
repairing the installation. `node scripts/pet-permission-native.cjs` validates the native
standalone launch and all bubble choices without persisting real screenshot approval.

`scripts/pet-companion-stage.cjs` copies shared UI plus the pinned Electron distribution.
VS Code and Local Helper build hooks stage it beside their daemon; Local Helper unpacks
it outside ASAR. NodeRuntime stages the matching target runtime into `app/pet-companion`.
Desktop packaging receives that NodeRuntime resource. This adds an Electron distribution
to standalone packages so a separate desktop-app installation is unnecessary.

Cross-target release staging requires extracted Electron 44.1.1 distributions:
`KEEPWORK_PET_ELECTRON_WIN32_X64`, `KEEPWORK_PET_ELECTRON_DARWIN_X64`, or
`KEEPWORK_PET_ELECTRON_DARWIN_ARM64`. Each points to the distribution directory containing
`version` and `electron.exe` or `Electron.app`. Existing package integrity manifests cover
these staged files. Build/installers and publication are separate operations.

The companion authenticates to the daemon using the per-user
`~/.keepwork-mcp/pet-permission-bridge.json` record. The renderer has no network or Node
access and accepts only dedicated permission choices through validated native IPC.
`KEEPWORK_PET_HOME` is a native-process override for isolated tests; it is not a tool argument.

Universal VSIX/npm packaging on Linux runs `npm run prepare:all --prefix apps/pet-companion`
to obtain all three pinned platform distributions, with the Electron package's checksums.
It stages them under `electron/<platform>-<arch>` and selects only the native executable
at runtime. Native installer jobs prepare only their own platform. Universal packages
are consequently larger than native packages; no runtime download occurs during capture.
