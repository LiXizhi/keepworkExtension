---
status: accepted
date: 2026-11-13
---

# Native Android and iOS applications

Implement the mobile pet in Kotlin on Android and Swift/SwiftUI on iOS, sharing service contracts, assets, and acceptance fixtures while retaining the existing Electron and Tauri desktop applications. The user chose native applications over a shared Flutter or React Native UI because the selected product depends heavily on platform-specific overlay, audio, background lifecycle, interruption, and widget behavior.

This accepts separate mobile UI implementations and their maintenance cost in exchange for direct platform control. Shared contract definitions do not authorize imports between application directories or require rewriting the desktop hosts.
