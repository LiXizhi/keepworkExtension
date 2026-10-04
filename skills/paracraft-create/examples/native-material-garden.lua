-- Native world materials; no export/save. Fixed hash keeps scatter repeatable.
local s=createScene({name="native_material_garden",dimensions={12,5,10},terrainDepth=1})
s:group("path")
s:surface({position={4,0,0},dimensions={2,1,10},blockId=12})
-- Ground remains solid beneath the one-cell-deep irregular puddle.
s:group("puddle")
for _,p in ipairs({{8,2},{9,2},{7,3},{8,3},{9,3},{10,3},{8,4},{9,4}}) do
    s:surface({position={p[1],0,p[2]},dimensions={1,1,1},blockId=76})
end
s:group("lily")
s:block({position={8,0,3},blockId=222,data=2})
s:group("meadow")
local choices={113,113,113,114,116,115}
for x=0,3 do for z=0,8 do
    local h=(x*37+z*19+23)%101
    if h<45 then s:block({position={x,0,z},blockId=choices[h%#choices+1]}) end
end end
s:group("bank")
for _,p in ipairs({{7,2},{10,4}}) do s:block({position={p[1],0,p[2]},blockId=161}) end
s:group("textile")
s:block({position={7,0,7},blockId=133,color="#B67F67"})
s:block({position={8,0,7},blockId=19})
s:block({position={9,0,7},blockId=234,color="#B67F67",data=0})
s:block({position={10,0,7},blockId=245,data=0})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do
    local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end
    groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}
end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)
    local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i]) end;return v
end
return {name=s.name,origin=s.origin,groups=groups,
    overview={eye=view({15,9,15}),lookat=view({5,0,4})},
    detail={eye=view({12,3,10}),lookat=view({8.5,0.5,7})}}
