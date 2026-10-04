-- 1.75 m picnic table: editable color-only source and one scale-1 instance.
local s=createScene({name="picnic_table",dimensions={8,3,6},terrainDepth=1})
local timber,edge,support="#B18457","#88603F","#51483E"
s:group("ground")
s:surface({position={0,0,0},dimensions={8,1,4},blockId=12})
s:group("table")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
local x0,z0=1.125,1.25
-- Four tabletop planks, visible narrow slots, with darker end caps.
for i=0,3 do
 box({x0,0.75,z0+0.4375+i*0.15625},{1.75,0.0625,0.125},timber)
end
for _,x in ipairs({x0,x0+1.71875})do
 box({x,0.75,z0+0.4375},{0.03125,0.0625,0.59375},edge)
end
-- Two benches at 0.4375 m seat height, split planks and shared cross braces.
for _,z in ipairs({z0,z0+1.25})do
 for i=0,1 do box({x0,0.375,z+i*0.15625},{1.75,0.0625,0.125},timber)end
end
for _,x in ipairs({x0+0.25,x0+1.375})do
 box({x,0.3125,z0+0.09375},{0.125,0.0625,1.34375},support)
 -- Stepped A-frame legs taper toward the table without a solid skirt.
 for row=0,10 do
  local y=row*0.0625;local inset=row*0.03125
  box({x,y,z0+0.15625+inset},{0.125,0.0625,0.125},support)
  box({x,y,z0+1.25-inset},{0.125,0.0625,0.125},support)
 end
 box({x,0.6875,z0+0.4375},{0.125,0.0625,0.625},support)
end
box({x0+0.25,0.125,z0+0.703125},{1.25,0.09375,0.09375},support)
local geometryStats={calls=0,carrierWrites=0,expandedVoxels=0}
local function account(r)geometryStats.calls=geometryStats.calls+1;geometryStats.carrierWrites=geometryStats.carrierWrites+r.cells;geometryStats.expandedVoxels=geometryStats.expandedVoxels+r.voxels end
if s.voxelBoxes then account(s:voxelBoxes({boxes=boxes,size=1/32,replace=true}))
else for _,b in ipairs(boxes)do b.size=1/32;b.replace=true;account(s:box(b))end end
local file="blocktemplates/"..s.name.."_picnic.x"
local exported=s:exportVoxelX(file,"table",{pivot={2,0,2}})
s:group("instance")
local instance=s:model({position={5,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,exported=exported,instance=instance,geometryStats=geometryStats,
 prop={filename=file,expectedMeters={1.75,0.8125,1.53125},tabletopMeters=0.8125,seatMeters=0.4375},
 overview={eye=view({8,4,-2}),lookat=view({3.5,0.3,2})},
 detail={eye=view({7,1.8,-1}),lookat=view({5,0.4,2})}}
