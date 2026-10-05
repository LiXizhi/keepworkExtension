-- Compact native flower border: 4 x 4 m, no miniature plants or exports.
-- The bare-soil gaps and one-meter path are intentional, not missing geometry.
local s=createScene({name="flower_border",dimensions={4,2,4},terrainDepth=1})
s:group("path")
s:surface({position={0,0,0},dimensions={1,1,4},blockId="Gravel"})
s:group("soil")
s:surface({position={1,0,1},dimensions={2,1,1},blockId="Dirt"})
s:surface({position={1,0,2},dimensions={3,1,1},blockId="Dirt"})
s:group("flowers")
for _,p in ipairs({{1,0,1},{2,0,1}})do s:block({position=p,blockId="Red_Rose"})end
s:block({position={3,0,2},blockId="Yellow_Flower"})
s:group("grass")
s:block({position={1,0,2},blockId="TallGrass"})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do
 local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end
 groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}
end
return{name=s.name,origin=s.origin,groups=groups,designMeters={width=4,depth=4,pathWidth=1},
 nativePlants=4,groundBackups=9,bareSoilCells=1,
 overview={eye=s:cameraPoint({5,4,6}),lookat=s:cameraPoint({1.5,0.25,1.5})},
 detail={eye=s:cameraPoint({3.5,1.8,4}),lookat=s:cameraPoint({2,0.4,1.5})}}
