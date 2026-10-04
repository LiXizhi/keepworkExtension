-- Human-scale 0.5 × 0.9375 × 0.5 m slatted chair; seat at 0.4375 m.
local s=createScene({name="garden_chair",dimensions={6,3,6},terrainDepth=1})
local timber,highlight,metal="#698F86","#85A49A","#454D50"
s:group("ground");s:surface({position={0,0,0},dimensions={6,1,5},blockId=12})
s:group("chair")
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
-- Slightly splayed narrow legs; leave the under-seat volume visually open.
for _,sx in ipairs({-1,1})do for _,sz in ipairs({-1,1})do
 for row=0,11 do
  local offset=math.floor((11-row)/4)/32
  box({2+sx*(0.15625+offset)-0.03125,row/32,2+sz*(0.15625+offset)-0.03125},{0.0625,0.03125,0.0625},metal)
 end
end end
for i=0,3 do box({1.75,0.375,1.75+i*0.125},{0.5,0.0625,0.09375},i%2==0 and timber or highlight)end
for _,x in ipairs({1.78125,2.15625})do box({x,0.4375,1.75},{0.0625,0.5,0.0625},metal)end
for i=0,5 do box({1.8125,0.53125+i*0.0625,1.75},{0.375,0.03125,0.0625},i%2==0 and timber or highlight)end
box({1.78125,0.90625,1.75},{0.4375,0.03125,0.0625},timber)
local stats=s:voxelBoxes({boxes=boxes,size=1/32,replace=true})
local file="blocktemplates/"..s.name.."_chair.x"
local exported=s:exportVoxelX(file,"chair",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={4,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={0.5,0.9375,0.5},seatMeters=0.4375},
 overview={eye=view({6,3,5}),lookat=view({3,0.35,2})},
 detail={eye=view({5.3,1.6,4}),lookat=view({4,0.45,2})}}
