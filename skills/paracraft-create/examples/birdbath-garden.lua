-- A 7 x 7 m seating garden, reusing two color-only scale-1 props.
local benchFile="blocktemplates/bench.x"
local bathFile="blocktemplates/bath.x"
local s=createScene({name="birdbath_garden",dimensions={7,3,7},terrainDepth=1})
s:requireModels({benchFile,bathFile})
s:group("ground")
s:surface({position={0,0,0},dimensions={7,1,7},blockId="Grass"})
s:surface({position={2,0,0},dimensions={2,1,7},blockId="StoneBrick"})
s:surface({position={4,0,4},dimensions={2,1,1},blockId="StoneBrick"})
s:group("bench")
local bench=s:model({position={2,0,1},offset={0,0,0.25},filename=benchFile,scale=1})
s:group("birdbath")
local bath=s:model({position={5,0,4},filename=bathFile,scale=1})
s:group("back_rail")
for x=1,5 do s:block({position={x,0,0},blockId="ColorFence",color="#F2EBDD"})end
s:group("hedges")
for _,x in ipairs({0,6})do for z=0,2 do s:block({position={x,0,z},blockId="Oak_Leaves"})end end
s:group("flower_clusters")
for _,p in ipairs({{0,4},{1,4},{0,5},{5,6},{6,6},{6,5}})do
 s:block({position={p[1],0,p[2]},blockId=(p[1]+p[2])%2==0 and "Yellow_Flower" or "Red_Rose"})
end
s:group("meadow")
for _,p in ipairs({{0,3},{1,6},{4,6},{6,3}})do s:block({position={p[1],0,p[2]},blockId="TallGrass"})end
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,models={bench,bath},reusedAssets={benchFile,bathFile},
 designMeters={width=7,depth=7,seat=0.4375,bathHeight=0.6875,bathWidth=0.75},decorativeWater=true,
 overview={eye=view({9,5.5,10}),lookat=view({3,0.4,3})},
 detail={eye=view({6.5,2.2,7}),lookat=view({4,0.4,3.5})}}
