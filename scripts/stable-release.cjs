// Coordinated stable release. Existing main-branch fixed URLs remain untouched.
const fs = require('node:fs');
const path = require('node:path');
const qiniu = require('./lib/qiniu-release.cjs');
const TARGETS = ['windows-x64', 'macos-arm64', 'macos-x64'];
const PREFIX = 'keepwork/mcp-stable/';
const DOMAIN = 'https://cdn.keepwork.com';
function identity(repo) {
  const runtime = JSON.parse(fs.readFileSync(path.join(repo, 'apps/mcp-runtime/package.json')));
  const extension = JSON.parse(fs.readFileSync(path.join(repo, 'apps/vscode-extension/package.json')));
  qiniu.normalizeVersion(runtime.version);
  if (runtime.version !== extension.version) throw new Error('Commit matching MCP and VS Code versions before a stable release');
  return runtime.version;
}
function collect(dir, version, commit) {
  qiniu.normalizeVersion(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
  const archives = [], descriptors = [];
  for (const target of TARGETS) {
    const [platform, arch] = target.split('-');
    const descriptor = path.join(dir, `${target}.json`);
    const m = JSON.parse(fs.readFileSync(descriptor));
    const filePath = path.join(dir, `${target}.zip`);
    if (m.schemaVersion !== 1 || m.product !== 'keepwork-mcp-node-runtime' || m.version !== version || m.commit !== commit
        || m.platform !== platform || m.arch !== arch || m.fileName !== `${target}.zip`
        || m.url !== `${DOMAIN}/${PREFIX}${version}/${target}.zip`
        || m.size !== fs.statSync(filePath).size || m.sha256 !== qiniu.sha256(filePath)) throw new Error(`Invalid stable artifact: ${target}`);
    archives.push(entry(filePath, `${PREFIX}${version}/${target}.zip`));
    // Immutable per-release metadata aids recovery after a partial publish.
    archives.push(entry(descriptor, `${PREFIX}${version}/${target}.json`));
    descriptors.push(entry(descriptor, `${PREFIX}${target}.json`));
  }
  return { archives, descriptors };
}
function entry(filePath, remoteKey) {
  return { filePath, name: path.basename(filePath), remoteKey, url: `${DOMAIN}/${remoteKey}`, size: fs.statSync(filePath).size, sha256: qiniu.sha256(filePath) };
}
async function publish(entries, config, transport = qiniu) {
  for (const item of entries) await transport.uploadEntry(config, item);
  await transport.refreshUrls(config, entries.map(item => item.url));
  await transport.verifyEntriesWithRetry(entries);
}
async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  const version = identity(path.resolve(__dirname, '..'));
  if (args.mode === 'validate') { console.log(version); return; }
  const release = collect(path.resolve(args.dir), version, args.commit);
  if (args.dryRun) { console.log(JSON.stringify({ version, files: [...release.archives, ...release.descriptors].map(e => e.remoteKey) })); return; }
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'), secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  if (args.mode === 'artifacts') {
    // Rerunning a version must reuse the original verified binaries, not overwrite it with a different build.
    for (const item of release.archives) {
      const res = await fetch(item.url, { cache: 'no-store' });
      if (res.ok) {
        const data = Buffer.from(await res.arrayBuffer());
        if (require('node:crypto').createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(`Immutable release already differs: ${item.name}; reuse the original artifacts or release a new version`);
      } else if (res.status !== 404) throw new Error(`CDN preflight HTTP ${res.status}`);
    }
    await publish(release.archives, config);
  } else if (args.mode === 'promote') {
    await qiniu.verifyEntriesWithRetry(release.archives);
    // Do not let a delayed rerun downgrade an already promoted stable channel.
    for (const item of release.descriptors) {
      const res = await fetch(item.url, { cache: 'no-store' });
      if (res.ok) {
        const old = await res.json();
        const compare = (a,b) => { const x=a.split('.').map(Number), y=b.split('.').map(Number); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]-y[i]; return 0; };
        if (compare(old.version, version) > 0) throw new Error('Refusing stable channel downgrade');
      } else if (res.status !== 404) throw new Error(`CDN preflight HTTP ${res.status}`);
    }
    await publish(release.descriptors, config);
  } else throw new Error('Expected --mode validate, artifacts or promote');
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { identity, collect, publish };
