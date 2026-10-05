-- ~0.55 m nose-to-rump small dog; floppy ears and four independently moving legs.
-- Rigid-limb trot in place, not knee IK or one file with embedded clip IDs.
local s=createScene({name="trotting_dog",dimensions={9,3,7}})
local fur,cream,ear,nose,collar="#B89166","#E8D6B6","#6F513B","#302E2B","#5D9F9B"
local unit=s:cameraPoint({1,0,0})[1]-s:cameraPoint({0,0,0})[1]
s:group("body")
s:ellipsoid({position={1.890625,0.1875,1.875},dimensions={0.21875,0.1875,0.34375},size=1/64,color=fur})
s:ellipsoid({position={1.890625,0.25,1.75},dimensions={0.203125,0.1875,0.203125},size=1/64,color=fur,replace=true})
s:voxelBoxes({size=1/64,replace=true,boxes={
 {position={1.9375,0.265625,1.6875},dimensions={0.125,0.078125,0.09375},color=cream},
 {position={1.96875,0.28125,1.671875},dimensions={0.0625,0.046875,0.015625},color=nose},
 {position={1.859375,0.265625,1.78125},dimensions={0.046875,0.140625,0.078125},color=ear},
 {position={2.078125,0.265625,1.78125},dimensions={0.046875,0.140625,0.078125},color=ear},
 {position={1.9375,0.34375,1.765625},dimensions={1/64,1/64,1/64},color=nose},
 {position={2.03125,0.34375,1.765625},dimensions={1/64,1/64,1/64},color=nose},
 {position={1.953125,0.21875,1.859375},dimensions={0.09375,0.09375,0.046875},color=cream},
 {position={1.90625,0.25,1.890625},dimensions={0.1875,0.03125,0.03125},color=collar},
}})
local files={body="blocktemplates/"..s.name.."_body.x",leg="blocktemplates/"..s.name.."_leg.x",tail="blocktemplates/"..s.name.."_tail.x"}
s:exportVoxelX(files.body,"body",{pivot={2,0,2}})
s:group("leg")
s:voxelBoxes({size=1/64,replace=true,boxes={
 {position={3.984375,0.03125,1.984375},dimensions={0.03125,0.203125,0.03125},color=fur},
 {position={3.96875,0,1.953125},dimensions={0.0625,0.046875,0.09375},color=cream},
}})
s:exportVoxelX(files.leg,"leg",{pivot={4,0.21875,2}})
s:group("tail")
s:voxelBoxes({size=1/64,replace=true,boxes={
 {position={6,0.28125,2},dimensions={0.03125,0.0625,0.0625},color=fur},
 {position={6,0.328125,2.046875},dimensions={0.03125,0.046875,0.0625},color=fur},
 {position={6,0.359375,2.09375},dimensions={0.03125,0.046875,0.0625},color=fur},
 {position={6,0.390625,2.140625},dimensions={0.03125,0.0625,0.046875},color=ear},
}})
s:exportVoxelX(files.tail,"tail",{pivot={6+1/64,0.28125,2}})
s:group("movie");s:movie({name="motions",position={0,0,6},duration=3})
local specs={
 {name="body",file="body",offset={0,0,0},expectedMeters={17/64,16/64,35/64}},
 {name="front_left",file="leg",offset={-4/64,14/64,-4/64},phase=1},
 {name="front_right",file="leg",offset={4/64,14/64,-4/64},phase=-1},
 {name="rear_left",file="leg",offset={-4/64,14/64,10/64},phase=-1},
 {name="rear_right",file="leg",offset={4/64,14/64,10/64},phase=1},
 {name="tail",file="tail",offset={0,20/64,13/64},expectedMeters={2/64,11/64,12/64}},
}
local actors,joints={},{}
for _,part in ipairs(specs)do
 local p={6+part.offset[1],part.offset[2],5+part.offset[3]}
 s:actor("motions",{name=part.name,filename=files[part.file],position=p,scale=1})
 local frames,keys={},{}
 for _,time in ipairs({0,0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.25,2.5,2.75,3})do
  local wave=math.sin(2*math.pi*time)
  local values={position=p,anim=0}
  if part.file~="body"then
   local angle=part.file=="leg"and(time>=1 and wave*part.phase*0.3 or 0)or wave*0.3
   local q=part.file=="leg"and{math.sin(angle/2),0,0,math.cos(angle/2)}or{0,math.sin(angle/2),0,math.cos(angle/2)}
   local lift=0
   if part.file=="leg"then
    -- Conservative toe bound stays safe between interpolated rotation keys too.
    -- This stylized cycle lifts stance toes slightly; it is not foot-contact IK.
    lift=3/64*math.abs(angle)
    if time>=1 then lift=lift+math.max(0,wave*part.phase)*1/64 end
   end
   values.bones={root={rotation=q,translation={0,lift,0}}}
   keys[#keys+1]={time=time,rotation=q}
  end
  frames[#frames+1]={seconds=time,values=values}
 end
 s:keyframes("motions",part.name,frames)
 actors[#actors+1]={name=part.name,expectedMeters=part.expectedMeters or {4/64,15/64,6/64},bone=part.file~="body"and"root",rotationKeys=keys}
 if part.file~="body"then joints[#joints+1]={actor=part.name,parent="body",offset=part.offset}end
end
s:seek("motions",0);wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,blocksize=unit,
 overview={eye=s:cameraPoint({6.8,0.9,3.8}),lookat=s:cameraPoint({6,0.25,5})},
 detail={eye=s:cameraPoint({6.65,0.6,4.1}),lookat=s:cameraPoint({6,0.25,5})},
 animation={moviePosition=s:position({0,0,6}),times={0,0.25,1,1.125,1.25,1.5,1.75,2,3},motion="articulated",actors=actors,joints=joints},
 clips={{name="idle",from=0,to=1},{name="trot",from=1,to=3}},rigidLimbs=true}
