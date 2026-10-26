const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
const {captureDesktop}=require('../src/core/desktopCapture.ts');
test('macOS capture needs no Accessibility or control commands and cleans temporary image',async()=>{
 let file;const commands=[];
 const command=async(program,args)=>{commands.push([program,args]);if(program.endsWith('osascript'))return JSON.stringify({width:1440,height:900});if(program.endsWith('screencapture')){file=args.at(-1);fs.writeFileSync(file,Buffer.from([255,216,255,217]));}return '';};
 const result=JSON.parse(await captureDesktop(undefined,'darwin',command));assert.equal(result.width,1440);assert.equal(result.height,900);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(require('node:path').dirname(file)),false);
 assert.deepEqual(commands.map(c=>c[0]),['/usr/bin/osascript','/usr/sbin/screencapture','/usr/bin/sips']);assert.doesNotMatch(JSON.stringify(commands),/System Events|AXIsProcessTrusted|keystroke|CGEventPost/);
});
test('macOS oversized captures and native failure both clean temporary files',async()=>{
 for(const failure of ['size','command']){let file;const command=async(program,args)=>{if(program.endsWith('osascript'))return '{"width":100,"height":100}';if(program.endsWith('screencapture')){file=args.at(-1);fs.writeFileSync(file,Buffer.alloc(3*1024*1024+1));if(failure==='command')throw Error('native failure');}return '';};await assert.rejects(captureDesktop(undefined,'darwin',command),/3 MB|native failure/);assert.equal(fs.existsSync(file),false);}
});
test('unsupported and cancelled capture never launches an OS command',async()=>{
 const command=()=>{throw Error('must not execute');};await assert.rejects(captureDesktop(undefined,'linux',command),/Windows/);const controller=new AbortController();controller.abort();await assert.rejects(captureDesktop(controller.signal,'win32',command),/abort/i);
});
test('Windows native independent capture returns a bounded JPEG without input', {skip:process.platform!=='win32'}, async()=>{
 const shot=JSON.parse(await captureDesktop());assert.ok(shot.width>0&&shot.height>0);const bytes=Buffer.from(shot.data,'base64');assert.ok(bytes.length>0&&bytes.length<=3*1024*1024);assert.equal(bytes.readUInt16BE(0),0xffd8);
});
