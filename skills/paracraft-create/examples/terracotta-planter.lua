-- 0.5 m leafy patio planter, 0.875 m tall; hollow pot with soil and stem.
local s=createScene({name="terracotta_planter",dimensions={6,3,6},terrainDepth=1})
local clay,lip,soil,stem,leaf,light="#B76E4D","#D38D65","#554338","#69754A","#52784C","#77945C"
s:group("ground");s:surface({position={0,0,0},dimensions={6,1,5},blockId=12})
s:group("plant")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
-- Merge contiguous same-color row spans before touching native carrier cells.
local function row(y,z,first,last,choose)
 local start,color
 local function flush(x)if start then box({2+start/32,y/32,2+z/32},{(x-start)/32,1/32,1/32},color)end end
 for x=first,last+1 do
  local c=x<=last and choose(x)or nil
  if c~=color then flush(x);start=c and x or nil;color=c end
 end
end
for y=0,11 do
 local radius=y>=10 and 7.5 or 5+y*0.25
 for z=-8,7 do row(y,z,-8,7,function(x)
  local r=math.sqrt((x+0.5)^2+(z+0.5)^2)
  if r<=radius and (y<2 or r>=radius-1.25)then return y>=10 and lip or clay end
  if y==9 and r<radius-1.25 then return soil end
 end)end
end
box({1.96875,0.3125,1.96875},{0.0625,0.25,0.0625},stem)
for y=16,27 do for z=-8,7 do row(y,z,-8,7,function(x)
 local dx,dz=(x+0.5)/8,(z+0.5)/8;local dy=(y+0.5-22)/6
 if dx*dx+dy*dy+dz*dz<=1 then return y>=23 and z<0 and light or leaf end
end)end end
local stats=s:voxelBoxes({boxes=boxes,size=1/32,replace=true})
local file="blocktemplates/"..s.name.."_plant.x"
local exported=s:exportVoxelX(file,"plant",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={4,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={0.5,0.875,0.5},potHeightMeters=0.375},
 overview={eye=view({6,3,5}),lookat=view({3,0.4,2})},
 detail={eye=view({5.5,1.6,4}),lookat=view({4,0.4,2})}}
