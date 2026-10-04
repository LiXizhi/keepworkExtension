-- Seven-meter conifer: slim 0.5 m color-voxel bark, native dark spruce foliage.
-- Native understory and a flush two-meter path; no model/asset export.
local s=createScene({name="conifer_garden",dimensions={9,8,8},terrainDepth=1})
s:group("path")
s:surface({position={7,0,0},dimensions={2,1,8},blockId=68})
s:group("tree")
s:box({position={3.25,0,3.25},dimensions={0.5,5.75,0.5},size=0.25,color="#5D4839"})
s:box({position={3.5,0,3.25},dimensions={0.25,5.5,0.25},size=0.25,color="#786048",replace=true})
-- Shrinking rings preserve a pointed silhouette; center stays in the bark carrier.
for _,tier in ipairs({{2,2.7},{3,2},{4,1.8},{5,1},{6,0}}) do
    local y,r=tier[1],tier[2]
    for x=-2,2 do for z=-2,2 do
        local inside=x*x+z*z<=r*r
        local nick=y==3 and x==-2 and z==0
        if inside and not nick and (y==6 or x~=0 or z~=0) then
            s:block({position={3+x,y,3+z},blockId=91})
        end
    end end
end
s:group("understory")
for _,p in ipairs({{1,2,114},{2,5,114},{5,3,114},{4,5,141},{2,1,141},{5,1,113},{1,5,113},{6,5,113}}) do
    s:block({position={p[1],0,p[2]},blockId=p[3]})
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
    overview={eye=view({12,9,13}),lookat=view({4,3,3})},
    detail={eye=view({7,3,-2}),lookat=view({3.5,2,3.5})}}
