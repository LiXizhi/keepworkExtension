-- A small seated tabby: ~0.59 m including tail, 0.453125 m to pointed ears.
-- Two rigid color meshes and an editable tail-idle MovieBlock; no skinned gait.
local s=createScene({name="sitting_cat",dimensions={7,3,7}})
local fur,cream,pink,stripe,iris,eyes="#C2A67D","#E2D6B9","#C6938D","#7D6957","#95B0A8","#35413B"
s:group("body")
s:ellipsoid({position={1.921875,0.046875,1.921875},dimensions={0.15625,0.25,0.203125},size=1/64,color=fur})
s:ellipsoid({position={1.90625,0.21875,1.828125},dimensions={0.1875,0.15625,0.171875},size=1/64,color=fur,replace=true})
for _,x in ipairs({1.890625,2.015625})do
 s:ellipsoid({position={x,0.03125,1.984375},dimensions={0.09375,0.140625,0.125},size=1/64,color=fur,replace=true})
end
s:ellipsoid({position={1.953125,0.25,1.8125},dimensions={0.09375,0.0625,0.046875},size=1/64,color=cream,replace=true})
local boxes={}
local function box(p,d,c)boxes[#boxes+1]={position=p,dimensions=d,color=c}end
for _,x in ipairs({1.9375,2.03125})do
 box({x,0,1.921875},{0.03125,0.1875,0.046875},cream)
 box({x,0,1.875},{0.03125,0.03125,0.09375},cream)
end
for _,x in ipairs({1.90625,2.046875})do box({x,0,2.015625},{0.046875,0.03125,0.078125},cream)end
box({1.984375,0.28125,1.796875},{0.03125,0.015625,0.03125},pink)
for _,x in ipairs({1.9375,2.03125})do
 box({x,0.3125,1.859375},{0.03125,0.03125,1/64},iris)
 box({x+1/64,0.3125,1.84375},{1/64,0.03125,1/64},eyes)
end
for _,x in ipairs({1.921875,2.015625})do
 for row=0,5 do
  local inset=math.floor(row/2);local width=math.max(1,4-inset);
  box({x+inset/64,0.359375+row/64,1.875},{width/64,1/64,4/64},fur)
  if row>=1 and row<=4 then box({x+2/64,0.359375+row/64,1.875},{1/64,1/64,1/64},pink)end
 end
end
for _,x in ipairs({1.921875,2.0625})do for _,z in ipairs({1.984375,2.015625,2.046875})do
 box({x,0.109375,z},{1/64,0.078125,1/64},stripe)
end end
s:voxelBoxes({boxes=boxes,size=1/64,replace=true})
local files={body="blocktemplates/"..s.name.."_body.x",tail="blocktemplates/"..s.name.."_tail.x"}
s:exportVoxelX(files.body,"body",{pivot={2,0,2}})
s:group("tail")
s:voxelBoxes({size=1/64,replace=true,boxes={
 {position={4,0.0625,2},dimensions={3/64,3/64,12/64},color=fur},
 {position={4,0.09375,2.15625},dimensions={3/64,3/64,6/64},color=fur},
 {position={4,0.125,2.21875},dimensions={3/64,3/64,5/64},color=stripe},
}})
s:exportVoxelX(files.tail,"tail",{pivot={4+3/128,0.0625,2}})
s:group("movie");s:movie({name="idle",position={0,0,6},duration=2})
local specs={
 {name="body",offset={0,0,0},expectedMeters={0.21875,0.453125,0.328125}},
 {name="tail",offset={0,0.0625,0.09375},expectedMeters={3/64,7/64,19/64},axis=true},
}
local actors,joints={},{}
for _,part in ipairs(specs)do
 local p={2+part.offset[1],part.offset[2],5+part.offset[3]}
 s:actor("idle",{name=part.name,filename=files[part.name],position=p,scale=1})
 local frames,keys={},{}
 for _,k in ipairs({{0,0},{0.5,0.35},{1,0},{1.5,-0.35},{2,0}})do
  local values={position=p,anim=0}
  if part.axis then local q={0,math.sin(k[2]/2),0,math.cos(k[2]/2)};values.bones={root={rotation=q}};keys[#keys+1]={time=k[1],rotation=q}end
  frames[#frames+1]={seconds=k[1],values=values}
 end
 s:keyframes("idle",part.name,frames)
 actors[#actors+1]={name=part.name,expectedMeters=part.expectedMeters,bone=part.axis and "root",rotationKeys=keys}
 if part.axis then joints[#joints+1]={actor=part.name,parent="body",offset=part.offset}end
end
s:seek("idle",0);wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,blocksize=one[1]-base[1],
 overview={eye=view({2.9,1.3,3.5}),lookat=view({2,0.25,5.1})},
 detail={eye=view({2.6,0.85,4}),lookat=view({2,0.25,5.1})},
 animation={moviePosition=s:position({0,0,6}),times={0,0.25,0.5,1,1.5,2},motion="articulated",actors=actors,joints=joints}}
