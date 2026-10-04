-- ~4.25 m open pergola; 2.5 m visible, 2 m carrier collision headroom.
local s=createScene({name="garden_pergola",dimensions={8,4,8},terrainDepth=1})
local timber,leaf,stem,rose,highlight,paving="#FFFFFF","#5E824C","#3F6240","#C67998","#F1C6D2","#ADA391"
s:group("floor")
s:surface({position={1,0,1},dimensions={6,1,6},blockId=81})
s:surface({position={3,0,0},dimensions={2,1,8},blockId=68})
-- An upper half slab replaces the supporting ground; its top stays at y=0.
s:surface({position={0,0,2},dimensions={1,1,4},blockId=281,color=paving,data=1})
s:group("frame")
local function box(p,d,c,replace)s:box({position=p,dimensions=d,size=1/16,color=c,replace=replace})end
for _,x in ipairs({2,5})do for _,z in ipairs({2,5})do
    s:block({position={x,0,z},blockId=267,color=timber})
    box({x+0.375,1,z+0.375},{0.25,1.5,0.25},timber)
end end
for _,z in ipairs({2.375,5.375})do box({1.875,2.5,z},{4.25,0.1875,0.25},timber)end
for _,x in ipairs({2,2.75,3.5,4.25,5,5.75})do box({x,2.6875,1.875},{0.125,0.125,4.25},timber)end
-- Climber detail shares the miniature frame carriers, without overwriting wood.
for _,z in ipairs({2,5})do
    box({2.25,1,z+0.4375},{0.0625,1.5,0.0625},stem)
    for _,y in ipairs({1.125,1.375,1.75,2.125})do box({2.125,y,z+0.4375},{0.125,0.125,0.0625},leaf)end
    for _,y in ipairs({1.5,2})do
        box({2.125,y,z+0.3125},{0.1875,0.1875,0.1875},rose,true)
        box({2.125,y+0.0625,z+0.3125},{0.0625,0.0625,0.0625},highlight,true)
    end
end
s:group("beds")
s:surface({position={7,0,1},dimensions={1,1,6},blockId=55})
for _,p in ipairs({{7,0,1,115},{7,0,3,116},{7,0,5,115},{0,0,6,114},{6,0,7,113}})do
    s:block({position={p[1],p[2],p[3]},blockId=p[4]})
end
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return {name=s.name,origin=s.origin,groups=groups,visibleHeadroomMeters=2.5,collisionHeadroomMeters=2,frameMeters={4.25,2.8125,4.25},
    overview={eye=view({10,6,-2}),lookat=view({3.5,1.2,3.5})},
    detail={eye=view({3.5,1.6,-0.5}),lookat=view({3.5,1.5,4})}}
