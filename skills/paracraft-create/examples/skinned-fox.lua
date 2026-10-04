-- Technical construction is 32x delivered size so carrier ownership is distinct.
-- Final fox is ~0.78 m long, 0.44 m high; six bones plus optional independent head.
local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
local s=createScene({name="skinned_fox",dimensions={30,16,30}})
assert(C.VoxelExport and C.VoxelExport.ScaleClips,"unsupported_capability: baked rig scale")
local headLook=false
local u,normalize=0.5,1/32
local fur,cream,dark,inner="#C86F38","#EADBC0","#343039","#A55B55"
local voxels,owners={},{},{}
local function key(x,y,z)return x..","..y..","..z end
local function put(x,y,z,color,owner)
    local px,py,pz=8+x*u,y*u,14+z*u
    voxels[key(x,y,z)]={x=x,y=y,z=z,color=color}
    if owner then
        local carrier=key(math.floor(px),math.floor(py),math.floor(pz))
        assert(not owners[carrier] or owners[carrier]==owner,"conflicting leg carriers")
        owners[carrier]=owner
    end
end
local function box(a,b,color,owner)
    for z=a[3],b[3] do for y=a[2],b[2] do for x=a[1],b[1] do put(x,y,z,color,owner) end end end
end
for z=-8,11 do for y=8,18 do for x=-4,4 do
    if (x/4.5)^2+((y-13)/5.5)^2+((z-1.5)/10.5)^2<=1 then put(x,y,z,fur) end
end end end
local legs={
    {name="front_left",x=-4,z=-6,control={5,6,11},pivot={0.5,-0.5,0},phase=1,minZ=10.5,maxZ=12.5},
    {name="front_right",x=2,z=-6,control={10,6,11},pivot={-0.5,-0.5,0},phase=-1,minZ=10.5,maxZ=12.5},
    {name="rear_left",x=-4,z=7,control={5,6,18},pivot={0.5,-0.5,0},phase=-1,minZ=17,maxZ=19},
    {name="rear_right",x=2,z=7,control={10,6,18},pivot={-0.5,-0.5,0},phase=1,minZ=17,maxZ=19}}
for _,leg in ipairs(legs) do
    box({leg.x,0,leg.z},{leg.x+1,11,leg.z+2},fur,leg.name)
    box({leg.x,0,leg.z},{leg.x+1,4,leg.z+2},dark,leg.name)
    box({leg.x-1,0,leg.z-1},{leg.x+1,1,leg.z+2},dark,leg.name)
end
box({-3,13,-9},{3,19,-5},fur)
box({-4,16,-13},{4,22,-7},fur)
box({-3,14,-11},{3,16,-7},cream)
for z=-18,-14 do local r=math.min(2,math.floor((z+18)/2)+1);box({-r,16,z},{r,18,z},cream) end
box({-1,17,-18},{1,18,-18},dark)
for _,side in ipairs({-1,1}) do
    for y=23,27 do
        local r=math.max(0,2-math.floor((y-23)/2))
        for x=-r,r do for z=-11,-9 do put(side*3+x,y,z,fur) end end
        if y<=25 then put(side*3,y,-11,inner) end
    end
    put(side*5,20,-12,dark);put(side*5,20,-11,dark)
end
for z=0,19 do
    local r=math.min(3,1+math.floor(z/3),1+math.floor((19-z)/3));local center=math.floor(z/7)
    for y=-r,r do for x=-r,r do if x*x+y*y<=r*r+1 then
        put(x,13+center+y,12+z,z>=15 and cream or fur,"tail")
    end end end
end
local root={8,10,14};local occupied={}
for _,v in pairs(voxels) do occupied[key(math.floor(8+v.x*u),math.floor(v.y*u),math.floor(14+v.z*u))]=true end
for _,p in ipairs({root,legs[1].control,legs[2].control,legs[3].control,legs[4].control,{8,5,20}}) do
    assert(not occupied[key(p[1],p[2],p[3])],"control carrier overlaps planned geometry")
end
if headLook then assert(not occupied[key(8,10,11)],"head control overlaps planned geometry") end
-- Classify entire carriers, including intersecting haunch voxels, once.
local rows={}
for _,v in pairs(voxels) do
    local p={8+v.x*u,v.y*u,14+v.z*u}
    local owner=owners[key(math.floor(p[1]),math.floor(p[2]),math.floor(p[3]))] or "body"
    if headLook and owner=="body" and math.floor(p[2])>=7 and math.floor(p[3])<=10 then owner="head" end
    local rowKey=key(0,v.y,v.z);rows[rowKey]=rows[rowKey] or {};rows[rowKey][v.x]={color=v.color,owner=owner}
end
-- Merge same-colored, same-owner rows vertically before helper writes. Each
-- consumed voxel is removed from this private plan, never from the world.
for z=-18,31 do for y=0,27 do
    local row=rows[key(0,y,z)];local x=-5
    while row and x<=5 do
        local cell=row[x]
        if cell then
            local last=x;while row[last+1] and row[last+1].color==cell.color and row[last+1].owner==cell.owner do last=last+1 end
            local top=y
            while top<27 do
                local nextRow=rows[key(0,top+1,z)];local matches=nextRow~=nil
                if matches then for xx=x,last do
                    local nextCell=nextRow[xx]
                    if not nextCell or nextCell.color~=cell.color or nextCell.owner~=cell.owner then matches=false;break end
                end end
                if not matches then break end
                top=top+1
            end
            for yy=y,top do for xx=x,last do rows[key(0,yy,z)][xx]=nil end end
            s:group(cell.owner);s:box({position={8+x*u,y*u,14+z*u},dimensions={(last-x+1)*u,(top-y+1)*u,u},size=u,color=cell.color})
            x=last+1
        else x=x+1 end
    end
end end
s:group("controls")
s:bone({name="root",position=root,direction=4})
for _,leg in ipairs(legs) do s:bone({name=leg.name,position=leg.control,direction=4,pivot=leg.pivot}) end
s:bone({name="tail",position={8,5,20},direction=4,pivot={-0.5,0.5,-0.5}})
if headLook then s:bone({name="head",position={8,10,11},direction=4,pivot={0,-0.5,-0.5}}) end
s:bindBone({position=root,groups={"body"},parentMode="none"})
for _,leg in ipairs(legs) do s:bindBone({position=leg.control,groups={leg.name},parent=root}) end
s:bindBone({position={8,5,20},groups={"tail"},parent=root})
if headLook then s:bindBone({position={8,10,11},groups={"head"},parent=root}) end
local geometry={"body","front_left","front_right","rear_left","rear_right","tail"}
if headLook then geometry[#geometry+1]="head" end
local file="blocktemplates/"..s.name.."_technical_rig.x"
local exported=s:exportVoxelX(file,geometry,{rig="controls",pivot={8,0,14}})
s:group("movie")
s:movie({name="motion",position={25,0,25},duration=3})
-- Source actor is a small preview; animation translations remain in source meters.
s:actor("motion",{name="fox",filename=file,position={23,0,12},scale=normalize,animId=0})
local frames={}
local function frame(time,id)
    local phase=id==0 and 2*math.pi*time/0.999 or 2*math.pi*(time-1)/2
    local bones={root={rotation={0,0,0,1},translation={0,0,0}}}
    for _,leg in ipairs(legs) do
        local swing=id==0 and 0 or math.sin(phase)*leg.phase
        local angle=swing*12*math.pi/180
        local hipZ=leg.control[3]+0.5+leg.pivot[3]
        local far=angle>=0 and leg.maxZ-hipZ or hipZ-leg.minZ
        local compensation=math.max(0,6*math.cos(angle)+math.abs(math.sin(angle))*far-6)
        local lift=compensation+math.max(0,swing)*0.5
        bones[leg.name]={rotation={math.sin(angle/2),0,0,math.cos(angle/2)},translation={0,lift,0}}
    end
    local yaw=math.sin(phase)*(id==0 and 20 or 12)*math.pi/180
    bones.tail={rotation={0,math.sin(yaw/2),0,math.cos(yaw/2)}}
    if headLook then
        local headYaw=id==0 and math.sin(phase)*25*math.pi/180 or 0
        bones.head={rotation={0,math.sin(headYaw/2),0,math.cos(headYaw/2)}}
    end
    return {seconds=time,values={anim=id,bones=bones}}
end
for i=0,16 do frames[#frames+1]=frame(math.floor(999*i/16+0.5)/1000,0) end
-- Animation-ID is authored only at each boundary, not at every bone sample.
for i=0,64 do local f=frame(math.floor(1000+2000*i/64+0.5)/1000,1);if i>0 then f.values.anim=nil end;frames[#frames+1]=f end
for i=2,17 do frames[i].values.anim=nil end
s:keyframes("motion","fox",frames)
s:seek("motion",0)
local clipsFile="blocktemplates/"..s.name.."_clips.x"
local clips=s:exportVoxelX(clipsFile,geometry,{rig="controls",pivot={8,0,14},scale=normalize,
    animation={movie="motion",actor="fox",loops={[0]=true,[1]=true}}})
s:group("verification")
s:movie({name="independent",position={25,0,26},duration=3})
s:actor("independent",{name="fox",filename=clipsFile,position={25,0,12},scale=1,animId=0})
s:keyframe("independent","fox",1,{anim=1})
s:seek("independent",0)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({25,0,12});local one=s:toWorld({26,0,12});local unit=one[1]-base[1]
local function view(p)return {base[1]+p[1]*unit,base[2]+p[2]*unit,base[3]+p[3]*unit} end
return {name=s.name,origin=s.origin,groups=groups,exported=exported,clips=clips,legs=legs,technicalScale=32,headLook=headLook,
    overview={eye=view({1.2,0.8,-1.5}),lookat=view({0,0.2,0})},
    detail={eye=view({0.8,0.55,-1.1}),lookat=view({0,0.2,0})},
    animation={moviePosition=s.movies.independent.position,times={0,0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3},motion="articulated",
        actors={{name="fox",expectedMeters={0.171875,0.4375,0.78125},embedded=true}},loopSeconds=2}}
