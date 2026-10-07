-- Native engine composition lab. Submit through run_code in a disposable world.
-- Editable stations: sequence puzzle + movie, 4x4 connect-three, lane challenge.
-- Creates inactive controls and a world-local mesh; does not save the world.
-- Copy/adapt rules and presentation for the requested game, not this lab's layout.
local s=createScene({name="engine_games",dimensions={34,8,26}});
local name=s.name;
s:group("grounds");
s:box({position={0,0,0},dimensions={34,1,26},blockId=62});
for _,x in ipairs({0,11,22}) do
    s:box({position={x,0,4},dimensions={10,1,20},blockId=5,replace=true});
end
s:group("character_source");
s:box({position={32,1,23},dimensions={0.5,0.75,0.5},size=0.25,color="#ffffff"});
s:box({position={32,1.75,23},dimensions={0.5,0.5,0.5},size=0.25,color="#ffffff"});
for _,x in ipairs({32,32.375}) do s:block({position={x,2,22.875},size=0.125,color="#142636"}) end
local model="blocktemplates/"..name.."_actor.x";
s:exportVoxelX(model,"character_source");s:requireModels({model});
local stations={};
local function station(id,x,z,pos,source,animated)
    s:group(id);
    local movie=s:movie({name=id,position={x,1,z+2},duration=1});
    local actor=name.."_"..id;
    s:actor(movie,{name=actor,filename=model,position=pos,scale=1,animId=0});
    if animated then
        s:keyframe(id,actor,0,{position=pos});
        s:keyframe(id,actor,0.5,{position={pos[1],pos[2]+2,pos[3]}});
        s:keyframe(id,actor,1,{position={pos[1],pos[2]+3,pos[3]}});
    end
    s:block({position={x,1,z+1},blockId=219});
    local p=s:position({x,1,z+1});
    s:editEntity(p,function(e)e:SetDisplayName(actor);e:SetNPLCode(source)end);
    s:block({position={x,1,z},blockId=190,data=5});
    stations[id]={code=p,movie=s:position({x,1,z+2}),lever=s:position({x,1,z}),actorName=actor};
end

-- Each game owns one authoritative state. Input actors only enqueue bounded commands.
local controller=[=[
local key,viewName,kind,base=__KEY__,__VIEW__,__KIND__,__BASE__;
local previous=_G[key];
local g={phase="idle",epoch=(previous and previous.epoch or 0)+1,queue={},board={},step=0,player=1,hp=3,lane=2};
_G[key]=g;setActorValue("sentientRadius",0);
local requested=false;
registerClickEvent(function()requested=true end);
if kind=="lanes" then
    for i=1,3 do
        local lane=i;
        registerKeyPressedEvent(tostring(lane),function()
            if g.phase=="running" and #g.queue<32 then g.queue[#g.queue+1]={id=lane,epoch=g.epoch} end
        end);
    end
end
registerStopEvent(function()g.phase="stopped";g.epoch=g.epoch+1;g.queue={} end);
local function line(x,z,p)
    for _,d in ipairs({{1,0},{0,1},{1,1},{1,-1}})do
        local n=1;
        for _,sign in ipairs({-1,1})do
            local k=1;
            while g.board[(z+d[2]*k*sign-1)*4+x+d[1]*k*sign]==p
                and x+d[1]*k*sign>=1 and x+d[1]*k*sign<=4
                and z+d[2]*k*sign>=1 and z+d[2]*k*sign<=4 do n=n+1;k=k+1 end
        end
        if n>=3 then return true end
    end
    return false;
end
local lastText;
while true do
    if requested then
        requested=false;stop();play(0);setPos(base[1],base[2],base[3]);
        g.epoch=g.epoch+1;g.queue={};g.board={};g.step=0;g.player=1;g.hp=3;g.lane=2;g.wave=0;g.winner=nil;
        g.phase="resetting";wait(0.12);
        if getActor(viewName) then
            g.phase="running";g.started=getTimer();g.nextWave=g.started+1;g.danger=2;
            local count=kind=="board" and 16 or 3;
            for i=1,count do clone(viewName,{id=i,epoch=g.epoch}) end
        else g.phase="not_ready" end
    end
    if g.phase=="running" then
        local queue=g.queue;g.queue={};
        for _,msg in ipairs(queue)do
            local id=msg.id;
            if msg.epoch==g.epoch and g.phase=="running" then
                if kind=="sequence" then
                    local order={2,1,3};
                    if id==order[g.step+1] then g.step=g.step+1 else g.step=0 end
                    if g.step==#order then g.phase="won";play(0,1000) end
                elseif kind=="board" then
                    if id>=1 and id<=16 and not g.board[id] then
                        local p=g.player;g.board[id]=p;g.step=g.step+1;
                        local x,z=(id-1)%4+1,math.floor((id-1)/4)+1;
                        if line(x,z,p) then g.phase="won";g.winner=p
                        elseif g.step==16 then g.phase="draw"
                        else g.player=3-p end
                    end
                elseif id>=1 and id<=3 then g.lane=id end
            end
        end
        if kind=="lanes" then
            local now=getTimer();
            -- Time-based travel, one transform owner; telegraphed lanes resolve once.
            setPos(base[1]+(g.lane-2)*2,base[2],base[3]+math.min(8,now-g.started));
            if now>=g.nextWave then
                if g.lane==g.danger then g.hp=g.hp-1 end
                g.wave=g.wave+1;g.danger=g.wave%3+1;g.nextWave=now+1;
                if g.hp<=0 then g.phase="lost" elseif g.wave>=6 then g.phase="won" end
            end
        end
    end
    local text;
    if g.phase=="running" then
        if kind=="sequence" then text=L"按 2 → 1 → 3 解锁："..g.step.."/3"
        elseif kind=="board" then text=L"三连棋 · 当前玩家 "..g.player..L" · 已落子 "..g.step
        else text=L"按 1/2/3 或点击车道 · 危险车道 "..g.danger..L" · 生命 "..g.hp end
    elseif g.phase=="idle" then text=L"点击我开始 · 再次点击重开"
    elseif g.phase=="not_ready" then text=L"请先启动输入角色拉杆"
    elseif g.phase=="won" then text=L"成功！点击我重开"
    elseif g.phase=="draw" then text=L"平局 · 点击我重开"
    else text=L"挑战结束 · 点击我重开" end
    if text~=lastText then say(text);lastText=text end
    wait(0.05);
end
]=];
local inputs=[=[
local key,kind,base=__KEY__,__KIND__,__BASE__;
setActorValue("sentientRadius",0);hide();
registerCloneEvent(function(msg)
    local g=_G[key];if not g or g.phase~="running" or msg.epoch~=g.epoch then delete();return end
    setActorValue("inputId",msg.id);setActorValue("epoch",msg.epoch);
    if kind=="board" then setPos(base[1]+((msg.id-1)%4)*2,base[2],base[3]+math.floor((msg.id-1)/4)*2)
    else setPos(base[1]+(msg.id-1)*2,base[2],base[3]) end
    show();
    if kind~="board" then say(tostring(msg.id)) end
end);
registerClickEvent(function()
    local g=_G[key];local id=getActorValue("inputId");
    if id and g and g.phase=="running" and getActorValue("epoch")==g.epoch and #g.queue<32 then
        g.queue[#g.queue+1]={id=id,epoch=g.epoch};
    end
end);
registerTickEvent(2,function()
    local id=getActorValue("inputId");if not id then return end
    local g=_G[key];
    if not g or g.phase=="resetting" or g.phase=="stopped" or getActorValue("epoch")~=g.epoch then delete();return end
    local color="#70c9ff";
    if kind=="board" then color=g.board[id]==1 and "#e76c55" or g.board[id]==2 and "#6b68dc" or "#c6d4df"
    elseif kind=="lanes" then color=id==g.danger and "#e76c55" or "#65cba0" end
    setActorValue("color",color);
end);
]=];
local games={};
local function encodePos(p)return "{"..table.concat(p,",").."}" end
local function fill(source,values)
    return (source:gsub("__([A-Z]+)__",function(k)return assert(values[k],k)end));
end
for index,kind in ipairs({"sequence","board","lanes"})do
    local x=(index-1)*11;
    local key=name..":"..kind;
    local host={x+5,1,6};local input={x+2,1,10};
    local values={KEY=string.format("%q",key),VIEW=string.format("%q",name.."_"..kind.."_inputs"),KIND=string.format("%q",kind),BASE=encodePos(s:position(host))};
    station(kind.."_host",x+1,0,host,fill(controller,values),kind=="sequence");
    values.BASE=encodePos(s:position(input));
    station(kind.."_inputs",x+6,0,input,fill(inputs,values));
    games[kind]={stateKey=key,host=kind.."_host",inputs=kind.."_inputs"};
end
local info=s:inspect();
return {name=name,origin=s.origin,stations=stations,games=games,model=model,
    eye=s:cameraPoint({17,30,-23}),lookat=s:cameraPoint({17,1,11}),saved=false,activated=false};
