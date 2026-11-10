import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

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

// Ship the Keepwork MCP runtime with the app when a staged copy exists; the
// release scripts run the same step with --require, so a missing runtime still
// fails a release but never blocks development or checks.
try {
  require("./bundle-mcp-runtime.cjs").bundle({});
} catch (error) {
  console.warn(`[aichat-rust] Bundled MCP runtime skipped: ${error instanceof Error ? error.message : String(error)}`);
}

// Node 22 refuses to spawn .cmd shims without a shell (EINVAL). Vite's package
// exports hide bin/vite.js, so resolve the package root and run that file.
const vitePkg = path.dirname(require.resolve("vite", { paths: [appRoot] }));
const viteEntry = path.join(vitePkg, "bin", "vite.js");
execFileSync(process.execPath, [viteEntry, "build"], {
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
