-- 0.75 m wide, 0.6875 m high stone-colored birdbath. Blue basin is decorative.
local s=createScene({name="garden_birdbath",dimensions={6,3,6},terrainDepth=1})
local stone,edge,water="#AAA89B","#CBC9B9","#6C9FA8"
s:group("ground");s:surface({position={0,0,0},dimensions={6,1,5},blockId=12})
s:group("birdbath")
local boxes={}
local function disk(radius,inner,y,height,color)
 for z=-12,11 do
  local first=nil
  for x=-12,12 do
   local d=((x+0.5)/32)^2+((z+0.5)/32)^2
   local inside=x<12 and d<=radius^2 and (not inner or d>=inner^2)
   if inside and not first then first=x end
   if first and not inside then
    boxes[#boxes+1]={position={2+first/32,y,2+z/32},dimensions={(x-first)/32,height,1/32},color=color};first=nil
   end
  end
 end
end
disk(0.25,nil,0,0.0625,stone)
disk(0.1875,nil,0.0625,0.0625,edge)
disk(0.09375,nil,0.125,0.3125,stone)
disk(0.1875,nil,0.4375,0.0625,edge)
disk(0.34375,nil,0.5,0.03125,stone)
disk(0.34375,0.28125,0.53125,0.125,stone)
disk(0.375,0.28125,0.65625,0.03125,edge)
-- Flat recessed blue surface, no native liquid/emission or transparent material.
disk(0.28125,nil,0.5625,0.03125,water)
local stats=s:voxelBoxes({boxes=boxes,size=1/32,replace=true})
local file="blocktemplates/"..s.name.."_birdbath.x"
local exported=s:exportVoxelX(file,"birdbath",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={4,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={0.75,0.6875,0.75},decorativeWater=true},
 overview={eye=view({6,3,5}),lookat=view({3,0.3,2})},
 detail={eye=view({5.3,1.7,4}),lookat=view({4,0.4,2})}}
