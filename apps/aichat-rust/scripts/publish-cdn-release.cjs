#!/usr/bin/env node
// Mirrors the exact CI installers to the public CDN under an immutable version path.
// It never rebuilds or repacks: the GitHub release remains the source of truth.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');

const {
  required, normalizeHttpsUrl, normalizePrefix, normalizeVersion, sha256, readArgs,
} = qiniu;
const appRoot = path.resolve(__dirname, '..');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectInstallers(releaseDir, version, prefix, domain) {
  normalizeVersion(version);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  if (packageVersion !== version) {
    throw new Error(`Version ${version} does not match apps/aichat-rust/package.json (${packageVersion})`);
  }
  const normalizedPrefix = normalizePrefix(prefix);
  const baseUrl = normalizeHttpsUrl(domain, 'domain');
  const names = fs.readdirSync(releaseDir);

  // Tauri names the universal DMG after the target architecture; accept whichever slice name it used.
  const dmgs = names.filter((name) => new RegExp(`^Keepwork_${escapeRegExp(version)}_.+\\.dmg$`).test(name));
  if (dmgs.length !== 1) throw new Error(`Expected exactly one macOS DMG in ${releaseDir}, found ${dmgs.length}`);

  const targets = [
    { platform: 'windows', arch: 'x64', name: `Keepwork_${version}_x64-setup.exe` },
    { platform: 'windows', arch: 'arm64', name: `Keepwork_${version}_arm64-setup.exe` },
    { platform: 'macos', arch: 'universal', name: dmgs[0] },
  ];

  return targets.map(({ platform, arch, name }) => {
    const filePath = path.join(releaseDir, name);
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size <= 0) throw new Error(`Installer is missing or empty: ${name}`);
    const remoteKey = `${normalizedPrefix}${version}/${name}`;
    return {
      platform, arch, name, filePath, remoteKey, url: `${baseUrl}/${remoteKey}`, size: stat.size, sha256: sha256(filePath),
    };
  });
}

async function uploadMissing(config, entries) {
  const pending = [];
  for (const entry of entries) {
    const response = await fetch(entry.url, { cache: 'no-store' });
    if (response.status === 404) {
      pending.push(entry);
      continue;
    }
    if (!response.ok) throw new Error(`CDN preflight failed for ${entry.url}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      throw new Error(`Immutable CDN object already differs: ${entry.remoteKey}; publish a new version instead of replacing it`);
    }
    process.stdout.write(`Already published: ${entry.remoteKey}\n`);
  }
  for (const entry of pending) {
    process.stdout.write(`Uploading ${entry.name} -> ${entry.remoteKey}\n`);
    await qiniu.uploadEntry(config, entry);
  }
  return pending;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const version = normalizeVersion(args.version);
  const releaseDir = path.resolve(required(args['release-dir'], 'release-dir'));
  const entries = collectInstallers(releaseDir, version, required(args.prefix, 'prefix'), required(args.domain, 'domain'));
  process.stdout.write(`${JSON.stringify({
    version,
    files: entries.map(({ filePath, ...entry }) => entry),
  }, null, 2)}\n`);
  if (args.dryRun) return;

  const config = {
    accessKey: required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: required(args.bucket, 'bucket'),
    uploadHost: normalizeHttpsUrl(required(args['upload-host'], 'upload-host'), 'upload-host'),
  };

  const uploaded = await uploadMissing(config, entries);
  if (uploaded.length) await qiniu.refreshUrls(config, uploaded.map((entry) => entry.url));
  await qiniu.verifyEntriesWithRetry(entries);
  process.stdout.write(`CDN copy verified for ${version}:\n${entries.map((entry) => entry.url).join('\n')}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { collectInstallers };
