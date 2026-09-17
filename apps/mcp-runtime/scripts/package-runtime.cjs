#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const runtimeRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(runtimeRoot, 'package.json'));
const supported = new Set(['win32-x64', 'darwin-arm64', 'darwin-x64']);

function createArchive(sourceDir, output, format) {
  return new Promise((resolve, reject) => {
    const target = fs.createWriteStream(output);
    const archive = format === 'zip'
      ? new archiver.ZipArchive({ zlib: { level: 9 } })
      : new archiver.TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    target.once('close', resolve);
    target.once('error', reject);
    archive.once('warning', (error) => error.code === 'ENOENT' ? process.stderr.write(`${error.message}\n`) : reject(error));
    archive.once('error', reject);
    archive.pipe(target);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

async function main() {
  const host = `${process.platform}-${process.arch}`;
  if (!supported.has(host)) throw new Error(`unsupported runtime build host: ${host}`);
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const archiveFormat = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const outputName = `Keepwork-MCP-NodeRuntime-${packageJson.version}-${platform}-${process.arch}.${archiveFormat}`;
  const releaseDir = path.join(runtimeRoot, 'release');
  const sourceDir = path.join(runtimeRoot, 'staging', `${platform}-${process.arch}`);
  const output = path.join(releaseDir, outputName);
  if (!fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`staged runtime not found: ${sourceDir}`);
  }
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  await createArchive(sourceDir, output, process.platform === 'win32' ? 'zip' : 'tar');
  if (!fs.statSync(output).size) throw new Error(`runtime archive is empty: ${output}`);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
