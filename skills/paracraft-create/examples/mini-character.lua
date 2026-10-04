-- A 1.75 m color-voxel character. Editable component groups and separate controls.
local creation=commonlib.gettable("MyCompany.Aries.Game.Code.Creation")
assert(creation.Scene and creation.Scene.bindBone and creation.VoxelExport and creation.VoxelExport.EmbedClips,
    "unsupported_capability: miniature rig clip export; update the Paracraft creation library")
local s=createScene({name="mini_character",dimensions={12,5,8}})
local function box(p,d,c) s:box({position=p,dimensions=d,size=0.0625,color=c}) end
s:group("body")
-- Shoes, separate trouser legs, shirt and a face with quiet contrasting details.
for _,x in ipairs({2.125,2.5}) do
    box({x,0,2.125},{0.25,0.125,0.375},"#373F50")
    box({x,0.125,2.1875},{0.25,0.625,0.25},"#3B526F")
end
box({2.125,0.75,2.1875},{0.625,0.625,0.25},"#559E94")
box({2.3125,1.3125,2.125},{0.25,0.0625,0.0625},"#E9C8A6")
box({2.125,1.375,2.125},{0.625,0.3125,0.375},"#E9C8A6")
box({2.125,1.6875,2.125},{0.625,0.0625,0.375},"#514236")
-- Eyes/mouth are separate surface voxels, so no texture assets are needed.
box({2.25,1.5625,2.0625},{0.0625,0.0625,0.0625},"#303340")
box({2.5625,1.5625,2.0625},{0.0625,0.0625,0.0625},"#303340")
box({2.375,1.4375,2.0625},{0.125,0.0625,0.0625},"#B97F70")
box({2,1.25,2.1875},{0.125,0.125,0.25},"#559E94")
box({2.75,1.25,2.1875},{0.125,0.125,0.25},"#559E94")
box({2.875,1.1875,2.1875},{0.125,0.1875,0.25},"#559E94")
box({2.875,0.875,2.1875},{0.125,0.3125,0.25},"#E9C8A6")
s:group("right_arm")
box({1.875,1.1875,2.1875},{0.125,0.1875,0.25},"#559E94")
box({1.875,0.875,2.1875},{0.125,0.3125,0.25},"#E9C8A6")
s:group("controls")
s:bone({name="root",position={2,0,1},direction=4,pivot={-0.0625,0.25,0.5}})
s:bone({name="right_arm",position={1,1,1},direction=4,pivot={0.5,-0.125,0.5}})
s:bindBone({position={2,0,1},groups={"body"},parentMode="none"})
s:bindBone({position={1,1,1},groups={"right_arm"},parent={2,0,1}})
local file="blocktemplates/"..s.name.."_rig.x"
local exported=s:exportVoxelX(file,{"body","right_arm"},{rig="controls",pivot={2.4375,0,2.25}})
s:group("movie")
s:movie({name="wave",position={6,0,5},duration=3})
s:actor("wave",{name="character",filename=file,position={5,0,3},scale=1,animId=0})
local keys={{time=0,rotation={0,0,0,1}},{time=0.5,rotation={0,0,-0.02617695,0.99965732}},
    {time=1,rotation={0,0,0,1}},{time=1.5,rotation={0,0,-0.90630779,0.42261826}},
    {time=2,rotation={0,0,-0.79335334,0.60876143}},{time=2.5,rotation={0,0,-0.90630779,0.42261826}},
    {time=3,rotation={0,0,0,1}}}
for _,key in ipairs(keys) do s:keyframe("wave","character",key.time,{bones={right_arm={rotation=key.rotation}}}) end
s:keyframe("wave","character",0,{anim=0})
s:keyframe("wave","character",1,{anim=1})
s:seek("wave",0)
local clipsFile="blocktemplates/"..s.name.."_clips.x"
local clips=s:exportVoxelX(clipsFile,{"body","right_arm"},{rig="controls",pivot={2.4375,0,2.25},
    animation={movie="wave",actor="character",loops={[0]=true,[1]=false}}})
-- Independent reload: ID keys only, no external bone keyframes.
s:group("verification")
s:movie({name="independent",position={6,0,6},duration=3})
s:actor("independent",{name="character",filename=clipsFile,position={8,0,3},scale=1,animId=0})
s:keyframe("independent","character",1,{anim=1})
s:seek("independent",0)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups) do local stale=0;for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds} end
local base=s:toWorld({8,0,3});local one=s:toWorld({9,0,3});local unit=one[1]-base[1]
local function view(p) return {base[1]+p[1]*unit,base[2]+p[2]*unit,base[3]+p[3]*unit} end
return {name=s.name,origin=s.origin,groups=groups,exported=exported,clips=clips,
    overview={eye=view({2,2,-4}),lookat=view({0,0.95,0})},
    detail={eye=view({2.5,2.4,-3}),lookat=view({0,0.95,0})},
    portrait={eye=view({-1.7,1.3,-2.7}),lookat=view({0,0.95,0})},
    side={eye=view({-2.8,1.3,1.6}),lookat=view({0,0.95,0})},
    animation={moviePosition=s.movies.independent.position,times={0,0.5,1,1.5,2,2.5,3},motion="articulated",
        actors={{name="character",expectedMeters={1.125,1.75,0.4375},bone="right_arm",embedded=true,rotationKeys=keys}}}}
