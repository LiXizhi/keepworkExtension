-- 2.25 m striped canvas parasol, 2.375 m overall; color-only reusable geometry.
local s=createScene({name="garden_parasol",dimensions={9,4,7},terrainDepth=1})
local cream,teal,rim,metal,finial="#E6DBBE","#6B938A","#54766F","#565C57","#A07B50"
s:group("ground");s:surface({position={0,0,0},dimensions={9,1,6},blockId=12})
s:group("parasol")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
box({2.75,0,2.75},{0.5,0.0625,0.5},metal)
box({2.8125,0.0625,2.8125},{0.375,0.0625,0.375},metal)
box({2.9375,0.125,2.9375},{0.125,2.0625,0.125},metal)
-- Eight broad panels and a thin border; merge equal-height/color row spans.
local canvasCells=0
for z=-18,17 do
 local first,height,color
 local function flush(last)
  if first then box({3+first/16,height/16,3+z/16},{(last-first+1)/16,1/16,1/16},color)end
 end
 for x=-18,18 do
  local radius=math.sqrt((x+0.5)^2+(z+0.5)^2)/18
  local h,c
  if x<18 and radius<=1 then
   h=35-math.floor(radius*5)
   local panel=math.floor((math.atan2(z+0.5,x+0.5)+math.pi)/(math.pi/4))
   c=radius>0.92 and rim or (panel%2==0 and cream or teal)
   canvasCells=canvasCells+1
  end
  if h~=height or c~=color then flush(x-1);first=h and x or nil;height=h;color=c end
 end
end
box({2.9375,2.25,2.9375},{0.125,0.125,0.125},finial)
local stats={calls=0,carrierWrites=0,expandedVoxels=0,boxes=#boxes,canvasCells=canvasCells}
local function account(r)stats.calls=stats.calls+1;stats.carrierWrites=stats.carrierWrites+r.cells;stats.expandedVoxels=stats.expandedVoxels+r.voxels end
if s.voxelBoxes then account(s:voxelBoxes({size=1/16,boxes=boxes,replace=true}))
else for _,b in ipairs(boxes)do b.size=1/16;b.replace=true;account(s:box(b))end end
local file="blocktemplates/"..s.name.."_parasol.x"
local exported=s:exportVoxelX(file,"parasol",{pivot={3,0,3}})
s:group("instance");local instance=s:model({position={7,0,3},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={2.25,2.375,2.25},edgeClearanceMeters=1.875},
 overview={eye=view({10,5,-1}),lookat=view({5,1,3})},
 detail={eye=view({10,3,-1}),lookat=view({7,1.25,3})}}
