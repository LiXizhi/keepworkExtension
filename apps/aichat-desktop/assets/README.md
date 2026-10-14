# Keepwork application icon

`keepwork.png` is the existing 512×512 Keepwork K brand icon, copied unchanged from
`keepwork-nuxt/public/pwa/icon.png`. It is shared visually by the installer, window,
Windows taskbar and tray/menu bar. No runtime dependency on that repository.

`keepwork-mac.png` is the macOS application and Dock variant: a 1024×1024 transparent
canvas with the original logo inside an inset rounded square. Both the package icon
and Electron's runtime Dock override use it. The menu bar keeps the compact original.
Regenerate on macOS with `swift apps/aichat-desktop/scripts/mac-icon.swift` from the
repository root. No image-generation service or additional dependency is required.
