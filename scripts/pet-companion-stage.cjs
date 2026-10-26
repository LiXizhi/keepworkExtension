const fs = require('node:fs');
const path = require('node:path');
const repository = path.resolve(__dirname, '..');
function stagePetCompanion(destination, { platform = process.platform, arch = process.arch, includeRuntime = true, runtimeDir, universal = !['win32','darwin'].includes(platform) } = {}) {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of ['companion.cjs','permissionClient.cjs','petWindow.cjs','pet-preload.cjs','pet.js','pet.html','pet.css'])
    fs.copyFileSync(path.join(repository,'src/pet',file), path.join(destination,file));
  if (!includeRuntime) return;
  if (universal) {
    for (const [targetPlatform,targetArch] of [['win32','x64'],['darwin','x64'],['darwin','arm64']])
      copyRuntime(destination,targetPlatform,targetArch,undefined,true);
    return;
  }
  copyRuntime(destination,platform,arch,runtimeDir,false);
}
function copyRuntime(destination,platform,arch,runtimeDir,nested) {
  const staged=path.join(repository,`apps/pet-companion/runtime-staging/44.1.1/${platform}-${arch}`);
  const key = `KEEPWORK_PET_ELECTRON_${platform}_${arch}`.toUpperCase();
  const source = runtimeDir || process.env[key] || (fs.existsSync(path.join(staged,'version')) ? staged : '') || (platform === process.platform && arch === process.arch ? path.join(repository,'apps/pet-companion/node_modules/electron/dist') : '');
  const executable = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe';
  if (!source || !fs.existsSync(path.join(source, executable))) throw Error(`Missing ${platform}-${arch} pet Electron runtime. Run npm ci --prefix apps/pet-companion on the target host, or set ${key} to its extracted Electron 44.1.1 distribution.`);
  if (fs.readFileSync(path.join(source,'version'),'utf8').trim().replace(/^v/,'') !== '44.1.1') throw Error('Pet companion requires Electron 44.1.1');
  fs.cpSync(source, path.join(destination,'electron',...(nested ? [`${platform}-${arch}`] : [])), { recursive: true });
}
module.exports = { stagePetCompanion };
