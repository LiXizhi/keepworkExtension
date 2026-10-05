-- 1.5 × 0.9375 × 0.46875 m two-seat bench; open slats and a 0.4375 m seat.
local s=createScene({name="garden_bench",dimensions={7,3,6},terrainDepth=1})
local timber,light,metal="#A7815E","#BD9872","#454D50"
s:group("ground");s:surface({position={0,0,0},dimensions={7,1,5},blockId=12})
s:group("bench")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
-- Two narrow end frames, four feet and a lower longitudinal brace.
for _,x in ipairs({1.34375,2.59375})do
 for _,z in ipairs({1.78125,2.15625})do box({x,0,z},{0.0625,0.375,0.0625},metal)end
 box({x,0.34375,1.78125},{0.0625,0.03125,0.4375},metal)
 box({x,0.4375,1.75},{0.0625,0.5,0.0625},metal)
end
box({1.40625,0.1875,1.78125},{1.1875,0.0625,0.0625},metal)
for i=0,3 do box({1.25,0.375,1.75+i*0.125},{1.5,0.0625,0.09375},i%2==0 and timber or light)end
for i=0,5 do box({1.25,0.53125+i*0.0625,1.75},{1.5,0.03125,0.0625},i%2==0 and timber or light)end
box({1.25,0.90625,1.75},{1.5,0.03125,0.0625},timber)
local stats=s:voxelBoxes({boxes=boxes,size=1/32,replace=true})
local file="blocktemplates/"..s.name.."_bench.x"
local exported=s:exportVoxelX(file,"bench",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={5,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={1.5,0.9375,0.46875},seatMeters=0.4375},
 overview={eye=view({8,3.5,6}),lookat=view({3.5,0.35,2})},
 detail={eye=view({6.8,1.6,4}),lookat=view({5,0.45,2})}}
