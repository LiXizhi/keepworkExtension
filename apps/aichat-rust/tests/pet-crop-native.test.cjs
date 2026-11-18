const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('real hidden AppKit window applies production cropped frame on one display', {skip:process.platform!=='darwin',timeout:60000},()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-native-crop-'));
 function run(command,args,timeout=20000){const r=spawnSync(command,args,{encoding:'utf8',timeout});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
 try {
  const original=fs.readFileSync(path.resolve(__dirname,'../src-tauri/src/pet_canvas.rs'),'utf8');
  const native=original.slice(original.indexOf('mod macos {'));
  const source=`use std::ffi::c_void;
#[derive(Clone,Copy)]struct WorkArea{x:i32,y:i32,width:i32,height:i32}
struct WebviewWindow(*mut c_void); impl WebviewWindow{fn ns_window(&self)->Result<*mut c_void,String>{Ok(self.0)}}
${native}
extern "C" {fn crop_test_window()->*mut c_void;fn crop_check_window(p:*mut c_void,x:f64,y:f64,w:f64,h:f64)->i32;fn crop_close_window(p:*mut c_void);}
fn main(){unsafe{let p=crop_test_window();assert!(!p.is_null());let window=WebviewWindow(p);
for frame in [WorkArea{x:150,y:180,width:56,height:56},WorkArea{x:100,y:120,width:422,height:200},WorkArea{x:220,y:260,width:56,height:56}]{macos::set_canvas_frame(&window,frame).unwrap();assert_eq!(crop_check_window(p,frame.x as f64,frame.y as f64,frame.width as f64,frame.height as f64),1,"native frame must exclude former fullscreen transparent area");}crop_close_window(p);}}
`;
  const input=path.join(temporary,'probe.rs'),object=path.join(temporary,'native.o'),binary=path.join(temporary,'probe');fs.writeFileSync(input,source);
  run('clang',['-c',path.join(__dirname,'fixtures/pet_crop_native.m'),'-o',object]);
  run(process.env.RUSTC||path.join(os.homedir(),'.cargo/bin/rustc'),['--edition=2021',input,'-o',binary,'-C',`link-arg=${object}`,'-l','framework=AppKit'],45000);
  console.log(run(binary,[],10000));
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
