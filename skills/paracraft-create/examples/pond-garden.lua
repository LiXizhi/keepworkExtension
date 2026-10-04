-- Human-scale waterside garden. Native terrain/plants; color-only bench export.
local s=createScene({name="pond_garden",dimensions={12,3,11},terrainDepth=2})
local timber,metal="#A47851","#455759"
s:group("walk")
s:surface({position={0,0,0},dimensions={12,1,2},blockId=12})
local water={};local function key(x,z)return x..","..z end
for z=3,7 do for x=4,8 do if ((x-6)/2.6)^2+((z-5)/2.2)^2<=1 then water[key(x,z)]=true end end end
s:group("pond")
-- One group owns the bed, water and flush banks, preserving original soil.
s:terrain({position={3,-2,2},dimensions={7,1,7},blockId=68})
for z=2,8 do for x=3,9 do
    if water[key(x,z)] then s:surface({position={x,0,z},dimensions={1,1,1},blockId=76})
    elseif ((x-6)/3.3)^2+((z-5)/3)^2<=1.3 then
        s:surface({position={x,0,z},dimensions={1,1,1},blockId=(x+z)%3==0 and 12 or 4})
    end
end end
s:group("aquatic")
for _,p in ipairs({{5,0,4},{7,0,6}})do s:block({position=p,blockId=222,data=2})end
for _,p in ipairs({{4,0,2},{8,0,8},{9,0,5}})do s:block({position=p,blockId=161})end
s:group("planting")
local choices={113,113,114,116,115}
local plants=0
for z=2,9 do for x=0,11 do
    local h=(x*37+z*19+23)%101
    local bank=((x-6)/3.3)^2+((z-5)/3)^2
    -- Clear both bench footprints and water-side viewing gaps before scattering.
    if bank>1.8 and x>=4 and h<28 then
        s:block({position={x,0,z},blockId=choices[h%#choices+1]});plants=plants+1
    end
end end
s:group("bench")
local function box(p,d,c)s:box({position=p,dimensions=d,size=1/16,color=c})end
for _,x in ipairs({1.375,2.5})do for _,z in ipairs({4.3125,4.6875})do
    box({x,0,z},{0.0625,0.4375,0.0625},metal)
end end
for _,z in ipairs({4.25,4.4375,4.625})do box({1.25,0.4375,z},{1.5,0.0625,0.125},timber)end
for _,x in ipairs({1.25,2.6875})do box({x,0.5,4.25},{0.0625,0.4375,0.0625},metal)end
for _,y in ipairs({0.5625,0.6875,0.8125})do box({1.3125,y,4.25},{1.375,0.0625,0.0625},timber)end
local file="blocktemplates/"..s.name.."_bench.x"
local exported=s:exportVoxelX(file,"bench",{pivot={2,0,4.5}})
s:group("bench_instance")
local instance=s:model({position={2,0,8},filename=file,scale=1})
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,exported=exported,instance=instance,plants=plants,
    bench={filename=file,expectedMeters={1.5,0.9375,0.5}},
    overview={eye=view({6,13,4}),lookat=view({6,0,5})},
    detail={eye=view({-1,2,6}),lookat=view({3,0.4,5})}}
