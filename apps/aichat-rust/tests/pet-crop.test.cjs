const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('production crop geometry bounds native window to visible pet and controls', {timeout:60000},()=>{
 const root=path.resolve(__dirname,'../src-tauri/src'), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-pet-crop-'));
 try {
  // Compile actual production geometry and its actual shared type definitions,
  // without pulling Tauri, application startup, accounts or Cargo dependencies.
  const model=fs.readFileSync(path.join(root,'pet.rs'),'utf8');
  let types=model.slice(model.indexOf('pub struct WorkArea'),model.indexOf('impl PetHitRegion'));
  types=types.replace(/#\[derive\([^\n]*\)\]\n/g,'').replace(/\s*#\[serde\([^\n]*\)\]/g,'').replace(/pub struct /g,'#[derive(Debug,Clone,PartialEq)]\npub struct ');
  types=types.replace('#[derive(Debug,Clone,PartialEq)]\npub struct WorkArea','#[derive(Debug,Clone,Copy,PartialEq)]\npub struct WorkArea');
  const source=`mod pet {${types}}\n#[path=${JSON.stringify(path.join(root,'pet_crop.rs'))}] mod pet_crop;\n${fs.readFileSync(path.join(__dirname,'fixtures/pet_crop_cases.rs'),'utf8')}`;
  const input=path.join(temporary,'cases.rs'),output=path.join(temporary,'cases');fs.writeFileSync(input,source);
  const rustc=process.env.RUSTC || (fs.existsSync(path.join(os.homedir(),'.cargo/bin/rustc'))?path.join(os.homedir(),'.cargo/bin/rustc'):'rustc');
  const compile=spawnSync(rustc,['--edition=2021','--test',input,'-o',output],{encoding:'utf8',timeout:45000});assert.ifError(compile.error);assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=spawnSync(output,['--nocapture'],{encoding:'utf8',timeout:10000});assert.ifError(run.error);assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
