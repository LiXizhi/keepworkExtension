const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {stagePetCompanion}=require('./pet-companion-stage.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pet-stage-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
function runtime(directory,platform){const file=path.join(directory,platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron.exe');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'test runtime');fs.writeFileSync(path.join(directory,'version'),'44.1.1');}
test('native companion stage carries shared assets and pinned runtime; rejects wrong version',t=>{
 const root=fixture(t),input=path.join(root,'input'),output=path.join(root,'output');runtime(input,'win32');
 stagePetCompanion(output,{platform:'win32',arch:'x64',runtimeDir:input});
 for(const file of ['companion.cjs','petWindow.cjs','permissionClient.cjs','pet-preload.cjs','pet.html','pet.js','pet.css','electron/electron.exe'])assert.ok(fs.existsSync(path.join(output,file)),file);
 fs.writeFileSync(path.join(input,'version'),'wrong');assert.throws(()=>stagePetCompanion(output,{platform:'win32',arch:'x64',runtimeDir:input}),/44.1.1/);
});
test('universal stage includes each supported executable in a separate target directory',t=>{
 const root=fixture(t);for(const [platform,arch]of [['win32','x64'],['darwin','x64'],['darwin','arm64']]){
  const key=`KEEPWORK_PET_ELECTRON_${platform}_${arch}`.toUpperCase(),previous=process.env[key],input=path.join(root,platform+'-'+arch);runtime(input,platform);process.env[key]=input;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
 }
 const output=path.join(root,'out');stagePetCompanion(output,{universal:true});
 for(const [platform,arch]of [['win32','x64'],['darwin','x64'],['darwin','arm64']])assert.ok(fs.existsSync(path.join(output,'electron',platform+'-'+arch,platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron.exe')));
});
