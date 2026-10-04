-- Editable desktop fan ~0.78 m tall; 1/32 m curved blades and sparse grille.
local s=createScene({name="desk_fan",dimensions={6,3,6}})
s:group("housing")
s:box({position={1.0625,0,1.125},dimensions={0.375,0.0625,0.25},size=0.0625,color="#40575C"})
s:box({position={1.21875,0.0625,1.28125},dimensions={0.0625,0.4375,0.0625},size=0.03125,color="#71918D"})
s:block({position={1.3125,0.0625,1.21875},size=0.03125,color="#DCAC73"})
-- Ring and vertical guard wires; leave open space to read the blade silhouette.
for x=-9,8 do for y=-9,8 do
    local r=math.sqrt((x+0.5)^2+(y+0.5)^2)
    if r>=8 and r<=9 then
        s:box({position={1.25+x/32,0.5+y/32,1.125},dimensions={1/32,1/32,3/32},size=1/32,color="#71918D"})
    elseif r<8 and (x==-5 or x==0 or x==4) then
        s:block({position={1.25+x/32,0.5+y/32,1.125},size=1/32,color="#ABC1B4"})
    end
    if r<2.5 then
        s:box({position={1.25+x/32,0.5+y/32,1.25},dimensions={1/32,1/32,0.125},size=1/32,color="#40575C",replace=true})
    end
end end
s:group("rotor")
local minx,miny,maxx,maxy=99,99,-99,-99
for x=-7,6 do for y=-7,6 do
    local r=math.sqrt((x+0.5)^2+(y+0.5)^2)
    local phase=(math.atan2(y+0.5,x+0.5)-0.55*r/7)%(2*math.pi/3)
    local width=0.18+0.36*r/7
    local blade=r<=7 and (phase<width or phase>2*math.pi/3-width)
    if r<1.7 or blade then
        local color=r<1.7 and "#DDE3CC" or (r>5.6 and "#DFA86C" or "#B57843")
        s:block({position={3.25+x/32,0.25+y/32,1.25},size=1/32,color=color})
        minx=math.min(minx,x);miny=math.min(miny,y);maxx=math.max(maxx,x);maxy=math.max(maxy,y)
    end
end end
local base="blocktemplates/"..s.name
s:exportVoxelX(base.."_housing.x","housing",{pivot={1.25,0,1.25}})
s:exportVoxelX(base.."_rotor.x","rotor",{pivot={3.25,0.25,1.265625}})
s:group("assembled")
s:model({position={4,0,3},filename=base.."_housing.x",scale=1})
s:group("movie")
s:movie({name="spin",position={0,0,5},duration=1})
s:actor("spin",{name="rotor",filename=base.."_rotor.x",position={4,0.5,2.9375},scale=1})
-- Quarter-turn keys preserve one full turn with quaternion interpolation.
for i=0,4 do
    local angle=i*math.pi/2
    s:keyframe("spin","rotor",i/4,{anim=0,bones={root={rotation={0,0,math.sin(angle/2),math.cos(angle/2)}}}})
end
s:seek("spin",0)
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do
    local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end
    groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}
end
local basePoint=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)
    local v={};for i=1,3 do v[i]=basePoint[i]+p[i]*(one[i]-basePoint[i]) end;return v
end
return {name=s.name,origin=s.origin,groups=groups,
    overview={eye=view({4.9,0.95,1.7}),lookat=view({4,0.4,3})},
    detail={eye=view({4.1,0.65,1.7}),lookat=view({4,0.45,3})},
    animation={moviePosition=s:position({0,0,5}),times={0,0.125,0.25,0.375,0.5,1},
        actor="rotor",expectedMeters={(maxx-minx+1)/32,(maxy-miny+1)/32,1/32},motion="bone",bone="root",
        rotationAxis={0,0,1},turns=1}}
