-- Requires modelDefaultFacing. Compare omitted zero facing with explicit pi.
-- Review the selected world-local model; this example saves/exports nothing.
local modelFile="blocktemplates/bench.x"
local s=createScene({name="model_direction",dimensions={6,3,4},terrainDepth=1})
s:requireModels({modelFile})
s:group("floor")
s:surface({position={0,0,0},dimensions={6,1,4},blockId="StoneBrick"})
s:group("default_direction")
s:model({position={1,0,1},filename=modelFile,scale=1})
s:group("opposite_direction")
s:model({position={4,0,1},filename=modelFile,scale=1,facing=math.pi})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
assert(#info.models==2 and info.models[1].facing==0,"default model direction changed")
assert(math.abs(info.models[2].facing-math.pi)<0.000001,"explicit model direction changed")
return{name=s.name,origin=s.origin,groups=groups,modelReferences=info.models,
 overview={eye=s:cameraPoint({8,4,6}),lookat=s:cameraPoint({2.5,0.4,1.5})},
 detail={eye=s:cameraPoint({5,1.6,4}),lookat=s:cameraPoint({2.5,0.4,1})}}
