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

function npmCi(appDir) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: appDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`npm ci --omit=dev failed with exit code ${result.status}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const nodeVersion = normalizeNodeVersion(args['node-version'] || process.env.KP_RUNTIME_NODE_VERSION || '22.23.2');
  const host = `${process.platform}-${process.arch}`;
  if (!supported.has(host)) throw new Error(`unsupported runtime build host: ${host}`);
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const nodePlatform = process.platform === 'win32' ? 'win' : 'darwin';
  const archiveName = process.platform === 'win32'
    ? `node-v${nodeVersion}-${nodePlatform}-${process.arch}.zip`
    : `node-v${nodeVersion}-${nodePlatform}-${process.arch}.tar.gz`;
  const nodeFolderName = archiveName.replace(/\.(?:zip|tar\.gz)$/, '');
  const cacheDir = path.join(runtimeRoot, '.cache');
  const archiveFile = await ensureNodeArchive(nodeVersion, archiveName, cacheDir);
  const extractDir = path.join(cacheDir, `node-v${nodeVersion}-${nodePlatform}-${process.arch}`);
  await extractNodeArchive(archiveFile, extractDir);

  const nestedNodeRoot = path.join(extractDir, nodeFolderName);
  const nodeRoot = fs.existsSync(path.join(nestedNodeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node'))
    ? nestedNodeRoot
    : extractDir;
  const stageDir = path.join(runtimeRoot, 'staging', `${platform}-${process.arch}`);
  const stageApp = path.join(stageDir, 'app');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageApp, { recursive: true });

  const sourceNode = path.join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const targetNode = path.join(stageDir, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  fs.mkdirSync(path.dirname(targetNode), { recursive: true });
  fs.copyFileSync(sourceNode, targetNode);
  fs.copyFileSync(path.join(nodeRoot, 'LICENSE'), path.join(stageDir, 'LICENSE-node.txt'));
  if (process.platform !== 'win32') fs.chmodSync(targetNode, 0o755);

  fs.copyFileSync(path.join(runtimeRoot, 'package.json'), path.join(stageApp, 'package.json'));
  fs.copyFileSync(path.join(runtimeRoot, 'package-lock.json'), path.join(stageApp, 'package-lock.json'));
  npmCi(stageApp);
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

  if (process.platform === 'darwin') {
    const helper = path.join(stageApp, 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
    fs.chmodSync(helper, 0o755);
  }
  fs.writeFileSync(path.join(stageDir, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: 'keepwork-mcp-node-runtime',
    version: packageJson.version,
    nodeVersion,
    platform,
    arch: process.arch,
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
