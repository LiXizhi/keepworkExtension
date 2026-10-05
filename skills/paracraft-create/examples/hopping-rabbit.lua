-- Small stylized rabbit: 0.453125 m long, 0.46875 m to upright ear tips.
-- Three rigid color-only parts; shared hop translation and independently tilting ears.
local s=createScene({name="hopping_rabbit",dimensions={7,3,7}})
local fur,cream,pink,eyes="#B19B81","#DDD2BB","#C69091","#32353A"
s:group("body")
s:ellipsoid({position={1.890625,0.046875,1.875},dimensions={0.21875,0.1875,0.28125},size=1/64,color=fur})
s:ellipsoid({position={1.90625,0.125,1.796875},dimensions={0.1875,0.1875,0.1875},size=1/64,color=fur,replace=true})
s:ellipsoid({position={1.953125,0.125,2.140625},dimensions={0.09375,0.09375,0.09375},size=1/64,color=cream,replace=true})
for _,x in ipairs({1.875,2.03125})do
 s:ellipsoid({position={x,0.03125,2.015625},dimensions={0.09375,0.125,0.15625},size=1/64,color=fur,replace=true})
end
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
for _,x in ipairs({1.890625,2.046875})do box({x,0,2.03125},{0.0625,0.046875,0.09375},cream)end
for _,x in ipairs({1.9375,2.03125})do
 box({x,0,1.828125},{0.03125,0.046875,0.109375},cream)
 box({x,0.03125,1.90625},{0.03125,0.109375,0.03125},fur)
end
box({1.96875,0.171875,1.796875},{0.0625,0.0625,0.03125},cream)
box({1.984375,0.21875,1.78125},{0.03125,0.015625,0.03125},pink)
for _,x in ipairs({1.921875,2.0625})do box({x,0.25,1.84375},{1/64,1/64,1/64},eyes)end
s:voxelBoxes({boxes=boxes,size=1/64,replace=true})
local files={body="blocktemplates/"..s.name.."_body_v2.x"}
s:exportVoxelX(files.body,"body",{pivot={2,0,2}})
for _,side in ipairs({"left","right"})do
 local x=side=="left" and 4 or 5
 s:group(side)
 s:voxelBoxes({size=1/64,replace=true,boxes={
  {position={x,0,2},dimensions={3/64,10/64,2/64},color=cream},
  {position={x+1/64,10/64,2},dimensions={1/64,2/64,2/64},color=cream},
  {position={x+1/64,2/64,2},dimensions={1/64,8/64,1/64},color=pink},
 }})
 files[side]="blocktemplates/"..s.name.."_"..side..".x"
 s:exportVoxelX(files[side],side,{pivot={x+3/128,0,2+1/64}})
end
s:group("movie");s:movie({name="rabbit",position={0,0,6},duration=4})
local specs={
 {name="body",offset={0,0,0},expectedMeters={0.25,0.3125,0.453125}},
 {name="left",offset={-3/64,18/64,-8/64},expectedMeters={3/64,12/64,2/64},sign=1},
 {name="right",offset={3/64,18/64,-8/64},expectedMeters={3/64,12/64,2/64},sign=-1},
}
local actors,joints={},{}
-- First two seconds: restrained idle. Last two: whole-rabbit toy-like hop.
local frames={{0,0,0.08},{0.5,0,0.22},{1,0,0.08},{1.5,0,0.22},{2,0,0.08},
 {2.25,0.0625,0.16},{2.5,0.125,0.24},{2.75,0.0625,0.16},{3,0,0.08},
 {3.5,0,0.08},{4,0,0.08}}
for _,part in ipairs(specs)do
 local p={2+part.offset[1],part.offset[2],5+part.offset[3]}
 s:actor("rabbit",{name=part.name,filename=files[part.name],position=p,scale=1})
 local keys,trackFrames={},{}
 for _,k in ipairs(frames)do
  local values={position={p[1],p[2]+k[2],p[3]},anim=0}
  if part.sign then
   local half=k[3]*part.sign/2;local q={0,0,math.sin(half),math.cos(half)}
   values.bones={root={rotation=q}};keys[#keys+1]={time=k[1],rotation=q}
  end
  trackFrames[#trackFrames+1]={seconds=k[1],values=values}
 end
 s:keyframes("rabbit",part.name,trackFrames)
 actors[#actors+1]={name=part.name,expectedMeters=part.expectedMeters,bone=part.sign and "root",rotationKeys=keys}
 if part.sign then joints[#joints+1]={actor=part.name,parent="body",offset=part.offset}end
end
s:seek("rabbit",0);wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,blocksize=one[1]-base[1],
 overview={eye=view({2.9,1.4,3.4}),lookat=view({2,0.25,5})},
 detail={eye=view({2.55,0.8,4.15}),lookat=view({2,0.25,5})},
 animation={moviePosition=s:position({0,0,6}),times={0,0.5,1,2,2.25,2.5,2.75,3,4},
 motion="articulated",actors=actors,joints=joints},
 clips={{name="idle",from=0,to=2},{name="hop",from=2,to=4}},rigidHop=true}
