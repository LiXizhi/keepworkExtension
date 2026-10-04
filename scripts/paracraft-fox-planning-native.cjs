// Compare the exact voxel/color/owner plan without touching native world blocks.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [baselineArg,outArg]=process.argv.slice(2);
assert(baselineArg&&outArg,'Usage: node scripts/paracraft-fox-planning-native.cjs BASELINE_LUA OUTPUT');
const source=fs.readFileSync(path.resolve('skills/paracraft-create/examples/skinned-fox.lua'),'utf8');
const baseline=fs.readFileSync(baselineArg,'utf8');
const literal=s=>{assert(!s.includes(']====]'));return '[====['+s+']====]';};
const code=`local function plan(source,head)
 local cut=assert(source:find('s:group("controls")',1,true));source=source:sub(1,cut-1)
 if head then source=source:gsub("local headLook=false","local headLook=true") end
 local cells,carrierWrites,boxes,group={},0,0,nil
 local mock={group=function(self,name) group=name end}
 mock.box=function(self,o)
  boxes=boxes+1;local p,d,u=o.position,o.dimensions,o.size
  local carriers={}
  for z=0,math.floor(d[3]/u+0.5)-1 do for y=0,math.floor(d[2]/u+0.5)-1 do for x=0,math.floor(d[1]/u+0.5)-1 do
   local a,b,c=p[1]+x*u,p[2]+y*u,p[3]+z*u
   local k=string.format("%d,%d,%d",a/u,b/u,c/u)
   assert(not cells[k],"duplicate planned voxel");cells[k]=group..":"..o.color
   carriers[math.floor(a)..","..math.floor(b)..","..math.floor(c)]=true
  end end end
  for _ in pairs(carriers)do carrierWrites=carrierWrites+1 end
 end
 local f=assert(loadstring(source));setfenv(f,setmetatable({createScene=function()return mock end},{__index=_G}));f()
 return cells,{boxes=boxes,carrierWrites=carrierWrites}
end
local results={}
for _,head in ipairs({false,true})do
 local before,old=plan(${literal(baseline)},head);local after,new=plan(${literal(source)},head);local count=0
 for k,v in pairs(before)do assert(after[k]==v,"changed color or bone owner at "..k);count=count+1 end
 for k,v in pairs(after)do assert(before[k]==v,"extra voxel at "..k)end
 assert(new.boxes<old.boxes and new.carrierWrites<old.carrierWrites)
 results[#results+1]={headLook=head,voxels=count,before=old,after=new}
end
return {variants=results,worldUnmodified=true};`;
const body=JSON.stringify({v:1,action:'run_npl_code',params:{code}});
const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
 let data='';res.on('data',c=>data+=c);res.on('end',()=>{const reply=JSON.parse(data);assert(reply.ok&&reply.result.ok,JSON.stringify(reply));
 fs.mkdirSync(outArg,{recursive:true});fs.writeFileSync(path.join(outArg,'planning.json'),JSON.stringify(reply.result,null,2));console.log(JSON.stringify(reply.result));});
});req.on('error',e=>{console.error(e);process.exitCode=1;});req.setTimeout(30000,()=>req.destroy(new Error('native planning timeout')));req.end(body);
