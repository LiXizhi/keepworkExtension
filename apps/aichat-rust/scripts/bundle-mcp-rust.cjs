#!/usr/bin/env node
/**
 * Bundles the Rust Keepwork MCP daemon into the Tauri app resources.
 *
 * Source: apps/mcp-rust build output for the requested Rust target(s).
 * Output: src-tauri/resources/mcp-runtime/<arch>/{runtime.json,bin/keepwork-mcp}
 *
 * Manifest v2 (see docs/rust-runtime-migration.md) keeps the v1 Node feed
 * untouched; hosts accept either product while the migration runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
const rustRoot = path.join(repoRoot, 'apps', 'mcp-rust');
const resourcesRoot = path.join(appRoot, 'src-tauri', 'resources', 'mcp-runtime');
const PRODUCT = 'keepwork-mcp-runtime';
const KEEP_FILE = '.keep';
const binName = (platform) => (platform === 'windows' ? 'keepwork-mcp.exe' : 'keepwork-mcp');

const TARGETS = {
  'aarch64-apple-darwin': [{ arch: 'arm64', platform: 'macos', triple: 'aarch64-apple-darwin' }],
  'x86_64-apple-darwin': [{ arch: 'x64', platform: 'macos', triple: 'x86_64-apple-darwin' }],
  'universal-apple-darwin': [
    { arch: 'arm64', platform: 'macos', triple: 'aarch64-apple-darwin' },
    { arch: 'x64', platform: 'macos', triple: 'x86_64-apple-darwin' },
  ],
  'x86_64-pc-windows-msvc': [{ arch: 'x64', platform: 'windows', triple: 'x86_64-pc-windows-msvc' }],
};

function hostTriple() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return 'x86_64-pc-windows-msvc';
}

function crateVersion() {
  const manifest = fs.readFileSync(path.join(rustRoot, 'crates', 'keepwork-mcp', 'Cargo.toml'), 'utf8');
  const match = /^version\s*=\s*"([^"]+)"/m.exec(manifest);
  if (!match) throw new Error('cannot read crates/keepwork-mcp/Cargo.toml version');
  return match[1];
}

function commit() {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {
    /* fall through */
  }
  throw new Error('cannot read the source commit for runtime.json');
}

function buildTarget(arch) {
  const manifestPath = path.join(rustRoot, 'Cargo.toml');
  process.stdout.write(`[bundle-mcp-rust] Building keepwork-mcp (${arch.triple})...\n`);
  execFileSync('cargo', ['build', '--release', '--manifest-path', manifestPath, '--target', arch.triple], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function binaryFor(arch, shouldBuild = true) {
  if (shouldBuild) {
    buildTarget(arch);
  }
  const name = binName(arch.platform);
  const candidates = [
    path.join(rustRoot, 'target', arch.triple, 'release', name),
    path.join(rustRoot, 'target', 'release', name),
  ];
  // Several release profiles can exist side by side; package the newest so a
  // stale per-target build can never ship over a fresh daemon.
  const found = candidates
    .filter((candidate) => fs.existsSync(candidate))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!found) {
    throw new Error(
      `missing Rust daemon binary for ${arch.arch} (looked in ${candidates.join(', ')}).\n` +
        `Build it with: cargo build --release --manifest-path apps/mcp-rust/Cargo.toml --target ${arch.triple}`,
    );
  }
  return found;
}

function pruneOtherArches(keep) {
  if (!fs.existsSync(resourcesRoot)) return;
  for (const entry of fs.readdirSync(resourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    const dir = path.join(resourcesRoot, entry.name);
    for (const child of fs.readdirSync(dir)) fs.rmSync(path.join(dir, child), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-rust.cjs.\n');
  }
}

function writeRuntime(arch, shouldBuild = true) {
  const source = binaryFor(arch, shouldBuild);
  const destination = path.join(resourcesRoot, arch.arch);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
  const binary = path.join(destination, 'bin', binName(arch.platform));
  fs.copyFileSync(source, binary);
  fs.chmodSync(binary, 0o755);
  const manifest = {
    schemaVersion: 2,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: PRODUCT,
    engine: 'rust',
    version: crateVersion(),
    commit: commit(),
    platform: arch.platform,
    arch: arch.arch,
    entry: `bin/${binName(arch.platform)}`,
    args: ['--port', '8089'],
    env: {},
    health: { url: 'http://127.0.0.1:8089/health', match: { name: 'keepwork-mcp' }, timeoutMs: 10000 },
  };
  fs.writeFileSync(path.join(destination, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(destination, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-rust.cjs.\n');
  return { ...manifest, target: arch.triple, bytes: fs.statSync(binary).size };
}

function main() {
  const args = process.argv.slice(2);
  const shouldBuild = !args.includes('--no-build');
  const targetIndex = args.indexOf('--target');
  const triple = targetIndex >= 0 ? args[targetIndex + 1] : process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
  const runtimes = TARGETS[triple];
  if (!runtimes) throw new Error(`no bundled Rust runtime mapping for target ${triple}`);
  fs.mkdirSync(resourcesRoot, { recursive: true });
  pruneOtherArches(runtimes.map((runtime) => runtime.arch));
  const results = runtimes.map((runtime) => writeRuntime(runtime, shouldBuild));
  for (const result of results) {
    process.stdout.write(
      `[bundle-mcp-rust] ${result.arch}: Rust daemon ${result.version} (${result.commit.slice(0, 10)}), ${(result.bytes / 1024).toFixed(0)} KB\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[bundle-mcp-rust] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
