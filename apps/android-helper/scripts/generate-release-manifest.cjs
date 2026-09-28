#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function generate(file, version, baseUrl, commit, publishedAt = new Date().toISOString(), versionCode = 1) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be X.Y.Z');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('commit must be a 40-character lowercase SHA');
  const name = `KP-Local-Helper-Android-${version}-arm64-v8a.apk`;
  if (path.basename(file) !== name) throw new Error(`APK must be named ${name}`);
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`);
  if (url.protocol !== 'https:' || url.origin !== 'https://cdn.keepwork.com') throw new Error('release URL must use the Keepwork HTTPS CDN');
  const data = fs.readFileSync(file);
  return {
    schemaVersion: 1,
    product: 'kp-local-helper-android',
    channel: 'internal',
    signed: true,
    version,
    versionCode,
    commit,
    publishedAt,
    platform: 'android',
    arch: 'arm64-v8a',
    minSdk: 29,
    fileName: name,
    installerType: 'apk',
    url: url.href,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    capabilities: ['mcp', 'local-model'],
    mcpProtocolVersion: '2025-03-26',
    localModelProtocolVersion: '1.0.0',
    localModelRuntimeVersion: '0.1.0',
    model: { id: 'speaker-eres2net-base-zh-16k', version: '1.0.1', dimension: 512 },
  };
}

function args(argv) {
  const value = {};
  for (let index = 0; index < argv.length; index += 2) value[argv[index].replace(/^--/, '')] = argv[index + 1];
  return value;
}

if (require.main === module) {
  try {
    const options = args(process.argv.slice(2));
    const identity = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
    if (identity.version !== options.version || !Number.isSafeInteger(identity.versionCode) || identity.versionCode <= 0) {
      throw new Error('version arguments do not match version.json');
    }
    const manifest = generate(path.resolve(options.file), options.version, options['base-url'], options.commit, new Date().toISOString(), identity.versionCode);
    const output = path.resolve(options.output || 'latest.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { generate };
