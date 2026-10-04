-- Read-only persisted native-track audit; caller supplies identity/moviePosition.
local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager")
local T=commonlib.gettable("MyCompany.Aries.Game.block_types")
local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine")
NPL.load("(gl)script/ide/math/Quaternion.lua")
local Quaternion=commonlib.gettable("mathlib.Quaternion")
assert(C.World.Identity().worldPath==worldPath and C.World.Identity().sessionId==sessionId)
local e=assert(E.GetBlockEntity(unpack(moviePosition)));local clip=e:GetMovieClip()
local actors={}
for slot=1,e.inventory:GetSlotCount() do local item=e.inventory:GetItem(slot)
    if item and item.id==T.names.TimeSeriesNPC then local a=clip:GetActorFromItemStack(item,true);actors[a:GetValue("name",0)]=a end
end
local function position(a,time) return {a:GetValue("x",time),a:GetValue("y",time),a:GetValue("z",time)} end
local function rotation(a,time)
    local track=assert(a:GetTimeSeries():GetChild("bones"):GetVariable("root_rot"))
    assert(track:GetKeyNum()==129,"missing dense orientation keys")
    -- Lua bone tracks store discrete tables. The native AnimatedQuaternion
    -- sampler uses shortest-path slerp, already checked by native pose captures.
    local index=1;while index<#track.times-1 and track.times[index+1]<time do index=index+1 end
    local from,to=track.times[index],track.times[index+1]
    local q=Quaternion:new():slerp(track.data[index],track.data[index+1],(time-from)/(to-from))
    local length=math.sqrt(q[1]^2+q[2]^2+q[3]^2+q[4]^2)
    return {q[1]/length,q[2]/length,q[3]/length,q[4]/length}
end
local function rotate(q,v)
    local x,y,z,w=q[1],q[2],q[3],q[4]
    local tx,ty,tz=2*(y*v[3]-z*v[2]),2*(z*v[1]-x*v[3]),2*(x*v[2]-y*v[1])
    return {v[1]+w*tx+y*tz-z*ty,v[2]+w*ty+z*tx-x*tz,v[3]+w*tz+x*ty-y*tx}
end
local offsets={propeller={0,1.25,-3.25},left_wheel={-0.625,0.25,-1.5},right_wheel={0.625,0.25,-1.5},tail_wheel={0,0.25,2.625}}
local body=assert(actors.airframe);local maximum,axisError=0,0;local worst
for i=0,1000 do
    local time=2*i;local p=position(body,time);local q=rotation(body,time)
    for name,offset in pairs(offsets) do
        local child=assert(actors[name]);local actual=position(child,time);local expected=rotate(q,offset)
        local sum=0;for k=1,3 do local error=(actual[k]-p[k])/B.blocksize-expected[k];sum=sum+error*error end
        if math.sqrt(sum)>maximum then maximum=math.sqrt(sum);worst={time=time,actor=name,actual=actual,parent=p,expected=expected} end
    end
    local normal=rotate(rotation(actors.propeller,time),{0,0,1});local target=rotate(q,{0,0,1})
    local sum=0;for k=1,3 do sum=sum+(normal[k]-target[k])^2 end;axisError=math.max(axisError,math.sqrt(sum))
end
local q=rotation(body,500);assert(math.abs(q[3])>0.1 and math.abs(q[2])>0.1,"body did not bank/yaw")
for _,a in pairs(actors) do
    local first,last=position(a,0),position(a,2000)
    for k=1,3 do assert(math.abs(first[k]-last[k])<0.0001,"loop position discontinuity") end
    local first,last=rotation(a,0),rotation(a,2000);local dot=0
    for k=1,4 do dot=dot+first[k]*last[k] end;assert(math.abs(dot)>0.9999,"loop orientation discontinuity")
end
return {samples=1001,method="persisted_positions_and_quaternion_slerp",attachments=4,maximumAttachmentErrorMeters=maximum,
    maximumPropellerAxisVectorError=axisError,loopContinuous=true,bankYawVerified=true,
    bodyRotationAt500=q,positionAt500=position(body,500),worst=worst,
    bodyPositionKeys={body:GetVariable("x"):GetKeyNum(),body:GetVariable("y"):GetKeyNum(),body:GetVariable("z"):GetKeyNum()},
    propellerPositionKeys={actors.propeller:GetVariable("x"):GetKeyNum(),actors.propeller:GetVariable("y"):GetKeyNum(),actors.propeller:GetVariable("z"):GetKeyNum()}}
