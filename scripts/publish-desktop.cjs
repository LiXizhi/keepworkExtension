const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('./lib/qiniu-release.cjs');
const { publish } = require('./stable-release.cjs');
const { writeCdnSummary } = require('./lib/cdn-summary.cjs');
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
  const fixedName = 'KeepWork-SecondBrain.zip';
  const fixedKey = `keepwork/aichat-desktop/${target}/${fixedName}`;
  const fixedArchive = { ...archive, name: fixedName, remoteKey: fixedKey, url: `${DOMAIN}/${fixedKey}` };
  entries.push(fixedArchive);
  const installerFormat = target.startsWith('win32') ? 'exe' : 'dmg';
  const installerName = archive.name.replace(/\.zip$/i, `.${installerFormat}`);
  const installerEntries = entries.filter(entry => entry.name.endsWith(`.${installerFormat}`));
  if (installerEntries.length > 1 || (installerEntries.length && installerEntries[0].name !== installerName)) throw new Error('Installer version/architecture must match the ZIP');
  const installer = installerEntries[0];
  const manifest = {
    schemaVersion: 1,
    product: 'aichat-desktop',
    version: versionMatch[1],
    ...clientTarget,
    format: 'zip',
    fileName: fixedArchive.name,
    url: fixedArchive.url,
    size: archive.size,
    sha256: archive.sha256,
    ...(installer ? { installer: { format: installerFormat, fileName: installer.name, url: installer.url, size: installer.size, sha256: installer.sha256 } } : {}),
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

async function migrationEntries(dir, target) {
  const platform = TARGETS[target];
  if (!platform) throw Error('Unsupported migration target');
  const win = platform.platform === 'windows';
  const installer = 'KeepWork-Launcher-Migration-0.1.10-' + platform.arch + (win ? '.exe' : '.zip');
  const feed = win ? 'latest.yml' : 'latest-mac.yml';
  const descriptor = fs.readFileSync(path.join(dir, feed), 'utf8');
  const meta = win ? require(require.resolve('js-yaml', {paths:[path.resolve(__dirname,'../apps/aichat-desktop')]})).load(descriptor) : JSON.parse(descriptor);
  const bytes = fs.readFileSync(path.join(dir, installer));
  const sha512 = require('node:crypto').createHash('sha512').update(bytes).digest('base64');
  if (meta.version !== '0.1.10' || meta.files?.length !== 1 || meta.files[0].url !== installer ||
      meta.files[0].size !== bytes.length || meta.files[0].sha512 !== sha512) throw Error('Migration descriptor mismatch');
  const base = 'keepwork/aichat-desktop/' + target + '/';
  const response = await fetch(DOMAIN + '/' + base + feed + '?check=' + Date.now());
  if (!response.ok) throw Error('Cannot verify existing updater feed');
  const live = await response.text();
  if (!/^version: 0\.1\.8\s*$/m.test(live) && !(live.includes(sha512) && live.includes(installer))) throw Error('Unexpected live updater release');
  return [installer, ...(win ? [installer + '.blockmap'] : []), feed].map(name => {
    const filePath = path.join(dir, name), remoteKey = base + name;
    return {name,filePath,remoteKey,url:DOMAIN + '/' + remoteKey,size:fs.statSync(filePath).size,sha256:qiniu.sha256(filePath)};
  });
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const entries = args.channel === 'migration' ? await migrationEntries(dir, args.target) : collect(dir, args.target);
  const version = args.channel === 'migration' ? '0.1.10' : JSON.parse(fs.readFileSync(path.join(dir, 'latest-client.json'), 'utf8')).version;
  if (args.dryRun) { console.log(entries.map(e => e.name)); return; }
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'), secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  await publishRelease(entries, config);
  writeCdnSummary({
    title: `AIChat Desktop / ${args.target} — CDN 发布成功`, version, entries,
    note: '以下文件已发布并通过 CDN 校验。latest-client.json、更新清单和 KeepWork-SecondBrain.zip 等固定地址会被后续发布覆盖。',
  });
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { collect, publishRelease };
