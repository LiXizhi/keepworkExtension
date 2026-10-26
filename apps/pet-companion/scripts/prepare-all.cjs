// Release preparation only; never invoked by a screenshot request.
const fs=require('node:fs'),path=require('node:path');
const { createRequire }=require('node:module');
const electronRequire=createRequire(require.resolve('electron/package.json'));
const { downloadArtifact }=electronRequire('@electron/get');
const { extract }=electronRequire('@electron-internal/extract-zip');
const version=require('../package.json').devDependencies.electron;
async function main(){
 for(const [platform,arch] of [['win32','x64'],['darwin','x64'],['darwin','arm64']]){
  const directory=path.resolve(__dirname,`../runtime-staging/${version}/${platform}-${arch}`);
  const executable=platform==='win32'?'electron.exe':'Electron.app/Contents/MacOS/Electron';
  if(fs.existsSync(path.join(directory,executable))&&fs.existsSync(path.join(directory,'version'))&&fs.readFileSync(path.join(directory,'version'),'utf8').trim()===version)continue;
  const archive=await downloadArtifact({version,artifactName:'electron',platform,arch,checksums:electronRequire('./checksums.json')});
  fs.mkdirSync(directory,{recursive:true});await extract(archive,{dir:directory});
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
