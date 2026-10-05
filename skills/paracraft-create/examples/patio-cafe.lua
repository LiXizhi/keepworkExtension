-- Human-scale two-table terrace; reuse four bottom-pivot color-only exports.
local tableFile="blocktemplates/table.x"
local chairFile="blocktemplates/chair.x"
local plantFile="blocktemplates/plant.x"
local lanternFile="blocktemplates/lantern.x"
local rail="#FFFFFF"
local s=createScene({name="patio_cafe",dimensions={10,3,8},terrainDepth=1})
s:requireModels({tableFile,chairFile,plantFile,lanternFile})
s:group("floor")
s:surface({position={0,0,0},dimensions={10,1,8},blockId=81})
s:surface({position={1,0,1},dimensions={8,1,5},blockId=68})
s:group("furniture")
local models={}
local function model(p,o,file,facing)
 local ref=s:model({position=p,offset=o,filename=file,scale=1,facing=facing or 0});models[#models+1]=ref
end
for _,x in ipairs({3,6})do
 model({x,0,3},{0.375,0,0},tableFile)
 model({x+1,0,3},{-0.5,0.75,0},lanternFile)
 model({x,0,2},{0.375,0,0.25},chairFile)
 model({x,0,4},{0.375,0,-0.25},chairFile,math.pi)
end
s:group("planters")
for _,p in ipairs({{1,0,6},{8,0,6},{8,0,1}})do model(p,{0,0,0},plantFile)end
s:group("rail")
for x=0,9 do s:block({position={x,0,7},blockId=267,color=rail})end
s:group("flowers")
for _,p in ipairs({{0,0,2},{0,0,4},{9,0,3},{9,0,5}})do s:block({position=p,blockId=115})end
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,models=models,reusedAssets={tableFile,chairFile,plantFile,lanternFile},
 designMeters={width=10,depth=8,tableHeight=0.75,chairSeat=0.4375,lanternHeight=0.5,planterHeight=0.875},
 overview={eye=view({10.5,6,10}),lookat=view({5,0.5,3.5})},
 detail={eye=view({5.5,2,5.5}),lookat=view({3.875,0.6,3.5})}}
