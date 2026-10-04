-- Compact single-seat light aircraft: ~6.2 m fuselage, 8 m span; parked propeller demo.
local creation=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
assert(creation.Scene and creation.Scene.exportVoxelX,"unsupported_capability: miniature mesh export")
local flight=false -- The banking_aircraft packaged variant changes this constant.
local s=createScene({name="light_aircraft",dimensions=flight and {24,8,14} or {24,4,14}})
local function box(p,d,c) s:box({position=p,dimensions=d,size=1/16,color=c,replace=true}) end
s:group("airframe")
-- A tapered fuselage and stepped windscreen distinguish cabin, cowling and tail.
for _,part in ipairs({{1,0.5,1.0625,0.5,0.75},{1.75,0.75,0.875,0.75,1.25},
    {3,0.875,0.75,0.875,1.5},{4.5,0.625,0.875,0.625,1.25},{5.75,0.375,1,0.375,1.25}}) do
    box({4.75-part[2]/2,part[3],part[1]},{part[2],part[4],part[5]},"#E9E0C8")
end
box({4.375,0.4375,2},{0.75,0.3125,2.5},"#47545B")
for layer=0,7 do
    local front=2.4375+math.floor(layer/2)/16
    box({4.3125,1.625+layer/16,front},{0.875,1/16,4-front},"#E9E0C8")
    if layer<6 then
        box({4.375,1.625+layer/16,front},{0.75,1/16,1/16},"#668E9F")
        for _,x in ipairs({4.3125,5.125}) do box({x,1.625+layer/16,front+1/16},{1/16,1/16,0.9375},"#668E9F") end
    end
end
-- Tapered high wing: thin tips, swept leading edge and contrasting tip bands.
for _,side in ipairs({-1,1}) do
    for strip=0,7 do
        local inner=strip*0.5
        local x=side<0 and 4.75-inner-0.5 or 4.75+inner
        local lead=2.75+math.floor(strip/3)/16
        local chord=strip<5 and 1.125 or (strip<7 and 1 or 0.875)
        box({x,2.125,lead},{0.5,strip<6 and 0.125 or 1/16,chord},strip>=6 and "#B4583E" or "#E9E0C8")
        box({x,2.25,lead+chord-0.125},{0.5,1/16,0.125},"#B4583E")
    end
    -- Slim diagonal struts, rather than filling the negative space under the wing.
    for i=0,10 do box({4.75+side*(0.5+i/16),1.375+i/16,3.375},{1/16,1/16,1/16},"#47545B") end
end
-- Horizontal stabilizer and tapered vertical fin.
box({3.5,1.375,6},{2.5,0.125,0.875},"#E9E0C8")
for layer=0,15 do
    local start=6+math.floor(layer/4)/16
    box({4.6875,1.5+layer/16,start},{0.125,1/16,7-start},layer>=10 and "#B4583E" or "#E9E0C8")
end
for _,x in ipairs({4.3125,5.125}) do box({x,1.25,2},{1/16,0.125,3.5},"#B4583E") end
-- Landing gear ends at axle centers; wheels stay outside the narrow lower body.
box({4.125,0.25,2.4375},{1.25,0.125,0.125},"#47545B")
for _,x in ipairs({4.25,5.1875}) do box({x,0.375,2.4375},{1/16,0.375,0.125},"#47545B") end
box({4.6875,0.25,6.5625},{0.125,0.75,0.125},"#47545B")
-- Narrow shaft reaches the rotor hub; the broad cowling stays behind its sweep.
box({4.6875,1.1875,0.8125},{0.125,0.125,0.1875},"#47545B")
local files={airframe="blocktemplates/"..s.name.."_airframe.x",propeller="blocktemplates/"..s.name.."_propeller.x",wheel="blocktemplates/"..s.name.."_wheel.x"}
s:exportVoxelX(files.airframe,"airframe",{pivot={4.75,0,4}})
s:group("propeller_source")
-- Thin two-blade rotor; Z axis is the fuselage axis. Colored tips expose rotation.
box({9.8125,1.1875,1.25},{1.875,0.125,0.125},"#6B503C")
for _,x in ipairs({9.8125,11.5}) do box({x,1.1875,1.25},{0.1875,0.125,0.125},"#D5B56D") end
box({10.625,1.125,1.25},{0.25,0.25,0.125},"#47545B")
s:exportVoxelX(files.propeller,"propeller_source",{pivot={10.75,1.25,1.3125}})
s:group("wheel_source")
for y=-4,3 do for z=-4,3 do
    local r2=(y+0.5)^2+(z+0.5)^2
    if r2<=16 then for x=0,1 do
        s:block({position={10.5+x/16,0.25+y/16,5.5+z/16},size=1/16,color=r2<5 and "#A6B0B1" or "#303738"})
    end end
end end
s:exportVoxelX(files.wheel,"wheel_source",{pivot={10.5625,0.25,5.5}})
s:group("movie")
s:movie({name="propeller",position={0,0,12},duration=2})
local specs={{name="airframe",offset={0,0,0},meters={8,2.25,6.1875},file=files.airframe},
    {name="propeller",offset={0,1.25,-3.25},meters={1.875,0.25,0.125},file=files.propeller,spin=true},
    {name="left_wheel",offset={-0.625,0.25,-1.5},meters={0.125,0.5,0.5},file=files.wheel},
    {name="right_wheel",offset={0.625,0.25,-1.5},meters={0.125,0.5,0.5},file=files.wheel},
    {name="tail_wheel",offset={0,0.25,2.625},meters={0.125,0.5,0.5},file=files.wheel}}
local actors,joints,batches={},{},{}
local function multiply(a,b)
    return {a[4]*b[1]+a[1]*b[4]+a[2]*b[3]-a[3]*b[2],
        a[4]*b[2]-a[1]*b[3]+a[2]*b[4]+a[3]*b[1],
        a[4]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[4],
        a[4]*b[4]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3]}
end
local function rotate(q,v)
    local r=multiply(multiply(q,{v[1],v[2],v[3],0}),{-q[1],-q[2],-q[3],q[4]})
    return {r[1],r[2],r[3]}
end
local function pose(time)
    local phase=time*math.pi
    local yaw=flight and 0.25*math.sin(phase) or 0
    local bank=flight and math.pi/9*math.sin(phase) or 0
    local q=multiply({0,math.sin(yaw/2),0,math.cos(yaw/2)},
        {0,0,math.sin(bank/2),math.cos(bank/2)})
    return q,{17.5+(flight and 0.75*math.sin(phase) or 0),
        flight and 3+0.25*math.sin(phase*2) or 0,7+(flight and 0.5*(1-math.cos(phase)) or 0)}
end
local intervals=flight and 128 or 8
for _,part in ipairs(specs) do
    local initial,center=pose(0);local offset=rotate(initial,part.offset)
    local position={center[1]+offset[1],center[2]+offset[2],center[3]+offset[3]}
    s:actor("propeller",{name=part.name,filename=part.file,position=position,scale=1,animId=0})
    local keys,frames={},{}
    for i=0,intervals do
        -- Author pose/metadata at the same integer milliseconds persisted natively.
        local time=math.floor(2000*i/intervals+0.5)/1000
        local body,center=pose(time);local offset=rotate(body,part.offset)
        local values={position={center[1]+offset[1],center[2]+offset[2],center[3]+offset[3]},anim=0}
        if part.spin or flight then
            local angle=2*math.pi*time
            local q=part.spin and multiply(body,{0,0,math.sin(angle/2),math.cos(angle/2)}) or body
            values.bones={root={rotation=q}};keys[#keys+1]={time=time,rotation=q}
        end
        frames[#frames+1]={seconds=time,values=values}
    end
    if s.keyframes then batches[#batches+1]=s:keyframes("propeller",part.name,frames)
    else for _,frame in ipairs(frames) do s:keyframe("propeller",part.name,frame.seconds,frame.values) end end
    actors[#actors+1]={name=part.name,expectedMeters=part.meters,bone=(part.spin or flight) and "root",rotationKeys=keys}
    if part.name~="airframe" then joints[#joints+1]={actor=part.name,parent="airframe",offset=part.offset,rotateWithParent=flight,toleranceMeters=flight and 0.001 or 0.0001} end
end
s:seek("propeller",0)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p) local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i]) end;return v end
return {name=s.name,origin=s.origin,groups=groups,files=files,blocksize=one[1]-base[1],keyframeBatches=batches,
    overview={eye=view({25,6,-1}),lookat=view({17.5,1.25,7})},
    detail={eye=view({24,flight and 7 or 4,0}),lookat=view({17.5,flight and 4 or 1.25,7})},
    animation={moviePosition=s:position({0,0,12}),times=flight and {0,0.125,0.2578125,0.5,0.75,1,1.5,1.75,2} or {0,0.125,0.25,0.5,0.75,1,1.5,1.75,2},
        motion="articulated",actors=actors,joints=joints,banking=flight,loopSeconds=2}}
