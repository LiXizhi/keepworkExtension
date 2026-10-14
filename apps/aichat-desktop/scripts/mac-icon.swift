// Run from any directory: swift apps/aichat-desktop/scripts/mac-icon.swift
// Keep the original brand pixels; only the macOS silhouette and spacing change.
import AppKit

let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("assets")
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: size * 4, bitsPerPixel: 32)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
NSBezierPath(roundedRect: tile, xRadius: 184, yRadius: 184).addClip()
let brand = NSImage(contentsOf: assets.appendingPathComponent("keepwork.png"))!
brand.draw(in: tile, from: .zero, operation: .copy, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!
    .write(to: assets.appendingPathComponent("keepwork-mac.png"))
