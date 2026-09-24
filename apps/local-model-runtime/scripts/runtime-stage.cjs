#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tar = require('tar');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const supported = new Set(['win32-x64', 'darwin-arm64', 'darwin-x64']);
const defaultTargets = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
];
const npmCli = process.env.npm_execpath;

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
  if (archiveFile.endsWith('.zip')) {
    const result = spawnSync('tar', ['-xf', archiveFile, '-C', extractDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`system tar failed to extract ${archiveFile}`);
  } else {
    await tar.x({ file: archiveFile, cwd: extractDir, gzip: true, strict: true });
  }
}

function copyRecursive(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyRecursive(path.join(source, name), path.join(target, name));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function npmCi(appDir, target) {
  if (!npmCli || !fs.statSync(npmCli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`npm CLI entry is unavailable: ${npmCli || '(empty)'}`);
  }
  const args = [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--os=${target.platform}`, `--cpu=${target.arch}`];
  const result = spawnSync(process.execPath, args, {
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
  if (result.error) throw new Error(`npm ci --omit=dev failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ci --omit=dev failed with exit code ${result.status}`);
}

async function stageRuntime(nodeVersion, target) {
  const archiveName = target.isWindows
    ? `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}.zip`
    : `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}.tar.gz`;
  const nodeFolderName = archiveName.replace(/\.(?:zip|tar\.gz)$/, '');
  const cacheDir = path.join(projectRoot, '.cache');
  const archiveFile = await ensureNodeArchive(nodeVersion, archiveName, cacheDir);
  const extractDir = path.join(cacheDir, `node-v${nodeVersion}-${target.nodePlatform}-${target.arch}`);
  await extractNodeArchive(archiveFile, extractDir);

  const nestedNodeRoot = path.join(extractDir, nodeFolderName);
  const nodeRoot = fs.existsSync(path.join(nestedNodeRoot, target.isWindows ? 'node.exe' : 'bin/node'))
    ? nestedNodeRoot
    : extractDir;
  const stageDir = path.join(projectRoot, 'runtime-staging', `${target.runtimePlatform}-${target.arch}`);
  const stageApp = path.join(stageDir, 'app');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageApp, { recursive: true });

  const sourceNode = path.join(nodeRoot, target.isWindows ? 'node.exe' : 'bin/node');
  const targetNode = path.join(stageDir, target.isWindows ? 'node.exe' : 'bin/node');
  fs.mkdirSync(path.dirname(targetNode), { recursive: true });
  fs.copyFileSync(sourceNode, targetNode);
  fs.copyFileSync(path.join(nodeRoot, 'LICENSE'), path.join(stageDir, 'LICENSE-node.txt'));
  if (!target.isWindows) fs.chmodSync(targetNode, 0o755);

  for (const name of ['package.json', 'package-lock.json']) copyRecursive(path.join(projectRoot, name), path.join(stageApp, name));
  npmCi(stageApp, target);
  for (const name of ['dist', 'configs', 'schemas', 'keys', 'models']) {
    copyRecursive(path.join(projectRoot, name), path.join(stageApp, name));
  }
  copyRecursive(path.join(projectRoot, 'tests', 'fixtures'), path.join(stageApp, 'tests', 'fixtures'));

  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    type: packageJson.type,
    dependencies: packageJson.dependencies,
    bin: packageJson.bin,
    engines: packageJson.engines,
  };
  fs.writeFileSync(path.join(stageApp, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  fs.rmSync(path.join(stageApp, 'package-lock.json'), { force: true });
  fs.rmSync(path.join(stageApp, 'node_modules', '.package-lock.json'), { force: true });

  fs.writeFileSync(path.join(stageDir, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'local-model',
    name: 'Keepwork Local Model',
    product: 'keepwork-local-model-node-runtime',
    version: packageJson.version,
    nodeVersion,
    platform: target.runtimePlatform,
    arch: target.arch,
    entry: 'app/dist/src/cli.js',
    args: ['serve', '--port', '18089'],
    env: {
      LOCAL_MODEL_ROOT: 'app',
    },
    health: {
      url: 'http://127.0.0.1:18089/v1/health',
      match: {
        service: 'keepwork-local-model',
      },
      timeoutMs: 10000,
    },
    logFile: 'local-model.log',
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
