const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');

async function prepare() {
  const electron = require('electron');
  if (process.platform !== 'darwin') return electron;
  // Cocoa uses CFBundleName for the first menu, ignoring MenuItem.label and
  // app.setName(). Brand a private development copy, never the installed SDK.
  const source = path.resolve(electron, '../../..');
  const bundle = path.join(root, '.dev-runtime', 'Keepwork.app');
  const executable = path.join(bundle, 'Contents/MacOS/Electron');
  const marker = path.join(root, '.dev-runtime', 'source.json');
  const stamp = JSON.stringify({ source, version: require('electron/package.json').version,
    plist: createHash('sha256').update(await fs.readFile(path.join(source, 'Contents/Info.plist'))).digest('hex'), name: 'Keepwork', schema: 2 });
  if (await fs.readFile(marker, 'utf8').catch(() => '') === stamp &&
      await fs.stat(executable).then(() => true, () => false)) return executable;
  await fs.rm(bundle, { recursive: true, force: true });
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  execFileSync('/usr/bin/ditto', [source, bundle]);
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', 'Keepwork', plist]);
  }
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.keepwork.aichat-desktop.development', plist]);
  const { signAsync } = require('@electron/osx-sign');
  const entitlements = path.join(root, 'assets/entitlements.mac.plist');
  await signAsync({ app: bundle, identity: '-', identityValidation: false,
    hardenedRuntime: true, optionsForFile: () => ({ entitlements, hardenedRuntime: true }) });
  await fs.writeFile(marker, stamp);
  return executable;
}

module.exports = { prepare };
if (require.main === module) {
  prepare().then(executable => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, ['.', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
