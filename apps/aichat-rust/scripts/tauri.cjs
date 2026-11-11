#!/usr/bin/env node
// Development starts with a complete Node MCP runtime even if an earlier Rust
// preview was bundled into resources. Release commands still go straight to Tauri.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validateRuntime } = require('./bundle-mcp-runtime.cjs');

const APP_ROOT = path.resolve(__dirname, '..');

function parseInvocation(argv, env = process.env) {
  const args = [...argv];
  const explicitRust = args[0] === '--mcp-rust';
  if (explicitRust) args.shift();
  const separator = args.indexOf('--');
  const cliArgs = separator < 0 ? args : args.slice(0, separator);
  const command = cliArgs.find(arg => arg !== '--verbose' && !/^-v+$/.test(arg));
  const informational = cliArgs.some(arg => ['--help', '-h', '--version', '-V'].includes(arg)) || command === 'help';
  return { args, development: command === 'dev' && !informational,
    engine: explicitRust || env.AICHAT_MCP_ENGINE === 'rust' ? 'rust' : 'node' };
}

function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`Unsupported development runtime host: ${platform}-${arch}`);
  }
  return { platform: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux', arch };
}

function validateNodeRuntime(directory) {
  const manifest = validateRuntime(directory, runtimeTarget());
  const root = fs.realpathSync(directory);
  for (const relative of [manifest.node, manifest.entry]) {
    if (!fs.realpathSync(path.join(root, relative)).startsWith(root + path.sep)) {
      throw new Error(`Development runtime file escapes its directory: ${relative}`);
    }
  }
  // Rust reads this file directly and cannot use the bundler's legacy defaults.
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
  if (!raw.commit || !raw.node || !raw.entry) {
    throw new Error('Development runtime manifest needs commit, node and entry. Re-stage the runtime or remove AICHAT_MCP_BUNDLED_DIR.');
  }
  return manifest;
}

function copyInstalledDependencies(runtimeRoot, destination) {
  const copied = new Map();
  const copyPackage = (name, from) => {
    const jsonPath = require.resolve(`${name}/package.json`, { paths: [from] });
    const source = path.dirname(jsonPath);
    const pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (copied.has(name)) {
      if (copied.get(name) !== pkg.version) throw new Error(`Conflicting runtime dependency versions for ${name}`);
      return;
    }
    copied.set(name, pkg.version);
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
    for (const dependency of Object.keys(pkg.dependencies || {})) copyPackage(dependency, source);
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies || {})) copyPackage(name, runtimeRoot);
}

function prepareNodeRuntime({ appRoot = APP_ROOT, env = process.env } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Desktop development requires Node.js 22 or later.');
  const runtimeRoot = path.resolve(appRoot, '../mcp-runtime');
  const repoRoot = path.resolve(appRoot, '../..');
  const target = runtimeTarget();
  const cache = path.join(appRoot, 'src-tauri', 'target', 'dev-mcp-runtime');
  fs.mkdirSync(cache, { recursive: true });
  // Each launch owns its output. Never rebuild a staged runtime or a generation
  // that a surviving daemon could still be reading after the desktop exits.
  const directory = fs.mkdtempSync(path.join(cache, 'node-'));
  try {
    const appDir = path.join(directory, 'app');
    execFileSync(process.execPath, [path.join(runtimeRoot, 'scripts/build.mjs'), '--development', '--outdir', appDir], {
      cwd: runtimeRoot, env, stdio: 'inherit',
    });
    const node = process.platform === 'win32' ? 'bin/node.exe' : 'bin/node';
    fs.mkdirSync(path.dirname(path.join(directory, node)), { recursive: true });
    // Reflinks save disk on supporting filesystems; ordinary copies are a safe fallback.
    fs.copyFileSync(process.execPath, path.join(directory, node), fs.constants.COPYFILE_FICLONE);
    if (process.platform !== 'win32') fs.chmodSync(path.join(directory, node), 0o755);
    copyInstalledDependencies(runtimeRoot, path.join(appDir, 'node_modules'));
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Cannot determine development runtime source commit');
    const builtAt = new Date().toISOString();
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, commit, builtAt, private: true }) + '\n');
    fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({
      schemaVersion: 1, product: 'keepwork-mcp-node-runtime', engine: 'node', ...target,
      version: pkg.version, commit, builtAt, node, entry: 'app/cli.cjs', args: ['--port', '8089'], env: {},
    }, null, 2) + '\n');
    validateNodeRuntime(directory);
    process.stdout.write(`[tauri-dev] Prepared Node MCP ${pkg.version} in ${directory}\n`);
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Cannot prepare the Node MCP development runtime: ${error.message}. Check the build output; if dependencies are missing, run npm ci --include=dev --prefix apps/mcp-runtime from the repository root.`, { cause: error });
  }
}

function prepareRustRuntime({ appRoot = APP_ROOT, env = process.env } = {}) {
  execFileSync(process.execPath, [path.join(appRoot, 'scripts/bundle-mcp-rust.cjs')], { cwd: appRoot, env, stdio: 'inherit' });
  return path.join(appRoot, 'src-tauri', 'resources', 'mcp-runtime', process.arch);
}

function runTauri(args, env, appRoot = APP_ROOT) {
  const pkgFile = require.resolve('@tauri-apps/cli/package.json', { paths: [appRoot] });
  const entry = path.resolve(path.dirname(pkgFile), JSON.parse(fs.readFileSync(pkgFile, 'utf8')).bin.tauri);
  // Launch the JS entry rather than a .cmd shim; no shell interpolation on Windows.
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: appRoot, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function launch(argv, options = {}) {
  const appRoot = options.appRoot || APP_ROOT;
  const env = { ...(options.env || process.env) };
  const invocation = parseInvocation(argv, env);
  if (invocation.development) {
    if (invocation.engine === 'rust') {
      process.stderr.write('[tauri-dev] Rust MCP preview: external CLI sessions are not implemented; use pnpm tauri dev for CLI connectors.\n');
    }
    const custom = env.AICHAT_MCP_BUNDLED_DIR || env.AICHAT_MCP_RUNTIME_DIR;
    if (custom) {
      const directory = path.resolve(appRoot, custom);
      if (invocation.engine === 'node') await (options.validateNodeRuntime || validateNodeRuntime)(directory);
      else {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
        if (manifest.engine !== 'rust') throw new Error('Rust preview override requires a Rust runtime manifest');
      }
      env.AICHAT_MCP_BUNDLED_DIR = directory;
    } else {
      const prepare = invocation.engine === 'rust' ? options.prepareRustRuntime || prepareRustRuntime : options.prepareNodeRuntime || prepareNodeRuntime;
      env.AICHAT_MCP_BUNDLED_DIR = await prepare({ appRoot, env });
    }
    env.AICHAT_MCP_ENGINE = invocation.engine;
  }
  return (options.runTauri || runTauri)(invocation.args, env, appRoot);
}

if (require.main === module) {
  launch(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`[tauri-dev] ${error.message || error}\n`); process.exitCode = 1;
  });
}
module.exports = { parseInvocation, runtimeTarget, validateNodeRuntime, prepareNodeRuntime, prepareRustRuntime, launch };
