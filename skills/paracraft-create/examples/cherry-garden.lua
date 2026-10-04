-- Six-meter cherry with branching miniature bark and native pink blossom blocks.
local s=createScene({name="cherry_garden",dimensions={9,7,8},terrainDepth=1})
s:group("path")
s:surface({position={7,0,0},dimensions={2,1,8},blockId=68})
s:group("tree")
s:box({position={3.25,0,3.25},dimensions={0.5,3,0.5},size=0.25,color="#725347"})
for _,tip in ipairs({{2,3.5,3},{4.75,3.5,4},{3.5,4,2.25}}) do
    s:line({from={3.5,2.25,3.5},to=tip,size=0.25,color="#725347",replace=true})
end
s:box({position={3.5,0,3.25},dimensions={0.25,2.25,0.25},size=0.25,color="#93715D",replace=true})
-- Whole native leaves cannot overwrite miniature branch carriers.
local wood={}
for _,m in ipairs(s:inspect().groups.tree.members) do
    local p=m.position;wood[(p[1]-s.origin[1])..","..(p[2]-s.origin[2])..","..(p[3]-s.origin[3])]=true
end
for y=3,5 do for x=1,6 do for z=1,6 do
    local a=((x+0.5-3.5)/2.8)^2+((y+0.5-4)/1.7)^2+((z+0.5-3.5)/2.4)^2
    local b=((x+0.5-5)/1.7)^2+((y+0.5-4.25)/1.4)^2+((z+0.5-4.25)/1.6)^2
    local notch=y==3 and x==1 and z==3
    if math.min(a,b)<=1 and not notch and not wood[x..","..y..","..z] then
        s:block({position={x,y,z},blockId=92})
    end
end end end
s:group("understory")
for _,p in ipairs({{1,4,113},{2,1,115},{5,5,113},{6,2,113},{4,1,115}}) do
    s:block({position={p[1],0,p[2]},blockId=p[3]})
end
for _,p in ipairs({{1.125,1.125},{1.5,1.625},{2.25,5.25},{5.5,1.5},{5.25,1.25}}) do
    s:block({position={p[1],0,p[2]},size=0.125,color="#EBC3D1"})
end
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
    overview={eye=view({12,8,12}),lookat=view({4,2.75,3.5})},
    detail={eye=view({7,3,-2}),lookat=view({3.5,2.5,3.5})}}
