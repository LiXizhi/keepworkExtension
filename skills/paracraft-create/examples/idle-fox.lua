-- Stylized young fox: ~0.75 m nose-to-tail, ~0.44 m ear height, 1/64 m voxels.
-- Two color-only scale-1 meshes and a root-bone tail sway; legs remain planted.
local s=createScene({name="idle_fox",dimensions={7,3,7}})
local u=1/64
local fur,cream,dark,inner="#C86F38","#EADBC0","#343039","#A55B55"
local function grid()
    local rows={};local lo={999,999,999};local hi={-999,-999,-999}
    local function put(x,y,z,color)
        local key=y..","..z;rows[key]=rows[key] or {y=y,z=z,cells={}};rows[key].cells[x]=color
        for i,n in ipairs({x,y,z}) do lo[i]=math.min(lo[i],n);hi[i]=math.max(hi[i],n) end
    end
    local function box(a,b,color)
        for z=a[3],b[3] do for y=a[2],b[2] do for x=a[1],b[1] do put(x,y,z,color) end end end
    end
    local function flush(base)
        for z=lo[3],hi[3] do for y=lo[2],hi[2] do
            local row=rows[y..","..z];local x=lo[1]
            while row and x<=hi[1] do
                local color=row.cells[x]
                if color then
                    local last=x;while row.cells[last+1]==color do last=last+1 end
                    s:box({position={base[1]+x*u,base[2]+y*u,base[3]+z*u},dimensions={(last-x+1)*u,u,u},size=u,color=color})
                    x=last+1
                else x=x+1 end
            end
        end end
        return {(hi[1]-lo[1]+1)*u,(hi[2]-lo[2]+1)*u,(hi[3]-lo[3]+1)*u}
    end
    return put,box,flush
end
s:group("body")
local put,box,flush=grid()
for z=-8,11 do for y=8,18 do for x=-4,4 do
    if (x/4.5)^2+((y-13)/5.5)^2+((z-1.5)/10.5)^2<=1 then put(x,y,z,fur) end
end end end
-- Four separated legs, dark stockings and wider toes; preserve daylight below belly.
for _,x in ipairs({-4,2}) do for _,z in ipairs({-6,7}) do
    box({x,0,z},{x+1,11,z+2},fur)
    box({x,0,z},{x+1,4,z+2},dark)
    box({x-1,0,z-1},{x+1,1,z+2},dark)
end end
-- Neck/head, a tapered cream muzzle and a single dark nose.
box({-3,13,-9},{3,19,-5},fur)
box({-4,16,-13},{4,22,-7},fur)
box({-3,14,-11},{3,16,-7},cream)
for z=-18,-14 do
    local radius=math.min(2,math.floor((z+18)/2)+1)
    box({-radius,16,z},{radius,18,z},cream)
end
box({-1,17,-18},{1,18,-18},dark)
-- Paired triangular ears and inset warm centers, eyes visible on both sides.
for _,side in ipairs({-1,1}) do
    for y=23,27 do
        local width=math.max(0,2-math.floor((y-23)/2))
        for x=-width,width do for z=-11,-9 do put(side*3+x,y,z,fur) end end
        if y<=25 then put(side*3,y,-11,inner) end
    end
    put(side*5,20,-12,dark);put(side*5,20,-11,dark)
end
local bodyMeters=flush({1.5,0,1.5})
local files={body="blocktemplates/"..s.name.."_body.x",tail="blocktemplates/"..s.name.."_tail.x"}
s:exportVoxelX(files.body,"body",{pivot={1.5,0,1.5}})
s:group("tail")
put,box,flush=grid()
for z=0,19 do
    local radius=math.min(3,1+math.floor(z/3),1+math.floor((19-z)/3))
    local center=math.floor(z/7)
    for y=-radius,radius do for x=-radius,radius do
        if x*x+y*y<=radius*radius+1 then put(x,center+y,z,z>=15 and cream or fur) end
    end end
end
local tailMeters=flush({3.5,0.25,1.5})
s:exportVoxelX(files.tail,"tail",{pivot={3.5,0.25,1.5}})
s:group("movie")
s:movie({name="idle",position={0,0,6},duration=2})
local specs={{name="body",offset={0,0,0},meters=bodyMeters},{name="tail",offset={0,16*u,10*u},meters=tailMeters}}
local actors,joints,batches={},{},{}
for _,part in ipairs(specs) do
    local p={5+part.offset[1],part.offset[2],4+part.offset[3]}
    s:actor("idle",{name=part.name,filename=files[part.name],position=p,scale=1,animId=0})
    local keys,frames={},{}
    for _,k in ipairs({{0,0},{0.5,25},{1,0},{1.5,-25},{2,0}}) do
        local values={position=p,anim=0}
        if part.name=="tail" then
            local half=k[2]*math.pi/360;local q={0,math.sin(half),0,math.cos(half)}
            values.bones={root={rotation=q}};keys[#keys+1]={time=k[1],rotation=q}
        end
        frames[#frames+1]={seconds=k[1],values=values}
    end
    if s.keyframes then batches[#batches+1]=s:keyframes("idle",part.name,frames)
    else for _,frame in ipairs(frames) do s:keyframe("idle",part.name,frame.seconds,frame.values) end end
    actors[#actors+1]={name=part.name,expectedMeters=part.meters,bone=part.name=="tail" and "root",rotationKeys=keys}
    if part.name=="tail" then joints[#joints+1]={actor="tail",parent="body",offset=part.offset} end
end
s:seek("idle",0)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i]) end;return v end
return {name=s.name,origin=s.origin,groups=groups,files=files,blocksize=one[1]-base[1],keyframeBatches=batches,
    overview={eye=view({6,1.1,2.4}),lookat=view({5,0.2,4})},
    detail={eye=view({5.75,0.75,2.9}),lookat=view({5,0.22,4})},
    animation={moviePosition=s:position({0,0,6}),times={0,0.25,0.5,0.75,1,1.25,1.5,1.75,2},motion="articulated",actors=actors,joints=joints,loopSeconds=2}}
