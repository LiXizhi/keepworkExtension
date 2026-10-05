-- Meter-scale native timber entrances; both door cells belong to one named group.
local s=createScene({name="doorway",dimensions={6,3,4},terrainDepth=1})
s:group("floor")
s:surface({position={0,0,1},dimensions={6,1,2},blockId="Oak_Wood_Planks"})
s:group("frames")
for _,x in ipairs({0,2,3,5})do s:box({position={x,0,1},dimensions={1,2,1},blockId="Oak_Wood_Planks"})end
s:box({position={0,2,1},dimensions={6,1,1},blockId="Oak_Wood_Planks"})
s:block({position={1,1,2},blockId="GlassPane",color="#AAC9C9"})
s:group("entries")
local closed=s:door({position={1,0,1},data=1})
local opened=s:door({position={4,0,1},data=1,open=true})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,closedDoor=closed,openDoor=opened,
 doorMeters={width=1,height=2},groundBackups=12,
 overview={eye=s:cameraPoint({6,3,-3}),lookat=s:cameraPoint({2.5,1,1})},
 detail={eye=s:cameraPoint({2.8,1.9,-1.5}),lookat=s:cameraPoint({2.5,1,1})}}
