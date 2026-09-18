#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const extractZip = require('extract-zip');
const tar = require('tar');

const runtimeRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(runtimeRoot, 'package.json'));
const supported = new Set(['win32-x64', 'darwin-arm64', 'darwin-x64']);
const defaultTargets = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
];
const hostNpm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key || '(end)'}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function normalizeNodeVersion(value) {
  const version = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid Node.js version: ${version || '(empty)'}`);
  return version;
}

function resolveTarget(args) {
  const platform = normalizePlatform(args.platform || process.platform);
  const arch = normalizeArch(args.arch || process.arch);
  const key = `${platform}-${arch}`;
  if (!supported.has(key)) throw new Error(`unsupported runtime target: ${key}`);
  return {
    platform,
    arch,
    isWindows: platform === 'win32',
    runtimePlatform: platform === 'win32' ? 'windows' : 'macos',
    nodePlatform: platform === 'win32' ? 'win' : 'darwin',
  };
}

function resolveTargets(args) {
  if (args.platform || args.arch) return [resolveTarget(args)];
  return defaultTargets.map(resolveTarget);
}

function normalizePlatform(value) {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin' || value === 'macos') return 'darwin';
  throw new Error(`unsupported target platform: ${value}`);
}

function normalizeArch(value) {
  if (value === 'x64' || value === 'arm64') return value;
  throw new Error(`unsupported target arch: ${value}`);
}

async function download(url, output) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: ${url}: HTTP ${response.status}`);
  fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function ensureNodeArchive(nodeVersion, archiveName, cacheDir) {
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const sumsFile = path.join(cacheDir, `SHASUMS256-v${nodeVersion}.txt`);
  const archiveFile = path.join(cacheDir, archiveName);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(sumsFile)) await download(`${baseUrl}/SHASUMS256.txt`, sumsFile);
  const line = fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).find((entry) => entry.endsWith(`  ${archiveName}`));
  if (!line) throw new Error(`Node.js checksum not found for ${archiveName}`);
  const expected = line.slice(0, 64);
  if (!fs.existsSync(archiveFile) || sha256(archiveFile) !== expected) {
    fs.rmSync(archiveFile, { force: true });
    await download(`${baseUrl}/${archiveName}`, archiveFile);
  }
  const actual = sha256(archiveFile);
  if (actual !== expected) throw new Error(`Node.js checksum mismatch for ${archiveName}: ${actual}`);
  return archiveFile;
}

async function extractNodeArchive(archiveFile, extractDir) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  if (archiveFile.endsWith('.zip')) await extractZip(archiveFile, { dir: extractDir });
  else await tar.x({ file: archiveFile, cwd: extractDir, gzip: true, strict: true });
}

function npmCi(appDir, target) {
  const result = spawnSync(hostNpm, ['ci', '--omit=dev', '--no-audit', '--no-fund', `--os=${target.platform}`, `--cpu=${target.arch}`], {
    cwd: appDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_os: target.platform,
      npm_config_cpu: target.arch,
      npm_config_platform: target.platform,
      npm_config_arch: target.arch,
    },
  });
  if (result.status !== 0) throw new Error(`npm ci --omit=dev failed with exit code ${result.status}`);
}

async function stageRuntime(nodeVersion, target) {
  const archiveName = target.isWindows
    ? `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}.zip`
    : `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}.tar.gz`;
  const nodeFolderName = archiveName.replace(/\.(?:zip|tar\.gz)$/, '');
  const cacheDir = path.join(runtimeRoot, '.cache');
  const archiveFile = await ensureNodeArchive(nodeVersion, archiveName, cacheDir);
  const extractDir = path.join(cacheDir, `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}`);
  await extractNodeArchive(archiveFile, extractDir);

  const nestedNodeRoot = path.join(extractDir, nodeFolderName);
  const nodeRoot = fs.existsSync(path.join(nestedNodeRoot, target.isWindows ? 'node.exe' : 'bin/node'))
    ? nestedNodeRoot
    : extractDir;
  const stageDir = path.join(runtimeRoot, 'staging', `${target.runtimePlatform}-${target.arch}`);
  const stageApp = path.join(stageDir, 'app');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageApp, { recursive: true });

  const sourceNode = path.join(nodeRoot, target.isWindows ? 'node.exe' : 'bin/node');
  const targetNode = path.join(stageDir, target.isWindows ? 'node.exe' : 'bin/node');
  fs.mkdirSync(path.dirname(targetNode), { recursive: true });
  fs.copyFileSync(sourceNode, targetNode);
  fs.copyFileSync(path.join(nodeRoot, 'LICENSE'), path.join(stageDir, 'LICENSE-node.txt'));
  if (!target.isWindows) fs.chmodSync(targetNode, 0o755);

  fs.copyFileSync(path.join(runtimeRoot, 'package.json'), path.join(stageApp, 'package.json'));
  fs.copyFileSync(path.join(runtimeRoot, 'package-lock.json'), path.join(stageApp, 'package-lock.json'));
  npmCi(stageApp, target);
  fs.copyFileSync(path.join(runtimeRoot, 'dist/cli.cjs'), path.join(stageApp, 'cli.cjs'));

  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    dependencies: packageJson.dependencies,
  };
  fs.writeFileSync(path.join(stageApp, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  fs.rmSync(path.join(stageApp, 'package-lock.json'), { force: true });
  fs.rmSync(path.join(stageApp, 'node_modules', '.package-lock.json'), { force: true });

  if (target.platform === 'darwin') {
    const helper = path.join(stageApp, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper');
    fs.chmodSync(helper, 0o755);
  }
  fs.writeFileSync(path.join(stageDir, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: 'keepwork-mcp-node-runtime',
    version: packageJson.version,
    nodeVersion,
    platform: target.runtimePlatform,
    arch: target.arch,
    entry: 'app/cli.cjs',
    args: ['--port', '8089'],
    env: {
      KEEPWORK_MCP_HOST_KIND: 'electron-node-runtime',
    },
    health: {
      url: 'http://127.0.0.1:8089/health',
      match: {
        name: 'keepwork-mcp',
      },
      timeoutMs: 10000,
    },
    logFile: 'keepwork-mcp.log',
  }, null, 2)}\n`);
  process.stdout.write(`${stageDir}\n`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const nodeVersion = normalizeNodeVersion(args['node-version'] || process.env.KP_RUNTIME_NODE_VERSION || '22.23.2');
  const targets = resolveTargets(args);
  for (const target of targets) await stageRuntime(nodeVersion, target);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
