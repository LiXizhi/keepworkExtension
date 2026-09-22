#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');

const PRODUCT = 'keepwork-mcp-node-runtime';
const TARGETS = ['windows-x64', 'macos-arm64', 'macos-x64'];

function releaseIdentity(version, commit) {
  qiniu.normalizeVersion(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('commit must be a full Git SHA');
  return { version, commit };
}

function archiveName(platform, arch) {
  if (!TARGETS.includes(`${platform}-${arch}`)) throw new Error('Unsupported runtime target');
  return `${platform}-${arch}.zip`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function collectRelease(releaseDir, identity, prefix, domain) {
  releaseIdentity(identity.version, identity.commit);
  const normalizedPrefix = qiniu.normalizePrefix(prefix);
  const baseUrl = `${qiniu.normalizeHttpsUrl(domain, 'domain')}/${normalizedPrefix.replace(/\/$/, '')}`;
  let nodeVersion;
  const packages = TARGETS.map((target) => {
    const [platform, arch] = target.split('-');
    const fileName = archiveName(platform, arch);
    const metadataPath = path.join(releaseDir, `${target}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata.schemaVersion !== 1 || metadata.product !== PRODUCT
      || metadata.platform !== platform || metadata.arch !== arch || metadata.fileName !== fileName
      || metadata.url !== `${baseUrl}/${fileName}`
      || Object.keys(identity).some((key) => metadata[key] !== identity[key])) {
      throw new Error(`Release metadata mismatch: ${target}`);
    }
    if (typeof metadata.builtAt !== 'string' || !Number.isFinite(Date.parse(metadata.builtAt))
      || new Date(metadata.builtAt).toISOString() !== metadata.builtAt) {
      throw new Error(`Invalid build timestamp: ${target}`);
    }
    qiniu.normalizeVersion(metadata.nodeVersion);
    if (nodeVersion && metadata.nodeVersion !== nodeVersion) throw new Error('Mixed Node.js versions in release');
    nodeVersion = metadata.nodeVersion;
    const filePath = path.join(releaseDir, fileName);
    const size = fs.statSync(filePath).size;
    const sha256 = qiniu.sha256(filePath);
    if (size <= 0 || metadata.size !== size || metadata.sha256 !== sha256) {
      throw new Error(`Size or SHA-256 mismatch: ${target}`);
    }
    return {
      metadata,
      archive: {
        name: fileName, filePath, size, sha256,
        remoteKey: `${normalizedPrefix}${fileName}`, url: `${baseUrl}/${fileName}`,
      },
      descriptor: {
        name: `${target}.json`, filePath: metadataPath,
        size: fs.statSync(metadataPath).size, sha256: qiniu.sha256(metadataPath),
        remoteKey: `${normalizedPrefix}${target}.json`, url: `${baseUrl}/${target}.json`,
      },
    };
  });
  return {
    archives: packages.map((item) => item.archive),
    descriptors: packages.map((item) => item.descriptor),
    metadata: packages.map((item) => item.metadata),
  };
}

const cdnTransport = {
  ...qiniu,
  // Check the exact public URLs after refresh, not cache-busting query variants.
  verifyEntriesWithRetry: (entries) => qiniu.verifyEntriesWithRetry(entries, 20, 30_000, false),
};

// Fixed URLs are not an atomic multi-file update. Finish an accepted publication
// even if main advances during upload, so JSON is not deliberately left stale.
async function publishRelease(config, release, isCurrent, transport = cdnTransport) {
  if (!await isCurrent()) return false;
  for (const entry of release.archives) await transport.uploadEntry(config, entry);
  await transport.refreshUrls(config, release.archives.map((entry) => entry.url));
  await transport.verifyEntriesWithRetry(release.archives);
  for (const entry of release.descriptors) await transport.uploadEntry(config, entry);
  await transport.refreshUrls(config, release.descriptors.map((entry) => entry.url));
  await transport.verifyEntriesWithRetry(release.descriptors);
  return true;
}

function isMainHead(commit) {
  const result = execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], { encoding: 'utf8' });
  return result.trim().split(/\s+/)[0] === commit;
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const identity = releaseIdentity(args.version, args.commit);
  const release = collectRelease(path.resolve(qiniu.required(args['release-dir'], 'release-dir')), identity, args.prefix, args.domain);
  process.stdout.write(`${JSON.stringify(release.metadata, null, 2)}\n`);
  if (args.dryRun) return;
  const config = {
    accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: qiniu.required(args.bucket, 'bucket'),
    uploadHost: qiniu.normalizeHttpsUrl(args['upload-host'], 'upload-host'),
  };
  const published = await publishRelease(config, release, () => isMainHead(identity.commit));
  process.stdout.write(published ? 'NodeRuntime published and CDN verified.\n' : 'Superseded by a newer main commit; no CDN files were changed.\n');
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { PRODUCT, TARGETS, releaseIdentity, archiveName, collectRelease, publishRelease, writeJson };
