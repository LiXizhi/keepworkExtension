-- 0.75 m round café table, 0.75 m work surface; color-only reusable prop.
local s=createScene({name="bistro_table",dimensions={6,3,6},terrainDepth=1})
local timber,light,rim,metal="#B58C65","#C49D72","#866247","#454D50"
s:group("ground");s:surface({position={0,0,0},dimensions={6,1,5},blockId=81})
s:group("table")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
box({1.75,0,1.96875},{0.5,0.0625,0.0625},metal)
box({1.96875,0,1.75},{0.0625,0.0625,0.5},metal)
box({1.9375,0.0625,1.9375},{0.125,0.625,0.125},metal)
for z=-12,11 do
 local first,color
 local function flush(last)if first then box({2+first/32,0.6875,2+z/32},{(last-first+1)/32,0.0625,1/32},color)end end
 for x=-12,12 do
  local radius=math.sqrt((x+0.5)^2+(z+0.5)^2)/12;local c
  if x<12 and radius<=1 then c=radius>0.84 and rim or (math.floor((x+12)/4)%2==0 and timber or light)end
  if c~=color then flush(x-1);first=c and x or nil;color=c end
 end
end
local stats=s:voxelBoxes({boxes=boxes,size=1/32,replace=true})
local file="blocktemplates/"..s.name.."_table.x"
local exported=s:exportVoxelX(file,"table",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={4,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={0.75,0.75,0.75},tabletopMeters=0.75},
 overview={eye=view({6,3,5}),lookat=view({3,0.3,2})},
 detail={eye=view({5.5,1.6,4}),lookat=view({4,0.35,2})}}
