// Promote the new channel independently of legacy installers and MCP feeds.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const { publish } = require('../../../scripts/stable-release.cjs');
const targets = ['windows-x64', 'macos-arm64', 'macos-x64'];
const prefix = 'keepwork/aichat-launcher/v1/';
const base = 'https://cdn.keepwork.com/' + prefix;
const hex = /^[a-f0-9]{64}$/;

function unpack(envelope, key) {
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!crypto.verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) throw Error('Invalid live manifest signature');
  return JSON.parse(bytes);
}

function plan(dir, previous, platforms, sequence) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
  const app = read('app');
  qiniu.normalizeVersion(app.version);
  if (!Number.isSafeInteger(sequence) || sequence <= (previous?.sequence || 0)) throw Error('Release sequence must increase');
  const manifest = { schema: 1, sequence, version: app.version, app, platforms: {} };
  const uploads = [];
  function add(obj) {
    if (!hex.test(obj.sha256) || !Number.isSafeInteger(obj.size) || obj.size <= 0) throw Error('Invalid artifact descriptor');
    const name = obj.sha256 + '.zip';
    const file = path.join(dir, name);
    if (fs.statSync(file).size !== obj.size || qiniu.sha256(file) !== obj.sha256) throw Error('Package integrity mismatch: ' + name);
    uploads.push(entry(file, 'objects/' + name, obj.sha256));
  }
  add(app);
  for (const target of targets) {
    const descriptor = platforms ? read(target) : previous?.platforms[target];
    if (!descriptor || !hex.test(app.contract) || descriptor.contract !== app.contract) throw Error('Build native dependencies for ' + target);
    manifest.platforms[target] = descriptor;
    if (platforms) add(descriptor);
  }
  return { manifest, uploads };
}
function entry(filePath, key, sha256 = qiniu.sha256(filePath)) {
  return { name: path.basename(filePath), filePath, sha256, size: fs.statSync(filePath).size, url: base + key, remoteKey: prefix + key };
}
async function main() {
  const [mode, dir, sequence] = process.argv.slice(2);
  if (!['code','launchers','code-and-launchers','initial','refresh-platforms'].includes(mode) || !dir) throw Error('Expected code|initial|refresh-platforms DIR SEQUENCE');
  const key = crypto.createPrivateKey(process.env.KP_DESKTOP_MANIFEST_PRIVATE_KEY);
  const publicKey = crypto.createPublicKey(key);
  const jwk = publicKey.export({format:'jwk'});
  if (jwk.crv !== 'Ed25519' || Buffer.from(jwk.x, 'base64url').toString('base64') !== process.env.KP_DESKTOP_LAUNCHER_PUBLIC_KEY) throw Error('Signing key does not match the launcher');
  const response = await fetch(base + 'stable.json?verify=' + Date.now());
  if (!response.ok && response.status !== 404) throw Error('Stable preflight HTTP ' + response.status);
  const previous = response.ok ? unpack(await response.json(), publicKey) : null;
  const retry = previous?.sequence === Number(sequence);
  if (!retry && (mode === 'initial') !== !previous) throw Error('Initial publication requires an empty channel');
  const baseline = retry ? {...previous, sequence:previous.sequence - 1} : previous;
  const { manifest, uploads } = mode === 'launchers' ? {manifest:previous, uploads:[]} : plan(dir, baseline, ['initial','refresh-platforms'].includes(mode), Number(sequence));
  if (retry && JSON.stringify(previous) !== JSON.stringify(manifest)) throw Error('Cannot reuse a live sequence with different artifacts');
  const data = Buffer.from(JSON.stringify(manifest));
  const file = path.join(dir, 'stable.json');
  fs.writeFileSync(file, JSON.stringify({ payload: data.toString('base64'), signature: crypto.sign(null, data, key).toString('base64') }));
  const config = {accessKey:qiniu.required(process.env.KP_QINIU_ACCESS_KEY,'access key'), secretKey:qiniu.required(process.env.KP_QINIU_SECRET_KEY,'secret key'), bucket:'haqi', uploadHost:'https://up-z2.qiniup.com'};
  const downloads = [], downloadManifests = [];
  if (mode === 'initial' || mode === 'code-and-launchers' || mode === 'launchers') {
    for (const target of targets) {
      const [platform, arch] = target.split('-');
      const legacyTarget = (platform === 'windows' ? 'win32' : 'darwin') + '-' + arch;
      const name = 'Keepwork-Launcher-' + target + '.zip';
      const dirKey = 'keepwork/aichat-desktop/' + legacyTarget + '/';
      const download = entry(path.join(dir, name), name);
      download.remoteKey = dirKey + name;
      download.url = 'https://cdn.keepwork.com/' + download.remoteKey;
      downloads.push(download);
      const descriptor = {schemaVersion:1, product:'aichat-desktop', format:'zip', version:manifest.version,
        fileName:name, platform, arch, url:download.url, sha256:download.sha256, size:download.size};
      const output = path.join(dir, target + '-download.json');
      fs.writeFileSync(output, JSON.stringify(descriptor));
      const metadata = entry(output, 'latest-client.json');
      metadata.remoteKey = dirKey + 'latest-client.json';
      metadata.url = 'https://cdn.keepwork.com/' + metadata.remoteKey;
      downloadManifests.push(metadata);
    }
  }
  if (mode === 'launchers') {
    await publish(downloads, config);
  } else if (!retry) {
    await publish([...uploads, ...downloads], config);
    await publish([entry(file, 'stable.json')], config);
  } else if (downloads.length) {
    await qiniu.verifyEntriesWithRetry(downloads);
  }
  // Switch the website's existing download buttons only after first launch works.
  if (downloadManifests.length) await publish(downloadManifests, config);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { plan, unpack };
