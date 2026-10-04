const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('./lib/qiniu-release.cjs');
const { publish } = require('./stable-release.cjs');
async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const names = fs.readdirSync(dir).filter(name => /\.(exe|dmg|zip|blockmap|yml)$/.test(name));
  if (!['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(args.target)) throw new Error('Unsupported desktop target');
  if (!names.includes(args.target.startsWith('win32') ? 'latest.yml' : 'latest-mac.yml')) throw new Error('Updater metadata is required');
  const entries = names.map(name => {
    const filePath = path.join(dir, name), remoteKey = `keepwork/aichat-desktop/${args.target}/${name}`;
    return { filePath, name, remoteKey, url: `https://cdn.keepwork.com/${remoteKey}`, size: fs.statSync(filePath).size, sha256: qiniu.sha256(filePath) };
  });
  if (args.dryRun) { console.log(entries.map(e => e.name)); return; }
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'), secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  await publish(entries.filter(e => !e.name.endsWith('.yml')), config);
  await publish(entries.filter(e => e.name.endsWith('.yml')), config);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
