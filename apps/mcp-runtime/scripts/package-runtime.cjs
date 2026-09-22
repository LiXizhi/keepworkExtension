#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const { PRODUCT, releaseIdentity, archiveName, writeJson } = require('./release.cjs');

function packageRuntime(stageDir, releaseDir, identity, prefix = 'keepwork/mcp-runtime/', domain = 'https://cdn.keepwork.com') {
  releaseIdentity(identity.version, identity.commit);
  const runtime = JSON.parse(fs.readFileSync(path.join(stageDir, 'runtime.json'), 'utf8'));
  const { platform, arch, nodeVersion } = runtime;
  const fileName = archiveName(platform, arch);
  if (runtime.product !== PRODUCT || runtime.version !== identity.version || runtime.entry !== 'app/cli.cjs') {
    throw new Error('Staged runtime does not match release');
  }
  qiniu.normalizeVersion(nodeVersion);
  for (const file of [platform === 'windows' ? 'node.exe' : 'bin/node', 'LICENSE-node.txt', 'app/cli.cjs', 'app/package.json']) {
    if (!fs.statSync(path.join(stageDir, file)).isFile()) throw new Error(`Missing runtime file: ${file}`);
  }
  for (const dependency of ['node-pty', 'playwright-core']) {
    if (!fs.statSync(path.join(stageDir, 'app/node_modules', dependency)).isDirectory()) {
      throw new Error(`Missing runtime dependency: ${dependency}`);
    }
  }
  fs.mkdirSync(releaseDir, { recursive: true });
  const output = path.join(releaseDir, fileName);
  fs.rmSync(output, { force: true });
  if (platform === 'windows') {
    // .NET includes hidden files, unlike Compress-Archive. Paths stay in environment
    // variables so neither spaces nor PowerShell syntax in a path become code.
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KP_ARCHIVE_SOURCE, $env:KP_ARCHIVE_OUTPUT)"], {
      env: { ...process.env, KP_ARCHIVE_SOURCE: stageDir, KP_ARCHIVE_OUTPUT: output }, stdio: 'inherit',
    });
  } else {
    execFileSync('zip', ['-q', '-r', '-y', output, '.'], { cwd: stageDir, stdio: 'inherit' });
  }
  const metadata = {
    schemaVersion: 1, product: PRODUCT, ...identity, nodeVersion, platform, arch,
    builtAt: new Date().toISOString(),
    url: `${qiniu.normalizeHttpsUrl(domain, 'domain')}/${qiniu.normalizePrefix(prefix)}${fileName}`,
    fileName, size: fs.statSync(output).size, sha256: qiniu.sha256(output),
  };
  writeJson(path.join(releaseDir, `${platform}-${arch}.json`), metadata);
  return output;
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const runtimeRoot = path.resolve(__dirname, '..');
  const version = require(path.join(runtimeRoot, 'package.json')).version;
  const identity = releaseIdentity(version, args.commit);
  const target = `${process.platform === 'win32' ? 'windows' : 'macos'}-${process.arch}`;
  const releaseDir = path.join(runtimeRoot, 'release');
  const archive = packageRuntime(path.join(runtimeRoot, 'staging', target), releaseDir, identity, args.prefix, args.domain);
  // Smoke the actual extracted deliverable, including native PTY files and modes.
  const extracted = fs.mkdtempSync(path.join(releaseDir, 'verify-'));
  try {
    await require('extract-zip')(archive, { dir: extracted });
    execFileSync(process.execPath, [path.join(__dirname, 'smoke-runtime.cjs'), extracted], { stdio: 'inherit' });
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  process.stdout.write(`${archive}\n`);
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { packageRuntime };
