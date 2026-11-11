#!/usr/bin/env node
/**
 * Bundles the Keepwork MCP runtime into the Tauri app resources, so the
 * installed desktop app ships its own MCP server the same way
 * `apps/aichat-desktop` bundles `apps/mcp-runtime` through electron-builder.
 *
 * Input:  apps/mcp-runtime/staging/<platform>-<arch>  (npm run stage --prefix apps/mcp-runtime ...)
 *         or AICHAT_MCP_RUNTIME_DIR / AICHAT_MCP_RUNTIME_ROOT for other checkouts.
 * Output: apps/aichat-rust/src-tauri/resources/mcp-runtime/<arch>/
 *
 * Later stages resolve resources/mcp-runtime/<arch> relative to the app
 * resource directory (see resolve_bundled_mcp_dir in src-tauri/src/lib.rs).
 * Optional mode (plain `pnpm build`) skips a missing runtime; `--require`
 * (release builds) fails instead, mirroring the desktop release check.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
const defaultRoot = path.join(repoRoot, 'apps', 'mcp-runtime', 'staging');
const resourcesRoot = path.join(appRoot, 'src-tauri', 'resources', 'mcp-runtime');
const PRODUCT = 'keepwork-mcp-node-runtime';
const KEEP_FILE = '.keep';

// Same source set the desktop release guard uses to reject a stale runtime.
const SOURCE_PATHS = [
  'src/core',
  'src/mcp',
  'apps/mcp-runtime/src',
  'apps/mcp-runtime/package.json',
  'apps/mcp-runtime/package-lock.json',
  'apps/mcp-runtime/tsconfig.json',
  'apps/mcp-runtime/scripts/build.mjs',
  'apps/mcp-runtime/scripts/stage-runtime.cjs',
  'scripts/creation-skill-build.mjs',
  'skills/paracraft-create',
  'skills/agent-cli-verify',
];

const TARGETS = {
  'aarch64-apple-darwin': [{ arch: 'arm64', platform: 'macos', stage: 'macos-arm64' }],
  'x86_64-apple-darwin': [{ arch: 'x64', platform: 'macos', stage: 'macos-x64' }],
  'universal-apple-darwin': [
    { arch: 'arm64', platform: 'macos', stage: 'macos-arm64' },
    { arch: 'x64', platform: 'macos', stage: 'macos-x64' },
  ],
  'x86_64-pc-windows-msvc': [{ arch: 'x64', platform: 'windows', stage: 'windows-x64' }],
  // apps/mcp-runtime never stages a win-arm64 slice, so that installer keeps
  // downloading its runtime from the published feed.
  'aarch64-pc-windows-msvc': [],
};

function hostTriple() {
  const platform = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu';
  return `${process.arch === 'x64' ? 'x86_64' : process.arch}-${platform}`;
}

/** Runtimes to bundle for one build target (universal macOS carries both slices). */
function resolveTargets(target) {
  const triple = target || process.env.AICHAT_RUST_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
  const runtimes = TARGETS[triple];
  if (!runtimes) throw new Error(`No bundled MCP runtime mapping for target ${triple}. Supported: ${Object.keys(TARGETS).join(', ')}`);
  return { triple, runtimes };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function hasRuntimeSourceChanges(commit) {
  const known = git(['cat-file', '-e', `${commit}^{commit}`]);
  if (known.status !== 0) return false; // shallow clone or foreign checkout: cannot compare
  const diff = git(['diff', '--quiet', commit, '--', ...SOURCE_PATHS]);
  if (diff.status === 1) return true;
  if (diff.status !== 0) throw new Error(`Unable to compare MCP runtime source with ${commit}`);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]);
  return Boolean(String(untracked.stdout || '').trim());
}

/** Returns the runtime manifest or throws with an actionable message. */
function validateRuntime(dir, expected) {
  const manifestPath = path.join(dir, 'runtime.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing runtime.json in ${dir}`);
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) throw new Error('Unsupported runtime manifest schema');
  if (manifest.engine !== undefined && manifest.engine !== 'node') throw new Error('Expected Node runtime engine');
  if (manifest.product !== PRODUCT) throw new Error(`Runtime product mismatch: expected ${PRODUCT}, got ${manifest.product}`);
  const runtimePlatform = expected.platform;
  if (manifest.platform !== runtimePlatform || manifest.arch !== expected.arch) {
    throw new Error(`Runtime target mismatch: got ${manifest.platform}-${manifest.arch}, expected ${runtimePlatform}-${expected.arch}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) throw new Error(`Invalid runtime version: ${manifest.version}`);
  const node = manifest.node || (expected.platform === 'windows' ? 'node.exe' : 'bin/node');
  const entry = manifest.entry || 'app/cli.cjs';
  for (const relative of [node, entry]) {
    const absolute = path.resolve(dir, relative);
    if (!absolute.startsWith(path.resolve(dir) + path.sep) || !fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Runtime file missing or outside its directory: ${relative}`);
    }
  }
  const commit = manifest.commit || readJson(path.join(dir, 'app', 'package.json')).commit;
  if (!/^[a-f0-9]{40}$/.test(String(commit || ''))) throw new Error('Runtime source commit is missing');
  return { ...manifest, schemaVersion: 1, engine: 'node', node, entry, commit };
}

function copyRuntime(source, destination, manifest) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  // Legacy staging kept the source commit only in app/package.json. Persist
  // the validated defaults too; Rust consumes runtime.json without that fallback.
  fs.writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Tauri needs the resource path to exist even when nothing was staged.
  fs.writeFileSync(path.join(destination, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-runtime.cjs.\n');
}

function sameRuntime(manifest, destination) {
  try {
    const b = readJson(path.join(destination, 'runtime.json'));
    return ['schemaVersion', 'product', 'version', 'commit', 'engine', 'node', 'entry', 'platform', 'arch', 'builtAt']
      .every(key => manifest[key] === b[key]);
  } catch {
    return false;
  }
}

/** Empties arch directories that this build will not bundle, so an app never ships a foreign slice. */
function pruneOtherArches(root, keep) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    const dir = path.join(root, entry.name);
    for (const child of fs.readdirSync(dir)) fs.rmSync(path.join(dir, child), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-runtime.cjs.\n');
  }
}

function bundle(options = {}) {
  const requireRuntime = Boolean(options.require);
  const { triple, runtimes } = resolveTargets(options.target);
  const root = path.resolve(options.root || process.env.AICHAT_MCP_RUNTIME_ROOT || defaultRoot);
  const outRoot = options.out ? path.resolve(options.out) : resourcesRoot;
  const single = process.env.AICHAT_MCP_RUNTIME_DIR ? path.resolve(process.env.AICHAT_MCP_RUNTIME_DIR) : '';
  if (single && runtimes.length > 1) {
    throw new Error('AICHAT_MCP_RUNTIME_DIR cannot serve a universal build; set AICHAT_MCP_RUNTIME_ROOT to a directory holding macos-arm64/ and macos-x64/.');
  }

  fs.mkdirSync(outRoot, { recursive: true });
  pruneOtherArches(outRoot, runtimes.map(runtime => runtime.arch));

  const bundled = [];
  for (const runtime of runtimes) {
    const source = single || path.join(root, runtime.stage);
    const destination = path.join(outRoot, runtime.arch);
    if (!fs.existsSync(path.join(source, 'runtime.json'))) {
      const hint = `npm run stage --prefix apps/mcp-runtime -- --platform ${runtime.platform === 'windows' ? 'win32' : 'darwin'} --arch ${runtime.arch}`;
      const message = `No staged Keepwork MCP runtime for ${runtime.platform}-${runtime.arch} (looked in ${source}). Build one with: ${hint}`;
      if (requireRuntime) throw new Error(message);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-runtime.cjs.\n');
      process.stderr.write(`[bundle-mcp-runtime] skipped: ${message}\n`);
      continue;
    }
    const manifest = validateRuntime(source, runtime);
    if (requireRuntime && manifest.entry !== 'app/cli.cjs') {
      // A hand-made developer runtime (dist/cli.cjs, symlinked node) must never
      // reach a release: only `npm run stage` produces a self-contained one.
      throw new Error(`${source} is not a staged runtime (entry ${manifest.entry}). Re-run: npm run stage --prefix apps/mcp-runtime -- --platform ${runtime.platform === 'windows' ? 'win32' : 'darwin'} --arch ${runtime.arch}`);
    }
    const changed = options.sourceChanged ? options.sourceChanged(manifest.commit) : hasRuntimeSourceChanges(manifest.commit);
    if (changed) {
      // A developer override is the tested runtime the caller chose; a staged
      // runtime must match the checkout it is packaged from.
      if (!single) {
        throw new Error(`Staged MCP runtime ${source} is stale (built from ${manifest.commit}; MCP runtime source has changed). Re-run: npm run stage --prefix apps/mcp-runtime -- --platform ${runtime.platform === 'windows' ? 'win32' : 'darwin'} --arch ${runtime.arch}`);
      }
      process.stderr.write(`[bundle-mcp-runtime] warning: AICHAT_MCP_RUNTIME_DIR is older than the MCP runtime source (${manifest.commit})\n`);
    }
    if (sameRuntime(manifest, destination)) {
      fs.writeFileSync(path.join(destination, KEEP_FILE), 'Keepwork MCP runtime is copied here by scripts/bundle-mcp-runtime.cjs.\n');
    } else {
      copyRuntime(source, destination, manifest);
    }
    bundled.push(`${runtime.arch} ${manifest.version} (${manifest.commit.slice(0, 10)})`);
  }

  if (requireRuntime && bundled.length !== runtimes.length) {
    throw new Error(`Incomplete bundled MCP runtime for ${triple}: bundled ${bundled.length}/${runtimes.length}`);
  }
  const summary = bundled.length ? `bundled ${bundled.join(', ')} for ${triple}` : `no runtime bundled for ${triple} (feed download at runtime)`;
  process.stdout.write(`[bundle-mcp-runtime] ${summary}\n`);
  return bundled;
}

function main() {
  const args = process.argv.slice(2);
  const options = { require: args.includes('--require') };
  const targetIndex = args.indexOf('--target');
  if (targetIndex >= 0) options.target = args[targetIndex + 1];
  const rootIndex = args.indexOf('--root');
  if (rootIndex >= 0) options.root = args[rootIndex + 1];
  bundle(options);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[bundle-mcp-runtime] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { TARGETS, PRODUCT, resourcesRoot, resolveTargets, validateRuntime, bundle };
