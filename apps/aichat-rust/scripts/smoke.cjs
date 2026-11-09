const { execFileSync } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const appRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(appRoot, "src-tauri", "Cargo.toml");

const smokeBins = [
  "desktop-smoke",
  "runtime-smoke",
  "pty-smoke",
  "pet-smoke",
  "updates-smoke",
];

for (const bin of smokeBins) {
  process.stdout.write(`[smoke] Running ${bin}...\n`);
  const out = execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      manifestPath,
      "--features",
      "dev-bins",
      "--bin",
      bin,
      "--offline",
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
    }
  );
  assert.match(out, new RegExp(`${bin}: OK`), `${bin} did not report OK`);
  process.stdout.write(out);
}

process.stdout.write("[smoke] All 5 Rust smoke suites passed.\n");
