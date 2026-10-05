-- Requires modelOffset and modelContactPlacement; supply verified scale-1 exports.
local tableFile="blocktemplates/table.x"
local lanternFile="blocktemplates/lantern.x"
local s=createScene({name="model_contact_demo",dimensions={6,3,6},terrainDepth=1})
s:requireModels({tableFile,lanternFile})
s:group("floor");s:surface({position={0,0,0},dimensions={6,1,5},blockId=68})
s:group("table");local tableRef=s:model({position={2,0,2},offset={0.375,0,0},filename=tableFile,scale=1})
s:group("lantern");local lanternRef=s:model({position={3,0,2},offset={-0.5,0.75,0},filename=lanternFile,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,tableRef=tableRef,lanternRef=lanternRef,
 overview={eye=view({5.5,2.5,4.5}),lookat=view({2.5,0.6,2})},
 detail={eye=view({4,1.6,3.5}),lookat=view({2.5,0.75,2})}}
