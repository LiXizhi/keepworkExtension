-- 5 x 5 m cottage shell, 3 m walls, 5.5 m ridge; 1 x 2 m open native entrance.
-- Unfurnished, with a flush floor/path. Native mixed materials; no asset export.
local s=createScene({name="timber_cottage",dimensions={7,6,8},terrainDepth=1})
local wall,roof,glass,rug="#E5DDC8","#8C5B48","#91B9B9","#BE997C"
s:group("floor");s:surface({position={1,0,2},dimensions={5,1,5},blockId="Oak_Wood_Planks"})
s:group("path");s:surface({position={3,0,0},dimensions={1,1,2},blockId="Gravel"})
local function window(x,z)return (z==2 and(x==2 or x==4))or(z==4 and(x==1 or x==5))or(z==6 and x==3)end
s:group("walls")
for x=1,5 do for z=2,6 do if x==1 or x==5 or z==2 or z==6 then for y=0,2 do
 if not(x==3 and z==2 and y<2)and not(y==1 and window(x,z))then
  local p={position={x,y,z},blockId="White_Wool",color=wall}
  if(x==1 or x==5)and(z==2 or z==6)then p.blockId="Oak_Wood";p.color=nil end
  s:block(p)
 end
end end end end
s:group("windows")
for _,p in ipairs({{2,1,2},{4,1,2},{1,1,4},{5,1,4},{3,1,6}})do s:block({position=p,blockId="GlassPane",color=glass})end
s:group("entry");s:door({position={3,0,2},data=1,open=true})
s:group("gables")
for _,z in ipairs({2,6})do
 s:box({position={2,3,z},dimensions={3,1,1},blockId="White_Wool",color=wall})
 s:block({position={3,4,z},blockId="White_Wool",color=wall})
end
s:group("roof")
for z=1,7 do
 for _,v in ipairs({{1,3,1},{2,4,1},{4,4,2},{5,3,2}})do s:block({position={v[1],v[2],z},blockId="ColorBlock_Stairs",color=roof,data=v[3]})end
 s:block({position={3,5,z},blockId="ColorBlock_Slab",color=roof,data=0})
end
s:group("rug");s:box({position={3,0,3},dimensions={1,1,2},blockId="White_Carpet",color=rug})
s:group("flowers")
s:block({position={1,0,0},blockId="Red_Rose"});s:block({position={5,0,0},blockId="Yellow_Flower"})
wait(2)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,groundBackups=27,
 designMeters={houseWidth=5,houseDepth=5,interiorWidth=3,interiorDepth=3,wallHeight=3,ridgeHeight=5.5,doorHeight=2},
 overview={eye=s:cameraPoint({10,6,-4}),lookat=s:cameraPoint({3,2,4})},
 detail={eye=s:cameraPoint({3,1.8,0}),lookat=s:cameraPoint({3,1.2,4})},
 side={eye=s:cameraPoint({-4,4,10}),lookat=s:cameraPoint({3,2,4})}}
