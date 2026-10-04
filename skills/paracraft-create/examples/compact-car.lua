-- Compact hatchback: 3.75 m long, ~1.88 m across mirrors; editable color voxels.
local creation=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
assert(creation.Scene and creation.Scene.exportVoxelX,"unsupported_capability: miniature mesh export")
local s=createScene({name="compact_car",dimensions={10,3,10}})
local function box(p,d,c,replace) s:box({position=p,dimensions=d,size=1/16,color=c,replace=replace}) end
s:group("body")
-- A narrow chassis and shaped outer panels leave actual wheel-arch air gaps.
-- Compress each occupied side-panel run into a box rather than one CLI edit per voxel.
box({2,0.3125,1.75},{1,0.5625,3.5},"#C96448")
for layer=0,8 do
    local y=0.3125+layer/16
    local dy=y-0.3125
    local reach=dy<0.4375 and math.sqrt(0.4375^2-dy^2) or 0
    local function panel(side,first,last,inset)
        local run
        for z=first,last do
            local low=1.75+z/16
            local empty=reach>0 and ((low<2.375+reach and low+1/16>2.375-reach)
                or (low<4.625+reach and low+1/16>4.625-reach))
            if not empty and not run then run=z end
            if run and (empty or z==last) then
                local finish=empty and z or z+1
                box({side<0 and 1.75+inset or 3,y,1.75+run/16},
                    {0.25-inset,1/16,(finish-run)/16},layer<3 and "#47515A" or "#C96448")
                run=nil
            end
        end
    end
    for _,side in ipairs({-1,1}) do
        panel(side,0,3,1/16);panel(side,4,51,0);panel(side,52,55,1/16)
    end
end
for _,z in ipairs({1.625,5.25}) do box({1.75,0.375,z},{1.5,0.375,0.125},"#47515A") end
-- A stepped windscreen and narrower roof make the cabin read as a hatchback.
for i=0,9 do
    local front=2.5+math.floor(i/2)/16
    local x=i>=8 and 1.875 or 1.8125
    local width=i>=8 and 1.25 or 1.375
    box({x,0.875+i/16,front},{width,1/16,4.375-front},"#C96448")
    if i>=2 and i<=7 then box({1.9375,0.875+i/16,front},{1.125,1/16,1/16},"#557B88",true) end
end
box({1.875,1.4375,2.75},{1.25,1/16,1.625},"#EDE2C9",true)
for _,x in ipairs({1.8125,3.125}) do
    for _,z in ipairs({3,3.6875}) do box({x,1.0625,z},{1/16,0.3125,0.5},"#557B88",true) end
    box({x,1.3125,3},{1/16,1/16,0.4375},"#A6C4CC",true)
end
box({1.9375,1.0625,4.3125},{1.125,0.3125,1/16},"#557B88",true)
for _,x in ipairs({1.5625,3.25}) do box({x,0.9375,2.875},{0.1875,0.125,0.125},"#47515A") end
for _,x in ipairs({1.8125,2.9375}) do
    box({x,0.5625,1.625},{0.25,0.125,1/16},"#FFF0B1",true)
    box({x,0.5625,5.3125},{0.25,0.125,1/16},"#993B3D",true)
end
box({2.25,0.4375,1.625},{0.5,1/16,1/16},"#EDE2C9",true)
box({2.25,0.4375,5.3125},{0.5,1/16,1/16},"#EDE2C9",true)
-- Door seams, short handles and a recessed dark grille read at the assembled scale.
for _,x in ipairs({1.8125,3.125}) do
    box({x,0.875,3.5},{1/16,0.5,1/16},"#47515A",true)
    box({x,0.9375,3.3125},{1/16,1/16,0.1875},"#EDE2C9",true)
end
box({2.125,0.625,1.625},{0.75,1/16,1/16},"#2D3038",true)
local files={body="blocktemplates/"..s.name.."_body.x",wheel="blocktemplates/"..s.name.."_wheel.x"}
s:exportVoxelX(files.body,"body",{pivot={2.5,0,3.5}})
s:group("wheel_source")
-- One 0.625 m tire asset reused at four axles; asymmetric marker reveals spin.
for y=-5,4 do for z=-5,4 do
    local r2=(y+0.5)^2+(z+0.5)^2
    if r2<=25 then for x=0,2 do
        local spoke=math.abs(y+0.5)<0.8 or math.abs(z+0.5)<0.8 or math.abs(math.abs(y+0.5)-math.abs(z+0.5))<0.6
        local color=(x~=1 and r2<13 and spoke) and "#C7CDD1" or "#2D3038"
        if x~=1 and (r2<2 or (y==3 and z==0)) then color="#E9BF73" end
        s:block({position={4.5+x/16,0.3125+y/16,7.5+z/16},size=1/16,color=color})
    end end
end end
s:exportVoxelX(files.wheel,"wheel_source",{pivot={4.59375,0.3125,7.5}})
s:group("movie")
s:movie({name="roll",position={0,0,8},duration=2})
local specs={{name="body",offset={0,0,0},meters={1.875,1.1875,3.75}}}
for _,side in ipairs({-1,1}) do for _,axle in ipairs({-1,1}) do
    specs[#specs+1]={name=(side<0 and "left" or "right")..(axle<0 and "_front" or "_rear"),
        offset={side*0.8125,0.3125,axle*1.125},meters={0.1875,0.625,0.625},wheel=true,front=axle<0}
end end
local actors,joints={},{}
local travel=2*math.pi*0.3125
for _,part in ipairs(specs) do
    s:actor("roll",{name=part.name,filename=part.wheel and files.wheel or files.body,
        position={7.5+part.offset[1],part.offset[2],5.5+part.offset[3]},scale=1,animId=0})
    local keys={}
    for i=0,4 do
        local angle=-i*math.pi/2
        local values={position={7.5+part.offset[1],part.offset[2],5.5+part.offset[3]-travel*i/4},anim=0}
        if part.wheel then
            local q={math.sin(angle/2),0,0,math.cos(angle/2)}
            values.bones={root={rotation=q}};keys[#keys+1]={time=i/4,rotation=q}
        end
        s:keyframe("roll",part.name,i/4,values)
    end
    -- Stop before steering: parallel front-wheel yaw is a parked pose demo,
    -- not Ackermann geometry or a claim of physically correct curved driving.
    for i,steer in ipairs({math.pi/9,0,-math.pi/9,0}) do
        local values={position={7.5+part.offset[1],part.offset[2],5.5+part.offset[3]-travel},anim=0}
        if part.wheel then
            local angle=part.front and steer or 0
            local q={0,math.sin(angle/2),0,math.cos(angle/2)}
            values.bones={root={rotation=q}};keys[#keys+1]={time=1+i/4,rotation=q}
        end
        s:keyframe("roll",part.name,1+i/4,values)
    end
    actors[#actors+1]={name=part.name,expectedMeters=part.meters,bone=part.wheel and "root",rotationKeys=keys}
    if part.wheel then joints[#joints+1]={actor=part.name,parent="body",offset=part.offset} end
end
s:seek("roll",0)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p) local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i]) end;return v end
return {name=s.name,origin=s.origin,groups=groups,files=files,blocksize=one[1]-base[1],
    overview={eye=view({11.5,3,0.5}),lookat=view({7.5,0.75,4.5})},
    detail={eye=view({11,2.25,1.25}),lookat=view({7.5,0.75,4.5})},
    animation={moviePosition=s:position({0,0,8}),times={0,0.125,0.25,0.5,0.75,1,1.25,1.5,1.75,2},
        motion="articulated",actors=actors,joints=joints,travelMeters=travel,wheelRadiusMeters=0.3125,
        travelEndSeconds=1,steering={startSeconds=1,maximumRadians=math.pi/9,actors={"left_front","right_front"}}}}
