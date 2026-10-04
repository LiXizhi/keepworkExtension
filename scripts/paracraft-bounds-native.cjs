// Live read-only collision benchmark plus synthetic invalidation regression.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const [jobArg,outArg]=process.argv.slice(2);assert(jobArg&&outArg);const job=JSON.parse(fs.readFileSync(jobArg));
assert(job.state==='completed'&&job.identity.worldPath.includes('CreationAcceptance'));
const p=job.result.origin;
const code=`local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");assert(C.World.Identity().sessionId==${job.identity.sessionId});assert(C.World.Identity().worldPath==${JSON.stringify(job.identity.worldPath)});
-- Retain the legacy eight-corner algorithm as the comparison even on reruns.
local previous=function(self,entity)
 local obj=entity:GetInnerObject();if obj and obj:IsValid() and entity.GetLocalTransform then
  local asset=obj:GetPrimaryAsset();if asset and asset:IsLoaded()then local box=asset:GetBoundingBox({});if box and box.min_x and box.max_x>box.min_x then
   local matrix=commonlib.gettable("mathlib.Matrix4"):new():identity();local q=commonlib.gettable("mathlib.Quaternion"):new();
   q:FromEulerAnglesSequence(entity:GetRoll()or 0,entity:GetPitch()or 0,entity:GetFacing()or 0,"zxy");q:ToRotationMatrix(matrix);
   local scale=entity:GetScaling()or 1;local origin={obj:GetPosition()};local lo,hi={math.huge,math.huge,math.huge},{-math.huge,-math.huge,-math.huge};
   for _,x in ipairs({box.min_x,box.max_x})do for _,y in ipairs({box.min_y,box.max_y})do for _,z in ipairs({box.min_z,box.max_z})do
    for i=1,3 do local v=(x*matrix[i]+y*matrix[i+4]+z*matrix[i+8])*scale+origin[i];lo[i]=math.min(lo[i],v);hi[i]=math.max(hi[i],v)end
   end end end;return lo,hi
  end end
 end;local box=entity:GetInnerObjectAABB();if not box or box:GetMaxExtent()==0 then box=entity:GetCollisionAABB()end;return box:GetMin(),box:GetMax()
end;
NPL.load("(gl)script/apps/Aries/Creator/Game/Code/Creation/World.lua",true);
NPL.load("(gl)script/apps/Aries/Creator/Game/ParacraftCLI/test/CreationBoundsRegression.lua",true);
local regression=commonlib.gettable("MyCompany.Aries.Game.ParacraftCLI.CreationBoundsRegression").Run();
local old=C.World:new():Init({});old.EntityBounds=previous;local new=C.World:new():Init({});
local entities=commonlib.gettable("MyCompany.Aries.Game.EntityManager").GetAllEntities();local count=0;
for _,e in pairs(entities)do local a,b=old:EntityBounds(e);local x,y=new:EntityBounds(e);for i=1,3 do assert(math.abs(a[i]-x[i])<1e-8 and math.abs(b[i]-y[i])<1e-8,"live bounds changed")end;count=count+1 end
local bounds={min={${p[0]},180,${p[2]}},max={${p[0]+2},182,${p[2]+2}}};
local function bench(w)local start=ParaGlobal.timeGetTime();for i=1,64 do assert(not w:EntitiesIntersect(bounds),"benchmark box is occupied")end;return ParaGlobal.timeGetTime()-start end
local samples={};for i=1,3 do
 if i%2==1 then local a=bench(old);local b=bench(new);samples[#samples+1]={baselineMs=a,optimizedMs=b}
 else local b=bench(new);local a=bench(old);samples[#samples+1]={baselineMs=a,optimizedMs=b}end
end
return {regression=regression,entities=count,queriesPerSample=64,samples=samples,identity=C.World.Identity()};`;
const body=JSON.stringify({v:1,action:'run_npl_code',params:{code}});
const req=http.request({hostname:'127.0.0.1',port:8099,path:'/ajax/paracraft_cli',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{const r=JSON.parse(data);assert(r.ok&&r.result.ok,JSON.stringify(r));fs.mkdirSync(outArg,{recursive:true});fs.writeFileSync(path.join(outArg,'bounds.json'),JSON.stringify(r.result,null,2));console.log(JSON.stringify(r.result));});});req.on('error',e=>{console.error(e);process.exitCode=1;});req.setTimeout(30000,()=>req.destroy(new Error('native benchmark observation timeout')));req.end(body);
