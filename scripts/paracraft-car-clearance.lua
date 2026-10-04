-- Read-only native source audit. The CLI runner supplies fenced identity/name.
local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation");
local E=commonlib.gettable("MyCompany.Aries.Game.EntityManager");
local O=commonlib.gettable("MyCompany.Aries.Game.VoxelModel.Octree");
local w=C.World:new():Init({});
assert(w.identity.worldPath==worldPath and w.identity.sessionId==sessionId);
local f=ParaIO.open(worldPath.."creation/"..sceneName.."/manifest.json","r");
assert(f:IsValid());local text=f:GetText(0,-1);f:close();
local manifest=commonlib.Json.Decode(text);
local parts={body={},wheel_source={}};
for _,member in pairs(manifest.cells) do
    if parts[member.group] then
        assert(w:Fingerprint(w:Snapshot(member.position))==member.fingerprint,"stale source");
        local e=assert(E.GetBlockEntity(unpack(member.position)));
        assert(e.class_name=="EntityVoxelModel");
        O.Visit(e.voxelRoot,function(x,y,z,level,color)
            local p={};
            for i,v in ipairs({x,y,z}) do p[i]=member.position[i]-manifest.origin[i]+v/level end;
            table.insert(parts[member.group],{p=p,size=1/level});
        end);
    end
end
local radius,halfwidth=0,0;
for _,v in ipairs(parts.wheel_source) do
    halfwidth=math.max(halfwidth,math.abs(v.p[1]-4.59375),math.abs(v.p[1]+v.size-4.59375));
    for _,y in ipairs({v.p[2]-0.3125,v.p[2]+v.size-0.3125}) do
        for _,z in ipairs({v.p[3]-7.5,v.p[3]+v.size-7.5}) do
            radius=math.max(radius,math.sqrt(y*y+z*z));
        end
    end
end
assert(radius>0 and halfwidth>0);
assert(type(steer)=="number" and steer>=0 and steer<=math.pi/2);
local minimum,samples=math.huge,0;
for _,x in ipairs({1.6875,3.3125}) do
    for _,z in ipairs({2.375,4.625}) do
        -- Conservative cylinder contains all spins and every steering angle
        -- between -steer and +steer. Rear wheels retain the straight envelope.
        local angle=z==2.375 and steer or 0;
        local axial=halfwidth+radius*math.sin(angle);
        local radial=radius+halfwidth*math.sin(angle);
        for _,v in ipairs(parts.body) do
            if v.p[1]<x+axial and v.p[1]+v.size>x-axial then
                local dy=math.max(v.p[2]-0.3125,0,0.3125-v.p[2]-v.size);
                local dz=math.max(v.p[3]-z,0,z-v.p[3]-v.size);
                local clearance=math.sqrt(dy*dy+dz*dz)-radial;
                assert(clearance>0.001,"rotating/steering voxel tire intersects body");
                minimum=math.min(minimum,clearance);samples=samples+1;
            end
        end
    end
end
assert(samples>0);
return {maximumRotatingRadiusMeters=radius,halfWidthMeters=halfwidth,
    steeringRadians=steer,minimumBodyGapMeters=minimum,comparisons=samples,
    wheelPositions=4,sourceManifest=ParaMisc.md5(text)};
