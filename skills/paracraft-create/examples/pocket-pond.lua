-- 4 x 4 m garden; 2 x 2 m contained native water, flush with surrounding ground.
-- Native plants/materials only: no BMax exports, miniature carriers or raised floor.
local s=createScene({name="pocket_pond",dimensions={4,2,4},terrainDepth=2})
s:group("path")
s:surface({position={0,0,0},dimensions={1,1,4},blockId="Gravel"})
s:group("basin")
-- Solid bed first; the existing solid ground on every side forms the banks.
s:terrain({position={1,-2,1},dimensions={2,1,2},blockId="StoneBrick"})
s:surface({position={1,0,1},dimensions={2,1,2},blockId="Still_Water"})
s:group("aquatic")
s:block({position={1,0,1},blockId="LilyPad",data=2})
s:group("planting")
s:block({position={3,0,1},blockId="Fern"})
s:block({position={3,0,2},blockId="TallGrass"})
s:block({position={1,0,3},blockId="Yellow_Flower"})
wait(2)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do
 local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end
 groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}
end
return{name=s.name,origin=s.origin,groups=groups,
 designMeters={width=4,depth=4,pondWidth=2,pondDepth=2,waterDepth=1,pathWidth=1},
 nativePlants=4,groundBackups=12,nativeWater=true,
 overview={eye=s:cameraPoint({5,4,5}),lookat=s:cameraPoint({1.5,0,1.5})},
 detail={eye=s:cameraPoint({3.5,2.3,4.5}),lookat=s:cameraPoint({1.8,0,1.8})}}
