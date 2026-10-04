-- 3.5 m open rowboat, a reusable oar and contained native water preview.
local creation=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
assert(creation.Scene and creation.Scene.exportVoxelX,"unsupported_capability: miniature mesh export")
local s=createScene({name="rowing_boat",dimensions={14,3,12},terrainDepth=2})
local function box(p,d,c,replace) s:box({position=p,dimensions=d,size=1/16,color=c,replace=replace}) end
s:group("hull")
local function width(z,layer) return math.max(4,2*math.min(12,3+math.floor(math.min(z,55-z)/2))-2*math.max(0,math.floor((6-layer)/2))) end
-- Compress equal-width longitudinal rows; leave the interior open above the sole.
for layer=0,9 do
    local first=0
    while first<56 do
        local span=width(first,layer);local last=first+1
        while last<56 and width(last,layer)==span do last=last+1 end
        local x=2.5-span/32;local y=0.25+layer/16;local z=1.5+first/16
        local color=layer<2 and "#6D4A36" or (layer==9 and "#D0A06A" or "#A7774B")
        if layer<2 or first<2 or last>54 then
            box({x,y,z},{span/16,1/16,(last-first)/16},color)
        else
            box({x,y,z},{1/16,1/16,(last-first)/16},color)
            box({2.5+span/32-1/16,y,z},{1/16,1/16,(last-first)/16},color)
        end
        first=last
    end
end
-- Two slim crosswise seats and a dark walking sole, without filling the cockpit.
for _,first in ipairs({14,37}) do for z=first,first+3 do
    local span=width(z,7)-2
    box({2.5-span/32,0.6875,1.5+z/16},{span/16,1/16,1/16},"#C5AA7D")
end end
box({2.1875,0.375,2.25},{0.625,1/16,2},"#835C43")
for _,x in ipairs({1.75,3.1875}) do box({x,0.625,2.875},{1/16,0.125,0.75},"#547D85",true) end
local files={hull="blocktemplates/"..s.name.."_hull.x",oar="blocktemplates/"..s.name.."_oar.x"}
s:exportVoxelX(files.hull,"hull",{pivot={2.5,0.75,3.25}})
s:group("oar_source")
-- Oarlock pivot at source x=6; grip points inward and blade outward along X.
box({5.625,0.75,2},{1.5,1/16,1/16},"#B98B58")
box({7.125,0.75,1.9375},{0.4375,0.125,0.1875},"#E0BD83")
s:exportVoxelX(files.oar,"oar_source",{pivot={6,0.78125,2.03125}})
s:group("pond")
s:terrain({position={7,-2,2},dimensions={7,1,7},blockId=68})
s:terrain({position={7,-1,2},dimensions={7,1,7},blockId=68})
s:terrain({position={8,-1,3},dimensions={5,1,5},blockId=76})
s:group("dock")
s:surface({position={5,0,5},dimensions={2,1,4},blockId=81})
s:block({position={5,0,5},blockId=267,color="#A7774B"})
s:block({position={5,0,8},blockId=267,color="#A7774B"})
s:group("movie")
s:movie({name="row",position={0,0,10},duration=2})
local specs={{name="hull",file=files.hull,offset={0,0,0},meters={1.5,0.625,3.5}},
    {name="left_oar",file=files.oar,offset={-0.6875,0.09375,0},meters={1.9375,0.125,0.1875},side=-1},
    {name="right_oar",file=files.oar,offset={0.6875,0.09375,0},meters={1.9375,0.125,0.1875},side=1}}
local actors,joints={},{}
for _,part in ipairs(specs) do
    s:actor("row",{name=part.name,filename=part.file,position={10.5+part.offset[1],0.25+part.offset[2],5.5+part.offset[3]},scale=1,animId=0})
    local keys={}
    for i=0,8 do
        local time=i/4;local phase=i*math.pi/4
        local values={position={10.5+part.offset[1],0.25+part.offset[2]+0.03125*math.sin(phase),5.5+part.offset[3]},anim=0}
        if part.side then
            local angle=(part.side<0 and math.pi or 0)+part.side*0.35*math.sin(phase)
            local dip=-0.35*math.sin(phase)
            local sy,cy,sz,cz=math.sin(angle/2),math.cos(angle/2),math.sin(dip/2),math.cos(dip/2)
            local q={sy*sz,sy*cz,cy*sz,cy*cz}
            values.bones={root={rotation=q}};keys[#keys+1]={time=time,rotation=q}
        end
        s:keyframe("row",part.name,time,values)
    end
    actors[#actors+1]={name=part.name,expectedMeters=part.meters,bone=part.side and "root",rotationKeys=keys}
    if part.side then joints[#joints+1]={actor=part.name,parent="hull",offset=part.offset} end
end
s:seek("row",0)
wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p) local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i]) end;return v end
return {name=s.name,origin=s.origin,groups=groups,files=files,blocksize=one[1]-base[1],
    overview={eye=view({14,3,0}),lookat=view({9.75,0.25,5.5})},
    detail={eye=view({14,2.5,2}),lookat=view({10.5,0.375,5.5})},
    animation={moviePosition=s:position({0,0,10}),times={0,0.25,0.5,0.75,1,1.25,1.5,1.75,2},motion="articulated",actors=actors,joints=joints}}
