const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('./lib/qiniu-release.cjs');
const { publish } = require('./stable-release.cjs');
const DOMAIN = 'https://cdn.keepwork.com';
const TARGETS = {
  'win32-x64': { platform: 'windows', arch: 'x64' },
  'darwin-arm64': { platform: 'macos', arch: 'arm64' },
  'darwin-x64': { platform: 'macos', arch: 'x64' },
};

function collect(dir, target) {
  const clientTarget = TARGETS[target];
  if (!clientTarget) throw new Error('Unsupported desktop target');
  const names = fs.readdirSync(dir).filter(name => /\.(exe|dmg|zip|blockmap|yml)$/.test(name));
  if (!names.includes(target.startsWith('win32') ? 'latest.yml' : 'latest-mac.yml')) throw new Error('Updater metadata is required');
  const zipNames = names.filter(name => name.toLowerCase().endsWith('.zip'));
  if (zipNames.length !== 1) throw new Error('Exactly one client ZIP is required');
  const entries = names.map(name => {
    const filePath = path.join(dir, name), remoteKey = `keepwork/aichat-desktop/${target}/${name}`;
    return { filePath, name, remoteKey, url: `${DOMAIN}/${remoteKey}`, size: fs.statSync(filePath).size, sha256: qiniu.sha256(filePath) };
  });
  const archive = entries.find(entry => entry.name === zipNames[0]);
  const versionMatch = archive.name.match(/^KeepWork-SecondBrain-(.+)-[^-]+\.zip$/i);
  if (!versionMatch) throw new Error('Client ZIP filename does not contain a version');
  const manifest = {
    schemaVersion: 1,
    product: 'aichat-desktop',
    version: versionMatch[1],
    ...clientTarget,
    format: 'zip',
    fileName: archive.name,
    url: archive.url,
    size: archive.size,
    sha256: archive.sha256,
  };
  const manifestPath = path.join(dir, 'latest-client.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  entries.push({
    filePath: manifestPath,
    name: 'latest-client.json',
    remoteKey: `keepwork/aichat-desktop/${target}/latest-client.json`,
    url: `${DOMAIN}/keepwork/aichat-desktop/${target}/latest-client.json`,
    size: fs.statSync(manifestPath).size,
    sha256: qiniu.sha256(manifestPath),
  });
  return entries;
}

async function publishRelease(entries, config, transport = qiniu) {
  const binaries = entries.filter(entry => !entry.name.endsWith('.yml') && !entry.name.endsWith('.json'));
  const descriptors = entries.filter(entry => entry.name.endsWith('.yml') || entry.name.endsWith('.json'));
  for (const group of [binaries, descriptors]) await publish(group, config, transport);
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const entries = collect(dir, args.target);
  if (args.dryRun) { console.log(entries.map(e => e.name)); return; }
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'), secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  await publishRelease(entries, config);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { collect, publishRelease };
