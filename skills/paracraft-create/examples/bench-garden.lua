-- 5 × 6 m pocket garden, native vegetation and reused human-scale color props.
local s=createScene({name="bench_garden",dimensions={5,3,6},terrainDepth=1})
s:requireModels({"blocktemplates/bench.x","blocktemplates/plant.x"})
s:group("ground")
s:surface({position={0,0,0},dimensions={5,1,6},blockId="Grass"})
s:surface({position={1,0,0},dimensions={3,1,6},blockId="StoneBrick"})
s:group("back_rail")
for x=1,3 do s:block({position={x,0,0},blockId="ColorFence",color="#F2EBDD"})end
s:group("seating")
s:model({position={2,0,1},offset={0,0,0.25},filename="blocktemplates/bench.x",scale=1})
s:group("planters")
for _,x in ipairs({1,3})do s:model({position={x,0,3},filename="blocktemplates/plant.x",scale=1})end
s:group("flowers")
for _,x in ipairs({0,4})do
 s:block({position={x,0,1},blockId="Red_Rose"})
 s:block({position={x,0,3},blockId="Yellow_Flower"})
end
s:group("meadow")
for _,p in ipairs({{0,2},{0,4},{4,2},{4,5}})do s:block({position={p[1],0,p[2]},blockId="TallGrass"})end
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,
 overview={eye=view({7,4,9}),lookat=view({2,0.5,2.5})},
 detail={eye=view({4.5,1.8,5}),lookat=view({2,0.5,1.5})}}
