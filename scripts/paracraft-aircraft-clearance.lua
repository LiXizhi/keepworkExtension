-- Read-only native geometry audit; runner supplies worldPath/sessionId/sceneName.
local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager")
local O=commonlib.gettable("MyCompany.Aries.Game.VoxelModel.Octree")
local w=C.World:new():Init({})
assert(w.identity.worldPath==worldPath and w.identity.sessionId==sessionId)
local f=ParaIO.open(worldPath.."creation/"..sceneName.."/manifest.json","r")
assert(f:IsValid());local text=f:GetText(0,-1);f:close()
local manifest=commonlib.Json.Decode(text)
local parts={airframe={},propeller_source={}}
for _,member in pairs(manifest.cells) do if parts[member.group] then
    assert(w:Fingerprint(w:Snapshot(member.position))==member.fingerprint,"stale source")
    local e=assert(E.GetBlockEntity(unpack(member.position)))
    assert(e.class_name=="EntityVoxelModel")
    O.Visit(e.voxelRoot,function(x,y,z,level,color)
        local p={};for i,v in ipairs({x,y,z}) do p[i]=member.position[i]-manifest.origin[i]+v/level end
        table.insert(parts[member.group],{p=p,size=1/level})
    end)
end end
local radius,axial=0,0
for _,v in ipairs(parts.propeller_source) do
    axial=math.max(axial,math.abs(v.p[3]-1.3125),math.abs(v.p[3]+v.size-1.3125))
    for _,x in ipairs({v.p[1]-10.75,v.p[1]+v.size-10.75}) do
        for _,y in ipairs({v.p[2]-1.25,v.p[2]+v.size-1.25}) do radius=math.max(radius,math.sqrt(x*x+y*y)) end
    end
end
assert(radius>0 and axial>0)
local minimum,samples,shaft=math.huge,0,0
for _,v in ipairs(parts.airframe) do
    local dx=math.max(v.p[1]-4.75,0,4.75-v.p[1]-v.size)
    local dy=math.max(v.p[2]-1.25,0,1.25-v.p[2]-v.size)
    if math.sqrt(dx*dx+dy*dy)<=radius then
        local farX=math.max(math.abs(v.p[1]-4.75),math.abs(v.p[1]+v.size-4.75))
        local farY=math.max(math.abs(v.p[2]-1.25),math.abs(v.p[2]+v.size-1.25))
        local gap=math.max(v.p[3]-0.75,0,0.75-v.p[3]-v.size)-axial
        -- Intentional central shaft may touch the hub but never penetrate its plane.
        if math.sqrt(farX*farX+farY*farY)<=0.125 and v.p[3]<1 then
            assert(gap>=-0.000001,"shaft penetrates rotor");shaft=shaft+1
        else
            assert(gap>0.001,"rotor sweep intersects airframe")
            minimum=math.min(minimum,gap);samples=samples+1
        end
    end
end
assert(samples>0 and shaft>0,"missing cowling or shaft")
assert(1.25-radius>0.001,"rotor corner hits ground")
return {radiusMeters=radius,axialHalfThicknessMeters=axial,
    minimumCowlingGapMeters=minimum,groundGapMeters=1.25-radius,
    comparisons=samples,shaftCells=shaft}
