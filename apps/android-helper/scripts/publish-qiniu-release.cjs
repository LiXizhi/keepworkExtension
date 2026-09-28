#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');

function collect(releaseDir, version, prefix, domain) {
  const fileName = `KP-Local-Helper-Android-${version}-arm64-v8a.apk`;
  const normalizedPrefix = qiniu.normalizePrefix(prefix);
  const base = `${qiniu.normalizeHttpsUrl(domain, 'domain')}/${normalizedPrefix.replace(/\/$/, '')}`;
  const apkPath = path.join(releaseDir, fileName);
  const manifestPath = path.join(releaseDir, 'latest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.product !== 'kp-local-helper-android' || manifest.channel !== 'internal' || manifest.signed !== true ||
      manifest.version !== version || manifest.fileName !== fileName || manifest.url !== `${base}/${fileName}` ||
      manifest.size !== fs.statSync(apkPath).size || manifest.sha256 !== qiniu.sha256(apkPath)) {
    throw new Error('Android latest.json does not match the signed APK');
  }
  if (!manifest.capabilities?.includes('mcp') || !manifest.capabilities?.includes('local-model') || manifest.localModelProtocolVersion !== '1.0.0') {
    throw new Error('Android latest.json is missing unified service capabilities');
  }
  return [
    { name: fileName, filePath: apkPath, remoteKey: `${normalizedPrefix}${fileName}`, url: manifest.url },
    { name: 'latest.json', filePath: manifestPath, remoteKey: `${normalizedPrefix}latest.json`, url: `${base}/latest.json` },
  ].map(entry => ({ ...entry, size: fs.statSync(entry.filePath).size, sha256: qiniu.sha256(entry.filePath) }));
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const version = qiniu.normalizeVersion(args.version);
  const entries = collect(path.resolve(qiniu.required(args['release-dir'], 'release-dir')), version, args.prefix, args.domain);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(entries.map(({ filePath, ...entry }) => entry), null, 2)}\n`);
    return;
  }
  const config = {
    accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: qiniu.required(args.bucket, 'bucket'),
    uploadHost: qiniu.normalizeHttpsUrl(args['upload-host'], 'upload-host'),
  };
  for (const entry of entries) {
    await qiniu.uploadEntry(config, entry);
    await qiniu.refreshUrls(config, [entry.url]);
    await qiniu.verifyEntriesWithRetry([entry]);
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { collect };
