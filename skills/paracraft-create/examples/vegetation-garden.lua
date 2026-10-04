-- 10 x 7 x 8 meters; no saving/exporting. Change name to create another garden.
local s=createScene({name="vegetation_garden",dimensions={10,7,8},terrainDepth=1})
s:group("path")
s:surface({position={5,0,0},dimensions={2,1,8},blockId=68})

-- Native world tree. Canopy chamfers and offset upper tier break box symmetry.
s:group("tree")
s:box({position={2,0,2},dimensions={1,4,1},blockId=98})
for _,tier in ipairs({{3,1,3},{4,0,5},{5,1,3}}) do
    local y,lo,width=tier[1],tier[2],tier[3]
    for x=lo,lo+width-1 do for z=lo,lo+width-1 do
        local corner=(x==lo or x==lo+width-1) and (z==lo or z==lo+width-1)
        if not corner and not (y==3 and x==2 and z==2) then
            s:block({position={x,y,z},blockId=86})
        end
    end end
end
s:block({position={3,5,3},blockId=86})

-- All tiny parts in this bed share one ownership group for voxel carriers.
s:group("flowers")
local function voxel(x,y,z,color)
    s:block({position={x,y,z},size=0.25,color=color})
end
local function flower(x,z,height,color)
    for y=0,height-0.25,0.25 do voxel(x,y,z,"#438448") end
    for _,d in ipairs({{-0.25,0},{0.25,0},{0,-0.25},{0,0.25}}) do
        voxel(x+d[1],height,z+d[2],color)
    end
    voxel(x,height,z,"#F4D16A")
end
flower(7.5,1.5,0.5,"#E7819E")
flower(8.5,2.5,0.75,"#ECE4CE")
flower(7.75,3.75,0.5,"#E7819E")
flower(8.75,5.25,0.75,"#ECE4CE")
flower(7.5,6.5,0.5,"#E7819E")
for _,p in ipairs({{7.25,2.75},{8.75,1},{8.5,4.5},{7.25,5.5},{8.75,6.75}}) do
    -- Slender unequal blades instead of two floating quarter-meter cubes.
    s:box({position={p[1],0,p[2]},dimensions={0.125,0.375,0.125},size=0.125,color="#527C3A"})
    s:box({position={p[1]+0.125,0,p[2]+0.125},dimensions={0.125,0.5,0.125},size=0.125,color="#70974C"})
    s:box({position={p[1]+0.25,0,p[2]},dimensions={0.125,0.25,0.125},size=0.125,color="#608B43"})
end
-- Allow native chunk meshes to catch up before the first visual check.
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do
    local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end
    groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}
end
-- Camera may sit outside construction bounds: derive native units from legal
-- scene points, never enlarge the build merely to accommodate a viewpoint.
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function cameraPoint(p)
    local result={};for i=1,3 do result[i]=base[i]+p[i]*(one[i]-base[i]) end
    return result
end
return {name=s.name,origin=s.origin,groups=groups,
    overview={eye=cameraPoint({14,9,14}),lookat=cameraPoint({5,3,4})},
    detail={eye=s:toWorld({9,2,7}),lookat=s:toWorld({8,0.5,4})}}
