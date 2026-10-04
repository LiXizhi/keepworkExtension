-- Half-meter decorative lantern: open frame, candle, stepped cap and loop handle.
local s=createScene({name="patio_lantern",dimensions={6,3,6},terrainDepth=1})
local metal,edge,wax,flame="#3C4B4C","#63716D","#E6D7AE","#E8AF56"
s:group("ground");s:surface({position={0,0,0},dimensions={6,1,5},blockId=81})
s:group("lantern")
local boxes={}
local function box(x,y,z,w,h,d,c)boxes[#boxes+1]={position={2+x/64,y/64,2+z/64},dimensions={w/64,h/64,d/64},color=c}end
box(-8,0,-8,16,2,16,metal)
box(-7,2,-7,14,1,14,edge)
for _,x in ipairs({-7,5})do for _,z in ipairs({-7,5})do box(x,3,z,2,16,2,metal)end end
-- Visible negative space, no opaque pane pretending to be transparent glass.
for _,y in ipairs({3,18})do
 for _,z in ipairs({-7,5})do box(-5,y,z,10,1,2,edge)end
 for _,x in ipairs({-7,5})do box(x,y,-5,2,1,10,edge)end
end
box(-3,3,-3,6,9,6,wax)
box(-1,12,-1,2,3,2,flame)
box(-8,19,-8,16,2,16,metal)
for level=0,3 do local radius=7-level;box(-radius,21+level,-radius,radius*2,1,radius*2,level%2==0 and edge or metal)end
box(-2,25,-2,4,1,4,metal)
box(-4,26,-1,1,5,2,metal);box(3,26,-1,1,5,2,metal)
box(-4,31,-1,8,1,2,edge)
local stats=s:voxelBoxes({boxes=boxes,size=1/64,replace=true})
local file="blocktemplates/"..s.name.."_lantern.x"
local exported=s:exportVoxelX(file,"lantern",{pivot={2,0,2}})
s:group("instance");local instance=s:model({position={4,0,2},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,geometryStats=stats,exported=exported,instance=instance,
 prop={filename=file,expectedMeters={0.25,0.5,0.25},emitsLight=false},
 overview={eye=view({6,3,5}),lookat=view({3,0.2,2})},
 detail={eye=view({5.5,1.2,4}),lookat=view({4,0.2,2})}}
