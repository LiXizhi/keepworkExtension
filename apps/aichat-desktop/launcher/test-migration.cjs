// On a fresh native runner, drive the updater in the unchanged public 0.1.8 application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const dir = path.resolve(process.argv[2]);
const target = process.argv[3];
const mac = process.platform === 'darwin';
const arch = process.arch;
const name = 'KeepWork 第二大脑';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
const base = 'https://cdn.keepwork.com/keepwork/aichat-desktop/' + target + '/';
async function main() {
  const old = 'KeepWork-SecondBrain-0.1.8-' + arch + (mac ? '.zip' : '.exe');
  const archive = path.join(temp, old);
  execFileSync('curl', ['-fLsS','--retry','3',base + old,'-o',archive],{stdio:'inherit'});
  let executable, bundle;
  if (mac) {
    execFileSync('ditto',['-x','-k',archive,temp]);
    bundle = path.join(temp,name + '.app');
    executable = path.join(bundle,'Contents/MacOS',execFileSync('/usr/libexec/PlistBuddy',['-c','Print CFBundleExecutable',path.join(bundle,'Contents/Info.plist')],{encoding:'utf8'}).trim());
    const requirement = execFileSync('codesign',['-d','-r-',bundle],{stdio:['ignore','pipe','pipe']}).toString();
    console.log('Old designated requirement',requirement);
    // Exercise Squirrel's own signing decision in the unchanged application.
  } else {
    execFileSync(archive,['/S'],{timeout:180000});
    const programs = path.join(process.env.LOCALAPPDATA,'Programs');
    executable = fs.readdirSync(programs).map(f=>path.join(programs,f,name+'.exe')).find(fs.existsSync);
    if (!executable) throw Error('Installed 0.1.8 executable missing');
  }
  // Only bind in the ephemeral runner and serve the candidate's fixed artifact names.
  const assets = new Set(fs.readdirSync(dir).filter(n=>/\.(exe|zip|blockmap|yml)$/.test(n)));
  const feed = http.createServer((req,res)=>{
    const item = decodeURIComponent(new URL(req.url,'http://localhost').pathname.slice(1));
    if (!assets.has(item)) {res.writeHead(404).end();return;}
    const file=path.join(dir,item);
    res.writeHead(200,{'Content-Length':fs.statSync(file).size});fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>feed.listen(0,'127.0.0.1',resolve));feed.unref();
  const proc=spawn(executable,['--inspect=127.0.0.1:19232','--background'], {stdio:'ignore',detached:true});proc.unref();
  let endpoint;
  for(let i=0;i<90 && !endpoint;i++){try{endpoint=(await (await fetch('http://127.0.0.1:19232/json/list')).json())[0].webSocketDebuggerUrl;}catch{await delay(1000);}}
  if(!endpoint)throw Error('Public application did not open its inspector');
  const socket=new WebSocket(endpoint);
  await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});
  const log=path.join(temp,'updater-result');
  const expression=`(async()=>{const r=process.mainModule.require.bind(process.mainModule); const app=r('electron').app;
    if(app.getVersion()!=='0.1.8')throw Error(app.getVersion());
    await app.whenReady();const requireApp=r('module').createRequire(app.getAppPath()+'/package.json');
    const u=requireApp('electron-updater').autoUpdater; const note=t=>r('fs').appendFileSync(${JSON.stringify(log)},t+'\\n');
    u.logger={info:(...s)=>note(s.join(' ')),warn:(...s)=>note(s.join(' ')),error:(...s)=>note(s.join(' ')),debug:()=>{}};
    if (!${process.argv.includes('--cdn')}) u.setFeedURL({provider:'generic',url:${JSON.stringify('http://127.0.0.1:'+feed.address().port+'/')}});
    u.disableDifferentialDownload=true;
    u.on('error',e=>note(String(e)));u.once('update-downloaded',()=>{note('downloaded');setTimeout(()=>u.quitAndInstall(false,true),1000)});
    await u.checkForUpdates();return true;})()`;
  socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  socket.onmessage=e=>{const message=JSON.parse(e.data);if(message.id===1){if(message.result?.exceptionDetails)console.error(message.result.exceptionDetails);socket.close();}};
  const installed=mac?path.join(bundle,'Contents/MacOS/Keepwork'):executable;
  const expected=mac?path.join(dir,'stage',name+'.app/Contents/MacOS/Keepwork'):path.join(dir,'stage/app',name+'.exe');
  const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  for(let i=0;i<210;i++){if(fs.existsSync(installed)&&fs.statSync(installed).size===fs.statSync(expected).size&&hash(installed)===hash(expected)){console.log('0.1.8 updater installed the launcher at',installed);return;}await delay(1000);}
  if (!mac) {
    console.error('Installed executable',installed,'size',fs.existsSync(installed)&&fs.statSync(installed).size);
    console.error(execFileSync('tasklist',['/fo','csv'],{encoding:'utf8'}).split('\n').filter(s=>/Keepwork|install|setup|elevate/i.test(s)).join('\n'));
  }
  throw Error('Migration did not replace the installed application: '+(fs.existsSync(log)?fs.readFileSync(log,'utf8'):'no updater event'));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
