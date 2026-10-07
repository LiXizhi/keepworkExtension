-- Submit as run_code source, after reading references/code-blocks.md.
-- Creates three editable CodeBlock/MovieClip/lever stations and one local mesh asset.
-- Does not activate the stations or save the native world.
-- Change the scene name for a separate installation; revise existing blocks in place.
local roundSeconds, targetCount = 20, 5;
local s=createScene({name="codeblock_playground",dimensions={18,6,14}});
local name=s.name;
local key = name..":round";
local hostName = name.."_host";
s:group("platform");
s:box({position={0,0,0},dimensions={18,1,14},blockId=62});
-- A 0.75 m wide, 1.5 m tall toy. Retain its editable color-voxel source.
s:group("toy_source");
s:box({position={16,1,11},dimensions={0.75,1,0.5},size=0.25,color="#ffffff"});
s:box({position={16,2,11},dimensions={0.75,0.5,0.5},size=0.25,color="#ffffff"});
for _,x in ipairs({16,16.5}) do
    s:block({position={x,2.25,10.875},size=0.125,color="#203040"});
end
local model="blocktemplates/"..name.."_toy.x";
s:exportVoxelX(model,"toy_source");
s:requireModels({model});

local controller = string.format([=[
local key, tokenName = %q, %q;
local previous=_G[key];
local g = {phase="idle",epoch=previous and previous.epoch+1 or 0,score=0,hits={},hitRequests={},goal=%d,seconds=%d};
_G[key] = g;
setActorValue("sentientRadius", 0);
registerClickEvent(function() g.request = true end);
registerStopEvent(function() g.phase="stopped"; g.epoch=g.epoch+1 end);
local lastText;
while true do
    if g.request then
        g.request=false;
        g.phase="resetting";
        g.epoch=g.epoch+1;
        -- A receiver may have lost power. Never wait indefinitely for cleanup.
        broadcast(key..":clear");
        wait(0.1);
        g.score=0; g.hits={}; g.hitRequests={};
        if getActor(tokenName) then
            g.phase="running";
            g.deadline=getTimer()+g.seconds;
            for i=1,g.goal do
                clone(tokenName,{id=i,epoch=g.epoch});
            end
        else
            g.phase="not_ready";
        end
    end
    if g.phase=="running" then
        -- One clock owner: input CodeBlocks have different local getTimer origins.
        -- Deadline wins at equality; late requests never turn a loss into a win.
        if getTimer()>=g.deadline then
            g.phase="lost";
            broadcast(key..":clear");
        else
            local requests=g.hitRequests;g.hitRequests={};
            for id,epoch in pairs(requests) do
                if epoch==g.epoch and id>=1 and id<=g.goal and not g.hits[id] then
                    g.hits[id]=true;g.score=g.score+1;
                end
            end
            if g.score>=g.goal then g.phase="won";broadcast(key..":clear") end
        end
    end
    local text;
    if g.phase=="running" then
        text=string.format(L"收集 %%d/%%d · 剩余 %%d 秒",g.score,g.goal,math.max(0,math.ceil(g.deadline-getTimer())));
    elseif g.phase=="won" then text=L"成功！点击我再玩一局";
    elseif g.phase=="lost" then text=L"时间到！点击我重新挑战";
    elseif g.phase=="not_ready" then text=L"先打开目标角色的拉杆，再点击我";
    else text=L"点击我开始：在倒计时内点完所有蓝色角色" end
    if text~=lastText then say(text);lastText=text end
    wait(0.05);
end
]=], key, name.."_tokens", targetCount, roundSeconds);

local p = s:position({3,1,7});
local tokens = string.format([=[
local key=%q;
local base={%f,%f,%f};
setActorValue("sentientRadius",0);
hide();
registerCloneEvent(function(msg)
    local g=_G[key];
    if not g or g.phase~="running" or msg.epoch~=g.epoch then delete();return end
    setActorValue("tokenId",msg.id);
    setActorValue("roundEpoch",msg.epoch);
    setActorValue("name",key..":token:"..msg.epoch..":"..msg.id);
    setActorValue("color","#5bbdff");
    setPos(base[1]+(msg.id-1)*2,base[2],base[3]);
    show();
end);
registerClickEvent(function()
    local g=_G[key];
    local id=getActorValue("tokenId");
    if not id or not g or g.phase~="running" or getActorValue("roundEpoch")~=g.epoch then return end
    -- Bounded by target IDs. The controller decides acceptance and scoring.
    if not g.hits[id] then g.hitRequests[id]=g.epoch end
end);
registerBroadcastEvent(key..":clear",function()
    local g=_G[key];
    if getActorValue("tokenId") and (not g or g.phase~="running" or getActorValue("roundEpoch")~=g.epoch) then delete() end
end);
-- A tick also cleans up after the controller loses power mid-round.
registerTickEvent(2,function()
    local g=_G[key];
    local id=getActorValue("tokenId");
    if id then
        if not g or g.phase~="running" or getActorValue("roundEpoch")~=g.epoch then delete()
        elseif g.hits[id] then hide() end
    end
end);
]=], key,p[1],p[2],p[3]);

local npc = string.format([=[
local modes={"patrol","follow","idle"};
local mode=1;
local target=%q; -- change to "@p" for a player-following companion
local x,y,z=getPos();
local corners={{x,y,z},{x+2,y,z},{x+2,y,z+2},{x,y,z+2}};
local corner=2;
setActorValue("sentientRadius",0);
registerClickEvent(function() mode=mode%%3+1 end);
local previous;
while true do
    local current=modes[mode];
    setActorValue("behaviorState",current);
    if current~=previous then
        if current=="patrol" then say(L"巡逻中 · 点击跟随")
        elseif current=="follow" then say(L"跟随主持人 · 点击等待")
        else say(L"等待中 · 点击恢复巡逻") end
        previous=current;
    end
    if current=="patrol" then
        local a,b,c=getPos();local q=corners[corner];
        local dx,dz=q[1]-a,q[3]-c;
        local d=math.sqrt(dx*dx+dz*dz);
        if d<0.05 then corner=corner%%4+1
        else local step=math.min(d,0.2);move(dx/d*step,0,dz/d*step,0.1) end
    elseif current=="follow" and (target=="@p" or getActor(target)) and distanceTo(target)>2 then
        turnTo(target);
        moveForward(0.2,0.1);
    end
    wait(0.05);
end
]=],hostName);

local stations={};
local function station(id,x,actorPosition,source)
    s:group(id);
    local movie=s:movie({name=id.."_movie",position={x,1,2},duration=2});
    s:actor(movie,{name=name.."_"..id,filename=model,position=actorPosition,scale=1,animId=0});
    s:block({position={x,1,1},blockId=219});
    local codePosition=s:position({x,1,1});
    s:editEntity(codePosition,function(entity)
        entity:SetDisplayName(name.."_"..id);
        entity:SetNPLCode(source);
    end);
    s:block({position={x,1,0},blockId=190,data=5});
    stations[id]={code=codePosition,movie=s:position({x,1,2}),lever=s:position({x,1,0}),actorName=name.."_"..id};
end
station("host",1,{3,1,4},controller);
station("tokens",7,{7,1,4},tokens);
station("npc",13,{13,1,6},npc);
local info=s:inspect();
return {name=name,origin=s.origin,stateKey=key,stations=stations,model=model,
    startOrder={"tokens","host","npc"},
    eye=s:cameraPoint({9,15,-13}),lookat=s:cameraPoint({9,1,6}),
    saved=false,activated=false};
