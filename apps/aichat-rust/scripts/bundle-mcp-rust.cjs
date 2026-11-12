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
const crypto = require('node:crypto');
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
  'aarch64-pc-windows-msvc': [{ arch: 'arm64', platform: 'windows', triple: 'aarch64-pc-windows-msvc' }],
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

function binaryFor(arch, shouldBuild = true, options = {}) {
  if (shouldBuild) {
    (options.buildTarget || buildTarget)(arch);
  }
  const name = binName(arch.platform);
  // A generic host build can have a newer mtime but the wrong architecture.
  // buildTarget always requests this triple, including each universal slice.
  const binary = path.join(options.rustRoot || rustRoot, 'target', arch.triple, 'release', name);
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    throw new Error(
      `missing Rust daemon binary for ${arch.arch} (looked in ${binary}).\n` +
        `Build it with: cargo build --release --manifest-path apps/mcp-rust/Cargo.toml --target ${arch.triple}`,
    );
  }
  return binary;
}

function sourceFingerprint(root = rustRoot) {
  const crate = path.join(root, 'crates/keepwork-mcp');
  const entries = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.rs')) {
        entries.push(['crate/' + path.relative(crate, file).split(path.sep).join('/'), file]);
      }
    }
  };
  walk(path.join(crate, 'src'));
  for (const name of ['Cargo.toml', 'build.rs']) entries.push(['crate/' + name, path.join(crate, name)]);
  for (const name of ['Cargo.toml', 'Cargo.lock']) entries.push(['workspace/' + name, path.join(root, name)]);
  const hash = crypto.createHash('sha256');
  for (const [name, file] of entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const content = fs.readFileSync(file);
    hash.update(name); hash.update(Buffer.from([0]));
    hash.update(String(content.length)); hash.update(Buffer.from([0])); hash.update(content);
  }
  return hash.digest('hex');
}

function readBuildInfo(binary) {
  const content = fs.readFileSync(binary);
  const start = content.indexOf(Buffer.from('{"marker":"keepwork-mcp-build-v1",'));
  const ending = Buffer.from('"endMarker":"keepwork-mcp-build-end"}');
  const end = start < 0 ? -1 : content.indexOf(ending, start);
  if (start < 0 || end < 0 || end - start > 16384) throw new Error('Rust binary has no valid embedded build identity');
  return JSON.parse(content.subarray(start, end + ending.length).toString('utf8'));
}

function validateBinary(binary, arch, expected) {
  try {
    const info = readBuildInfo(binary);
    if (info.product !== PRODUCT || info.engine !== 'rust' || info.target !== arch.triple) throw new Error('Rust binary product or target mismatch');
    for (const key of ['version', 'commit', 'sourceHash']) {
      if (info[key] !== expected[key]) throw new Error('Rust binary ' + key + ' is stale or mismatched');
    }
    for (const capability of ['agentSessionApi', 'agentInventoryApi', 'agentContextApi', 'agentModeApi']) {
      if (info.capabilities?.[capability] !== 'v1') throw new Error('Rust binary is missing capability ' + capability);
    }
    return info;
  } catch (error) {
    throw new Error(error.message + '. Rebuild with: cargo build --release --manifest-path apps/mcp-rust/Cargo.toml --target ' + arch.triple);
  }
}

function pruneOtherArches(keep, outputRoot = resourcesRoot) {
  if (!fs.existsSync(outputRoot)) return;
  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    const dir = path.join(outputRoot, entry.name);
    for (const child of fs.readdirSync(dir)) fs.rmSync(path.join(dir, child), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-rust.cjs.\n');
  }
}

function writeRuntime(arch, source, info, outputRoot = resourcesRoot) {
  const sourceDigest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const destination = path.join(outputRoot, arch.arch);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
  const binary = path.join(destination, 'bin', binName(arch.platform));
  fs.copyFileSync(source, binary);
  fs.chmodSync(binary, 0o755);
  if (crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== sourceDigest) throw new Error('Packaged Rust binary changed during copy');
  const manifest = {
    schemaVersion: 2,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: PRODUCT,
    engine: 'rust',
    version: info.version,
    commit: info.commit,
    sourceHash: info.sourceHash,
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
  const outIndex = args.indexOf('--outdir');
  if (outIndex >= 0 && !args[outIndex + 1]) throw new Error('--outdir requires a directory');
  const outputRoot = outIndex < 0 ? resourcesRoot : path.resolve(args[outIndex + 1]);
  // Validate every slice before changing any previously packaged resources.
  const candidates = runtimes.map(arch => ({ arch, binary: binaryFor(arch, shouldBuild) }));
  const expected = { version: crateVersion(), commit: commit(), sourceHash: sourceFingerprint() };
  for (const candidate of candidates) candidate.info = validateBinary(candidate.binary, candidate.arch, expected);
  fs.mkdirSync(outputRoot, { recursive: true });
  pruneOtherArches(runtimes.map((runtime) => runtime.arch), outputRoot);
  const results = candidates.map(({ arch, binary, info }) => writeRuntime(arch, binary, info, outputRoot));
  for (const result of results) {
    process.stdout.write(
      `[bundle-mcp-rust] ${result.arch}: Rust daemon ${result.version} (${result.commit.slice(0, 10)}), ${(result.bytes / 1024).toFixed(0)} KB\n`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[bundle-mcp-rust] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { binaryFor, sourceFingerprint, readBuildInfo, validateBinary };
