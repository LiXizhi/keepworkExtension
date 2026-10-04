-- Butterfly: ~0.125 m wingspan, 0.0625 m body; 1/128 m color voxels.
-- Three rigid meshes retain editable sources; wing articulation lives in the movie.
local s=createScene({name="flapping_butterfly",dimensions={6,3,6}})
s:group("body")
s:box({position={1.125-1/128,0.125-1/128,1.125-4/128},dimensions={2/128,2/128,8/128},size=1/128,color="#40332B"})
for _,x in ipairs({1.125-2/128,1.125+1/128}) do
    s:block({position={x,0.125,1.125-4/128},size=1/128,color="#E9CB85"})
    s:box({position={x,0.125+1/128,1.125-6/128},dimensions={1/128,1/128,3/128},size=1/128,color="#40332B"})
end
local files={};local extents={}
for _,side in ipairs({"left","right"}) do
    s:group(side)
    local hinge=side=="left" and 2.5 or 3.25
    local minx,minz,maxx,maxz=99,99,-99,-99
    for x=0,7 do for z=-5,4 do
        local fore=((x+0.5-3.2)/3.8)^2+((z+0.5+2)/3.4)^2
        local hind=((x+0.5-2.5)/3)^2+((z+0.5-2)/2.5)^2
        local edge=math.min(fore,hind)
        if edge<=1 then
            local dark=edge>0.73 or math.abs(z+0.6*x)<0.55
            local color=dark and "#40332B" or (x<3 and "#F4C75A" or "#E59334")
            if dark and x>=4 and z%3==0 then color="#EEE0BC" end
            local px=side=="left" and hinge-(x+1)/128 or hinge+x/128
            s:block({position={px,0.125,1.5+z/128},size=1/128,color=color})
            minx=math.min(minx,x);minz=math.min(minz,z);maxx=math.max(maxx,x);maxz=math.max(maxz,z)
        end
    end end
    files[side]="blocktemplates/"..s.name.."_"..side..".x"
    s:exportVoxelX(files[side],side,{pivot={hinge,0.125+1/256,1.5}})
    extents[side]={(maxx-minx+1)/128,1/128,(maxz-minz+1)/128}
end
files.body="blocktemplates/"..s.name.."_body.x"
s:exportVoxelX(files.body,"body",{pivot={1.125,0.125,1.125}})
s:group("movie")
s:movie({name="flutter",position={0,0,5},duration=1})
s:actor("flutter",{name="body",filename=files.body,position={4,0.5,3},scale=1})
local actors={{name="body",expectedMeters={4/128,3/128,10/128}}}
for _,side in ipairs({"left","right"}) do
    local sign=side=="left" and -1 or 1
    s:actor("flutter",{name=side,filename=files[side],position={4+sign/128,0.5,3},scale=1})
    local keys={}
    for _,k in ipairs({{0,20},{0.25,70},{0.5,20},{0.75,-10},{1,20}}) do
        local angle=sign*k[2]*math.pi/180
        local q={0,0,math.sin(angle/2),math.cos(angle/2)}
        s:keyframe("flutter",side,k[1],{anim=0,bones={root={rotation=q}}})
        keys[#keys+1]={time=k[1],rotation=q}
    end
    actors[#actors+1]={name=side,expectedMeters=extents[side],bone="root",rotationKeys=keys}
end
s:seek("flutter",0)
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
    overview={eye=view({4.25,0.85,2.8}),lookat=view({4,0.5,3})},
    detail={eye=view({4.06,0.725,2.825}),lookat=view({4,0.5,3})},
    animation={moviePosition=s:position({0,0,5}),times={0,0.125,0.25,0.5,0.75,1},
        motion="articulated",actors=actors}}
