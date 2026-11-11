#!/usr/bin/env node
// Dry-run by default. Publishing is an explicit operator action after Windows validation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyEnvelope } = require('./cef-release.cjs');
const prefix = 'keepwork/aichat-cef/v1/';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function publication(directory, channel, arch, key) {
  assert.ok(['legacy', 'modern'].includes(channel) && ['x64', 'x86', 'arm64'].includes(arch));
  const manifestKey = `${channel}/windows-${arch}/stable.json`;
  const manifestFile = path.join(directory, manifestKey);
  const manifest = verifyEnvelope(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), key);
  assert.equal(manifest.channel, channel); assert.equal(manifest.arch, arch);
  const objectKey = 'objects/' + manifest.sha256 + '.zip', objectFile = path.join(directory, objectKey);
  assert.equal(fs.statSync(objectFile).size, manifest.size); assert.equal(digest(objectFile), manifest.sha256);
  const entry = (name, file) => ({ name, filePath: path.resolve(file), size: fs.statSync(file).size, sha256: digest(file), remoteKey: prefix + name, url: 'https://cdn.keepwork.com/' + prefix + name });
  return [entry(objectKey, objectFile), entry(manifestKey, manifestFile)];
}
async function main() {
  const [directory, channel, arch, publicKey, flag] = process.argv.slice(2);
  assert.ok(directory && channel && arch && publicKey && (!flag || flag === '--publish'), 'Usage: publish-cef.cjs DIRECTORY legacy|modern x64|x86|arm64 PUBLIC.pem [--publish]');
  const entries = publication(directory, channel, arch, fs.readFileSync(publicKey));
  if (flag !== '--publish') { console.log(JSON.stringify({ dryRun: true, entries }, null, 2)); return; }
  const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
  const { publish } = require('../../../scripts/stable-release.cjs');
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'access key'), secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'secret key'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  // Immutable archive must be reachable and verified before the mutable channel is promoted.
  await publish([entries[0]], config);
  await publish([entries[1]], config);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publication };
