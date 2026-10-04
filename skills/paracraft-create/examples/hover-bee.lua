-- Stylized bee: 0.75 m body, ~1 m wingspan. Explicitly exports a single color mesh .x.
-- This first clip moves the rigid whole animal; articulated wing flapping is separate.
local s=createScene({name="hover_bee",dimensions={9,5,9}})
s:group("bee")
s:box({position={1,0,1},dimensions={0.75,0.375,0.5},size=0.125,color="#E3B849"})
s:box({position={1.25,0,1},dimensions={0.125,0.375,0.5},size=0.125,color="#443C32",replace=true})
s:box({position={1.5,0,1},dimensions={0.125,0.375,0.5},size=0.125,color="#443C32",replace=true})
for _,z in ipairs({0.75,1.5}) do
    s:box({position={1.125,0.375,z},dimensions={0.5,0.125,0.25},size=0.125,color="#DCE6DE"})
end
for _,z in ipairs({1,1.375}) do
    s:block({position={1.625,0.25,z},size=0.125,color="#302D29",replace=true})
    s:box({position={1.625,0.375,z},dimensions={0.125,0.125,0.125},size=0.125,color="#443C32"})
end
local asset="blocktemplates/"..s.name.."_bee.x"
local exported=s:exportVoxelX(asset,"bee")
s:group("reloaded")
s:model({position={5,0,7},filename=asset,scale=1})
s:group("movie")
s:movie({name="hover",position={0,0,7},duration=2})
s:actor("hover",{name="bee",filename=asset,position={5,1,4},scale=1})
for _,k in ipairs({{0,1,0},{0.5,1.25,0.08},{1,1,0},{1.5,0.875,-0.08},{2,1,0}}) do
    s:keyframe("hover","bee",k[1],{position={5,k[2],4},roll=k[3],anim=0})
end
s:seek("hover",0)
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
return {name=s.name,origin=s.origin,groups=groups,asset=asset,exported=exported,
    overview={eye=view({7,3,6}),lookat=view({5,1.25,4})},
    detail={eye=view({6.5,2,5.5}),lookat=view({5,1.25,4})},
    animation={moviePosition=s:position({0,0,7}),times={0,0.5,1,1.5,2},actor="bee",expectedMeters={0.75,0.5,1}}}
