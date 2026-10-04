-- Small stylized garden bird: ~0.31 m beak/body, ~0.4 m wingspan.
-- Four color-only meshes, mirrored wing roots and a separate animated tail.
local s=createScene({name="flapping_bird",dimensions={7,3,7}})
s:group("body")
s:ellipsoid({position={1.1875,0.125,1.125},dimensions={0.125,0.1875,0.21875},size=1/32,color="#66797A"})
s:ellipsoid({position={1.1875,0.25,1.0625},dimensions={0.125,0.125,0.125},size=1/32,color="#695747",replace=true})
s:ellipsoid({position={1.21875,0.15625,1.09375},dimensions={0.0625,0.09375,0.0625},size=1/32,color="#CEB38A",replace=true})
s:box({position={1.234375,0.296875,1.03125},dimensions={1/64,1/64,3/64},size=1/64,color="#D8AC6D",replace=true})
for _,x in ipairs({1.171875,1.3125}) do
    s:block({position={x,0.3125,1.078125},size=1/64,color="#292C2A"})
end
for _,x in ipairs({1.203125,1.25}) do
    s:box({position={x,0.09375,1.21875},dimensions={3/64,1/64,4/64},size=1/64,color="#9F794F"})
    s:box({position={x+1/64,0.109375,1.25},dimensions={1/64,1/64,1/64},size=1/64,color="#9F794F"})
end
local files={body="blocktemplates/"..s.name.."_body.x"}
s:exportVoxelX(files.body,"body",{pivot={1.25,0.21875,1.21875}})
for _,side in ipairs({"left","right"}) do
    s:group(side)
    local hinge=side=="left" and 2.5 or 3.25
    for x=0,8 do
        local lo=-3+math.floor((x+0.5)*2/9)
        local hi=5-math.floor((x+0.5)*5/9)
        for z=lo,hi do
            local px=side=="left" and hinge-(x+1)/64 or hinge+x/64
            local color=(x>=6 or z==hi) and "#405354" or (x<3 and "#AAB4A6" or "#718783")
            s:block({position={px,0.125,1.5+z/64},size=1/64,color=color})
        end
    end
    files[side]="blocktemplates/"..s.name.."_"..side..".x"
    s:exportVoxelX(files[side],side,{pivot={hinge,0.125+1/128,1.5}})
end
s:group("tail")
for x=-2,1 do
    local length=(x==-1 or x==0) and 6 or 5
    s:box({position={4.5+x/64,0.125,1.5},dimensions={1/64,2/64,length/64},size=1/64,color=x%2==0 and "#405354" or "#718783"})
end
files.tail="blocktemplates/"..s.name.."_tail.x"
s:exportVoxelX(files.tail,"tail",{pivot={4.5,0.125+1/64,1.5}})
s:group("movie")
s:movie({name="flap",position={0,0,6},duration=1})
local specs={
    {name="body",offset={0,0,0},expectedMeters={10/64,18/64,20/64}},
    {name="left",offset={-4/64,2/64,0},expectedMeters={9/64,1/64,9/64},axis={0,0,-1}},
    {name="right",offset={4/64,2/64,0},expectedMeters={9/64,1/64,9/64},axis={0,0,1}},
    {name="tail",offset={0,0,7/64},expectedMeters={4/64,2/64,6/64},axis={1,0,0}}
}
local actors,joints={},{}
for _,part in ipairs(specs) do
    local p={5+part.offset[1],0.625+part.offset[2],4+part.offset[3]}
    s:actor("flap",{name=part.name,filename=files[part.name],position=p,scale=1})
    local keys={}
    for _,k in ipairs({{0,15,0},{0.25,55,1/32},{0.5,15,0},{0.75,-25,-1/64},{1,15,0}}) do
        local values={position={p[1],p[2]+k[3],p[3]},anim=0}
        if part.axis then
            local degrees=part.name=="tail" and k[2]/4 or k[2]
            local half=degrees*math.pi/360
            local q={part.axis[1]*math.sin(half),part.axis[2]*math.sin(half),part.axis[3]*math.sin(half),math.cos(half)}
            values.bones={root={rotation=q}};keys[#keys+1]={time=k[1],rotation=q}
        end
        s:keyframe("flap",part.name,k[1],values)
    end
    actors[#actors+1]={name=part.name,expectedMeters=part.expectedMeters,bone=part.axis and "root",rotationKeys=keys}
    if part.name~="body" then joints[#joints+1]={actor=part.name,parent="body",offset=part.offset} end
end
s:seek("flap",0)
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
return {name=s.name,origin=s.origin,groups=groups,blocksize=one[1]-base[1],
    overview={eye=view({5.7,1.7,3.1}),lookat=view({5,0.625,4})},
    detail={eye=view({5.36,1.16,3.62}),lookat=view({5,0.625,4})},
    animation={moviePosition=s:position({0,0,6}),times={0,0.125,0.25,0.5,0.75,1},
        motion="articulated",actors=actors,joints=joints}}
