#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const {
  required, normalizeHttpsUrl, normalizePrefix, normalizeVersion, sha256, readArgs,
  uploadEntry, refreshUrls, verifyEntriesWithRetry,
} = qiniu;

function collectReleaseFiles(releaseDir, version, prefix, domain) {
  const installerName = `KP-Local-Helper-Setup-${version}-x64.exe`;
  const names = [installerName, `${installerName}.blockmap`, 'latest.yml', 'latest.json'];
  const normalizedPrefix = normalizePrefix(prefix);
  const baseUrl = `${normalizeHttpsUrl(domain, 'domain')}/${normalizedPrefix.replace(/\/$/, '')}`;

  for (const name of names) {
    const filePath = path.join(releaseDir, name);
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Required release file is missing: ${filePath}`);
    }
  }

  const manifestPath = path.join(releaseDir, 'latest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const installerPath = path.join(releaseDir, installerName);
  if (manifest.schemaVersion !== 1
    || manifest.product !== 'kp-local-helper'
    || manifest.channel !== 'internal'
    || manifest.signed !== false
    || manifest.version !== version
    || manifest.fileName !== installerName) {
    throw new Error('latest.json does not match the requested version and installer');
  }
  if (!Array.isArray(manifest.capabilities)
    || manifest.capabilities.length !== 2
    || !manifest.capabilities.includes('mcp')
    || !manifest.capabilities.includes('local-model')
    || manifest.localModelProtocolVersion !== '1.0.0') {
    throw new Error('latest.json does not declare the bundled MCP and local-model capabilities');
  }
  if (manifest.url !== `${baseUrl}/${encodeURIComponent(installerName)}`) {
    throw new Error(`latest.json URL must use ${baseUrl}`);
  }
  if (manifest.size !== fs.statSync(installerPath).size || manifest.sha256 !== sha256(installerPath)) {
    throw new Error('latest.json size or SHA-256 does not match the installer');
  }

  const latestYml = fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8');
  if (!latestYml.includes(`version: ${version}`) || !latestYml.includes(installerName)) {
    throw new Error('latest.yml does not match the requested version and installer');
  }

  return names.map((name) => {
    const filePath = path.join(releaseDir, name);
    const size = fs.statSync(filePath).size;
    if (size <= 0) throw new Error(`Release file is empty: ${filePath}`);
    return {
      name,
      filePath,
      remoteKey: `${normalizedPrefix}${name}`,
      url: `${baseUrl}/${encodeURIComponent(name)}`,
      size,
      sha256: sha256(filePath),
    };
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const version = normalizeVersion(args.version);
  const releaseDir = path.resolve(required(args['release-dir'], 'release-dir'));
  const prefix = normalizePrefix(required(args.prefix, 'prefix'));
  const domain = normalizeHttpsUrl(required(args.domain, 'domain'), 'domain');
  const entries = collectReleaseFiles(releaseDir, version, prefix, domain);
  process.stdout.write(`${JSON.stringify({ version, prefix, files: entries.map(({ filePath, ...entry }) => entry) }, null, 2)}\n`);
  if (args.dryRun) return;

  const config = {
    accessKey: required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: required(args.bucket, 'bucket'),
    uploadHost: normalizeHttpsUrl(required(args['upload-host'], 'upload-host'), 'upload-host'),
  };

  const groups = [entries.slice(0, 2), [entries[2]], [entries[3]]];
  for (const group of groups) {
    for (const entry of group) {
      process.stdout.write(`Uploading ${entry.name} -> ${entry.remoteKey}\n`);
      await uploadEntry(config, entry);
    }
    await refreshUrls(config, group.map((entry) => entry.url));
    await verifyEntriesWithRetry(group);
  }
  process.stdout.write('Qiniu upload, refresh, and CDN verification completed.\n');
}

if (require.main === module) {
  main().catch((error) => {
    const messages = [];
    for (let current = error; current; current = current.cause) {
      const message = current instanceof Error ? current.message : String(current);
      if (!messages.includes(message)) messages.push(message);
    }
    process.stderr.write(`${messages.join(': ')}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ...qiniu, collectReleaseFiles };
