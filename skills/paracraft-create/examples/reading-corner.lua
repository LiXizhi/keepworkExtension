-- Open cutaway room; native textiles/glazing surround reusable color-only props.
local benchFile="blocktemplates/bench.x"
local plantFile="blocktemplates/plant.x"
local s=createScene({name="reading_corner",dimensions={4,3,4},terrainDepth=1})
s:requireModels({benchFile,plantFile})
s:group("floor")
s:surface({position={0,0,0},dimensions={4,1,4},blockId="Oak_Wood_Planks"})
s:group("walls")
for x=0,3 do for y=0,2 do
 if not(x==2 and y==1)then s:block({position={x,y,0},color="#E5DDCA"})end
end end
s:box({position={0,0,1},dimensions={1,3,3},color="#E5DDCA"})
s:group("window")
s:block({position={2,1,0},blockId="GlassPane",color="#9EC1C4",data=0})
s:group("rug")
s:box({position={1,0,2},dimensions={3,1,2},blockId="White_Carpet",color="#C39B7B",data=0})
s:box({position={2,0,2},dimensions={1,1,2},blockId="White_Carpet",color="#7EA79B",data=0,replace=true})
s:group("bench")
local bench=s:model({position={2,0,1},offset={0,0,0.125},filename=benchFile,scale=1,facing=math.pi})
s:group("plant")
local plant=s:model({position={1,0,1},filename=plantFile,scale=1,facing=0})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,modelReferences=info.models,
 designMeters={width=4,depth=4,wallHeight=3,seat=0.4375,plantHeight=0.875,rugWidth=3,rugDepth=2},
 overview={eye=s:cameraPoint({6,4.2,6}),lookat=s:cameraPoint({1.5,0.8,1.5})},
 detail={eye=s:cameraPoint({4,1.8,5}),lookat=s:cameraPoint({1.8,0.5,1.6})}}
