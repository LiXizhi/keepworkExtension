-- Host adapter. Programs supplied by the model run only in a physical CodeBlock.
local args = request.args
local B = commonlib.gettable("MyCompany.Aries.Game.BlockEngine")
local T = commonlib.gettable("MyCompany.Aries.Game.block_types")
assert(GameLogic.GetWorldDirectory() == request.worldPath and B:GetSessionId() == request.sessionId, "world_session_changed")
local function integer(v)
    return type(v)=="number" and v==math.floor(v) and math.abs(v)<=65535
end
local function vector(v)
    assert(type(v)=="table" and #v==3 and integer(v[1]) and integer(v[2]) and integer(v[3]), "expected integer xyz")
    return v
end
local function validName(v)
    return type(v)=="string" and #v<=40 and v:match("^[A-Za-z][A-Za-z0-9_]*$")
end
if request.operation=="frame_scene" then
    local center=vector(args.center)
    local distance,pitch,yaw=args.distance,args.pitch or 32,args.yaw or -45
    assert(type(distance)=="number" and distance>=2 and distance<=100 and
        type(pitch)=="number" and pitch>=5 and pitch<=85 and type(yaw)=="number" and math.abs(yaw)<=360,"invalid camera orbit")
    ParaCamera.SetLookAtPos(B:real_bottom(unpack(center)))
    ParaCamera.SetEyePos(distance*B.blocksize,math.rad(pitch),math.rad(yaw))
    return {center=center,distance=distance,pitch=pitch,yaw=yaw}
end
if request.operation=="sample_actor" then
    assert(validName(args.name), "invalid actor name")
    local globals=GameLogic.GetCodeGlobal()
    local actor=globals:GetActorByName(args.name)
    local program=globals:GetCodeBlockByName(args.name)
    local lastMessage=program and program:GetLastMessage()
    if type(lastMessage)=="string" then lastMessage=lastMessage:sub(1,1024) else lastMessage=nil end
    if not actor then return {found=false,name=args.name,programMessage=lastMessage} end
    local x,y,z=actor:GetPosition()
    local entity=actor:GetEntity()
    local obj=entity:GetInnerObject()
    local asset=obj and obj:IsValid() and obj:GetPrimaryAsset()
    local loaded=asset and asset:IsLoaded() or false
    local scale=entity:GetScaling()
    local box=loaded and asset:GetBoundingBox({})
    local span=box and box.max_x and {(box.max_x-box.min_x)*scale,(box.max_y-box.min_y)*scale,(box.max_z-box.min_z)*scale}
    local referencePosition
    if args.relativeTo then
        assert(validName(args.relativeTo), "invalid reference actor name")
        local reference = globals:GetActorByName(args.relativeTo)
        if reference then
            local rx, ry, rz = reference:GetPosition()
            referencePosition = {B:block_float(rx, ry, rz)}
        end
    end
    return {found=true, position={B:block_float(x,y,z)}, referencePosition=referencePosition,
        referenceName=args.relativeTo, model=entity:GetMainAssetPath(),
        scale=scale, modelSpanWorldUnits=span or nil, loaded=loaded, programMessage=lastMessage}
end
assert(GameLogic.GetGameMode()=="edit" and not GameLogic.IsReadOnly() and not GameLogic.isRemote, "requires local writable edit mode")
NPL.load("(gl)script/apps/Aries/Creator/Game/Code/Creation/Scene.lua")
local C=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
local world=C.World:new():Init({wait=function() end})
world:Check()
if request.operation=="restart_actor_program" then
    local pos=vector(args.position)
    local e=B:GetBlockEntity(unpack(pos))
    assert(e and e:GetType()=="EntityCode" and not e:IsCodeReadOnly() and not e:IsLocked(),"editable CodeBlock required")
    assert(validName(args.name) and e:GetDisplayName()==args.name and e:GetCommand()==args.expectedCode,"CodeBlock changed; read it again")
    assert(not e.HasDiskFileMirror or not e:HasDiskFileMirror(),"disk-mirrored CodeBlock")
    e:Restart()
    return {name=args.name,position=pos,started=true}
end
local function validFile(path)
    return type(path)=="string" and #path<=100 and path:match("^blocktemplates/[%w_-]+%.bmax$")
end
local function empty(x,y,z)
    assert(y>=0 and y<=255 and world:Loaded(x,z) and B:GetBlockId(x,y,z)==0,
        string.format("occupied/unloaded target (%d,%d,%d)",x,y,z))
end
if request.operation=="create_scripted_actor" then
    assert(validName(args.name) and not GameLogic.GetCodeGlobal():GetActorByName(args.name), "invalid or occupied actor name")
    local model=args.model
    if model=="human" then model="character/CC/02human/CustomGeoset/actor.x"
    else assert(validFile(model) and ParaIO.DoesFileExist(request.worldPath..model,true), "missing world model") end
    local scale=args.scale or 1
    assert(type(scale)=="number" and scale>=0.01 and scale<=8 and type(args.code)=="string" and #args.code>0 and #args.code<=16000,"invalid scale or code")
    local pos,station=vector(args.position),vector(args.station)
    local x,y,z=unpack(station)
    empty(x,y,z)
    empty(x,y,z+1)
    empty(unpack(pos))
    local clipId=T.names.MovieClip
    assert(pos[1]~=x or pos[2]~=y or (pos[3]~=z and pos[3]~=z+1), "actor position overlaps its control station")
    local function install()
        B:SetBlock(x,y,z,clipId)
        local movie=assert(B:GetBlockEntity(x,y,z),"movie unavailable")
        local clip=movie:GetMovieClip()
        local actor=clip:GetActorFromItemStack(movie:CreateNPC(),true)
        local ax,ay,az=B:real_bottom(unpack(pos))
        actor:BeginUpdate()
        for key,value in pairs({name=args.name,assetfile=model,scaling=scale,x=ax,y=ay,z=az,anim=0}) do actor:AddKey(key,0,value) end
        actor:EndUpdate()
        B:SetBlock(x,y,z+1,219)
        local program=assert(B:GetBlockEntity(x,y,z+1),"CodeBlock unavailable")
        program:SetDisplayName(args.name)
        program:SetNPLCode(string.format("setActorValue('name',%q)\n",args.name)..args.code)
        return program
    end
    local ok, program=pcall(install)
    if not ok then
        B:SetBlock(x,y,z+1,0)
        B:SetBlock(x,y,z,0)
        error(program)
    end
    GameLogic.SetModified()
    program:Restart()
    return {name=args.name,movie=station,codeBlock={x,y,z+1},model=model,started=true}
end
local voxel=request.operation=="make_voxel_model"
assert(voxel or request.operation=="place_block_shapes","unsupported operation")
local origin=voxel and {0,0,0} or vector(args.origin)
assert(type(args.boxes)=="table" and #args.boxes>=1 and #args.boxes<=128,"expected 1..128 cuboids")
local cells,indices={},{}
local volume=0
for boxIndex,box in ipairs(args.boxes) do
    local at,size=vector(box.at),vector(box.size)
    assert(size[1]>=1 and size[2]>=1 and size[3]>=1,"size must be positive")
    volume=volume+size[1]*size[2]*size[3]
    assert(volume<=4096,"cuboid batch exceeds 4096 cells")
    local id=voxel and 10 or box.blockId
    assert(integer(id) and id>0 and T.get(id),"unknown blockId")
    local data=0
    if voxel or box.color then
        assert(type(box.color)=="string" and box.color:match("^#%x%x%x%x%x%x$"),"expected RGB hex color")
        data=C.Scene.EncodeBlockData(id,tonumber("ff"..box.color:sub(2),16),0)
    end
    for dx=0,size[1]-1 do
        for dy=0,size[2]-1 do
            for dz=0,size[3]-1 do
                local x,y,z=origin[1]+at[1]+dx,origin[2]+at[2]+dy,origin[3]+at[3]+dz
                if voxel then assert(math.max(math.abs(x),math.abs(y),math.abs(z))<=128,"model coordinates exceed +/-128")
                else
                    assert(y>=0 and y<=255 and world:Loaded(x,z), "box "..boxIndex.." outside loaded world")
                end
                local key=string.format("%d,%d,%d",x,y,z)
                local index=indices[key] or (#cells+1)
                indices[key]=index
                cells[index]={x,y,z,id,data}
                if not voxel then cells[index].boxIndex=boxIndex end
            end
        end
    end
end
local low={cells[1][1],cells[1][2],cells[1][3]}
local high={unpack(low)}
for _,cell in ipairs(cells) do
    for axis=1,3 do
        low[axis]=math.min(low[axis],cell[axis])
        high[axis]=math.max(high[axis],cell[axis])
    end
end
local bounds={min=low,max=high}
if voxel then
    assert(validFile(args.filename),"invalid world BMax filename")
    NPL.load("(gl)script/apps/Aries/Creator/Game/Tasks/BlockTemplateTask.lua")
    local template=commonlib.gettable("MyCompany.Aries.Game.Tasks.BlockTemplate"):new({blocks=cells,auto_scale=false})
    world:WriteFile(args.filename,assert(template:SaveTemplateToString()))
    return {filename=args.filename,voxels=#cells,voxelBounds=bounds}
end
local changes={}
local pending={}
for _,cell in ipairs(cells) do
    local id,data=B:GetBlockFull(cell[1],cell[2],cell[3])
    if id==0 then pending[#pending+1]=cell
    elseif id~=cell[4] or data~=cell[5] then
        error(string.format("No blocks placed: box %d conflicts at (%d,%d,%d), existing blockId %d. Omit or relocate that box; other boxes can be submitted separately.",
            cell.boxIndex,cell[1],cell[2],cell[3],id))
    end
end
local ok,err=pcall(function()
    for _,cell in ipairs(pending) do
        local position={cell[1],cell[2],cell[3]}
        local before=world:Snapshot(position)
        assert(before.id==0,"target changed during placement")
        local change={position=position,before=before}
        changes[#changes+1]=change
        world:Restore(position,{id=cell[4],data=cell[5]})
        change.after=world:Snapshot(position)
        assert(change.after.id==cell[4],"block readback failed")
    end
end)
if not ok then
    for i=#changes,1,-1 do world:Restore(changes[i].position,changes[i].before) end
    error(err)
end
world:Commit(changes)
return {placed=#changes,alreadyMatching=#cells-#changes,origin=origin,blockBounds=bounds}
