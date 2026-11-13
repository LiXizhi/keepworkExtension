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

const buildBins = process.platform === "darwin" ? [...smokeBins, "startup-smoke"] : smokeBins;
// Build one cohort first. Repeated `cargo run` can pick up different source
// edits and wait for unrelated builds between each domain suite.
process.stdout.write("[smoke] Building all smoke binaries...\n");
const artifacts = execFileSync("cargo", [
  "build", "--offline", "--manifest-path", manifestPath, "--features", "dev-bins",
  "--message-format=json-render-diagnostics",
  ...buildBins.flatMap(bin => ["--bin", bin]),
], { cwd: appRoot, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024, timeout: 600000, killSignal: "SIGKILL" });
const executables = new Map();
for (const line of artifacts.split(/\r?\n/).filter(Boolean)) {
  const event = JSON.parse(line);
  if (event.reason === "compiler-artifact" && event.target?.kind?.includes("bin") && event.executable) {
    executables.set(event.target.name, event.executable);
  }
}
for (const bin of buildBins) assert.ok(executables.has(bin), `Cargo did not produce ${bin}`);

for (const bin of smokeBins) {
  process.stdout.write(`[smoke] Running ${bin}...\n`);
  const out = execFileSync(
    executables.get(bin),
    [],
    {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 90000,
      killSignal: "SIGKILL",
    }
  );
  assert.match(out, new RegExp(`${bin}: OK`), `${bin} did not report OK`);
  process.stdout.write(out);
}

process.stdout.write("[smoke] All 5 Rust smoke suites passed.\n");

// This is a real OS-window/WebView smoke, separate from the five domain suites.
// The runner reports an explicit platform skip and bounds native execution to 90s.
const nativeArgs = [path.join(__dirname, 'startup-native-smoke.cjs'), '--no-build'];
if (process.platform === "darwin") nativeArgs.push(`--executable=${executables.get("startup-smoke")}`);
execFileSync(process.execPath, nativeArgs, {
  cwd: appRoot, stdio: 'inherit', timeout: 100000, killSignal: 'SIGKILL',
});
