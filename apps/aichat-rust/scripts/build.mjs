import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const distDir = path.join(appRoot, "dist");
const tauriDir = path.join(appRoot, "src-tauri");
const iconsDir = path.join(tauriDir, "icons");

fs.mkdirSync(iconsDir, { recursive: true });

// Copy standard Tauri icons from grokx / aichat-desktop assets so bundling works on all targets.
const desktopAssets = path.join(repoRoot, "apps/aichat-desktop/assets");
for (const name of ["keepwork.png", "keepwork-mac.png", "keepwork-attention.png"]) {
  const src = path.join(desktopAssets, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(iconsDir, name));
  }
}

const viteBin = path.join(appRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
execFileSync(viteBin, ["build"], {
  cwd: appRoot,
  stdio: "inherit",
});

// Ensure static copies of pet.html / updates.html / icons are present in dist
for (const name of ["keepwork.png", "keepwork-mac.png", "keepwork-attention.png"]) {
  const src = path.join(iconsDir, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(distDir, name));
  }
}

console.log("[aichat-rust] Frontend build completed in", distDir);
