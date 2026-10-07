'use strict';

// Native integrated acceptance fixtures. Every pair differs only in helper strategy.
const families = [
  {family:'林边村站',ground:'Grass',wall:'Oak_Wood_Planks',wood:'Oak_Wood',leaves:'Oak_Leaves',road:'Gravel',plant:'Fern'},
  {family:'沙漠庭院',ground:'Sand',wall:'Sandstone',wood:'Jungle_Wood',leaves:'Jungle_Leaves',road:'Sandstone',plant:'DeadBush'},
  {family:'雪地驿站',ground:'Snow',wall:'Spruce_Wood_Planks',wood:'Spruce_Wood',leaves:'Spruce_Leaves',road:'StoneBrick',plant:'DeadBush'},
  {family:'河岸桥村',ground:'Grass',wall:'Oak_Wood_Planks',wood:'Birch_Wood',leaves:'Birch_Leaves',road:'Gravel',plant:'Reed',river:true},
  {family:'城市路口',ground:'Grass',wall:'StoneBrick',wood:'Oak_Wood',leaves:'Cherry_Blossoms',road:'StoneBrick',plant:'Red_Rose'}
];
const kinds = [['mixed','or','and','delay','button'],['mixed','or','and','fanout','long'],['mixed','or','and','delay','button'],['mixed','or','and','fanout','long'],['mixed','or','and','delay','long']];
const catalog=[];
for(let f=0;f<5;f++) for(let v=0;v<5;v++) for(const strategy of ['cell','span']) {
  const id=catalog.length+1;
  const params={...families[f],width:5+2*(v%3),depth:5+(v%3),streetWidth:2+(v%3),houseZ:15+(v%2),roofAxis:v%2?'z':'x',hillHeight:1+(v%3),treeHeights:[4+(v%2),6+(v%2),8+(v%2)],seed:7100+f*31+v,roofColor:['#587c57','#b28a52','#607b96','#8b6255','#51717d'][f],roofColor2:'#716568'};
  const name=`Round${String(id).padStart(2,'0')}`;
  catalog.push({id,name,sceneName:name,family:families[f].family,pairId:`F${f+1}V${v+1}`,strategy,variant:v+1,kind:kinds[f][v],params,brief:`${families[f].family}：两栋${params.width}×${params.depth}m小屋，${params.streetWidth}m连通街道，${params.roofAxis}轴半格屋顶，${params.hillHeight}m起伏与${params.treeHeights.join('/')}m植被；${kinds[f][v]}原生机关；${strategy}构建。`});
}
function lua(v) {
  if(v===null||v===undefined)return 'nil';
  if(typeof v==='string')return JSON.stringify(v);
  if(typeof v==='number'||typeof v==='boolean')return String(v);
  if(Array.isArray(v))return `{${v.map(lua).join(',')}}`;
  return `{${Object.entries(v).map(([k,x])=>`[${lua(k)}]=${lua(x)}`).join(',')}}`;
}
function bracket(s){let eq='====';while(s.includes(`]${eq}]`))eq+='=';return `[${eq}[${s}]${eq}]`;}
function roofBoxes(c,x,z) {
  const p=c.params,axis=p.roofAxis,span=axis==='x'?p.width:p.depth,n=Math.floor(span/2),boxes=[];
  // Odd widths have a ridge; even depths have two adjoining final stairs.
  for(let i=0;i<n;i++)for(const side of [0,1]) {
    const k=side===0?i:span-1-i,hi=side===0?k+.5:k;
    if(axis==='x')boxes.push({position:[x+k,3+i,z],dimensions:[1,.5,p.depth]},{position:[x+hi,3+i+.5,z],dimensions:[.5,.5,p.depth]});
    else boxes.push({position:[x,3+i,z+k],dimensions:[p.width,.5,1]},{position:[x,3+i+.5,z+hi],dimensions:[p.width,.5,.5]});
  }
  if(span%2)boxes.push({position:axis==='x'?[x+n,3+n,z]:[x,3+n,z+n],dimensions:axis==='x'?[1,.5,p.depth]:[p.width,.5,1]});
  return boxes;
}
const compact=`local info=s:inspect();local groups,total={},0
local B=commonlib.gettable("MyCompany.Aries.Game.BlockEngine")
local nativeSnapshot={};local staticStale=0
for name,g in pairs(info.groups)do
 local stale=0;local list={};for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end;list[#list+1]=m end
 table.sort(list,function(a,b)local aa,bb=a.position,b.position;for k=1,3 do if aa[k]~=bb[k]then return aa[k]<bb[k]end end;return false end)
 local hash=17;for _,m in ipairs(list)do local q=m.position;for _,v in ipairs({q[1]-s.origin[1],q[2]-s.origin[2],q[3]-s.origin[3],B:GetBlockId(unpack(q)),B:GetBlockData(unpack(q))})do hash=(hash*65599+v+4096)%2147483647 end end
 groups[name]={count=#g.members,stale=stale,bounds=g.bounds};total=total+#g.members
 if name~="logic"and name~="river_water"then staticStale=staticStale+stale;if name~="west_roof"then nativeSnapshot[name]={count=#g.members,hash=hash}end end
end`;
function buildSource(c) {
 const p=c.params;
 return `local cfg=${lua(c)}
local p=cfg.params
local s=createScene({name=cfg.name,dimensions={40,16,40},terrainDepth=2})
local cells,owners,halfOwners={},{},{}
local function key(x,y,z)return x..":"..y..":"..z end
local function cell(g,x,y,z,id,data,override)
 local k=key(x,y,z);local old=cells[k]
 if old and not override then assert(old.g==g and old.id==id and old.data==(data or 0),"planned carrier conflict "..k);return end
 cells[k]={g=g,x=x,y=y,z=z,id=id,data=data or 0}
end
local function cub(g,x,y,z,w,h,d,id)for yy=y,y+h-1 do for zz=z,z+d-1 do for xx=x,x+w-1 do cell(g,xx,yy,zz,id)end end end end
-- Final supporting-ground ownership is resolved before writing any native cell.
for z=0,39 do for x=0,39 do cell("ground",x,-1,z,p.ground)end end
local roadLocal={};local bridgeLocal,waterLocal,containmentLocal={},{},{}
local function paving(g,x,z,w,d,id)for zz=z,z+d-1 do for xx=x,x+w-1 do cell(g,xx,-1,zz,id,0,true);if g=="roads"then roadLocal[#roadLocal+1]={xx,-1,zz}end end end end
paving("roads",18,0,p.streetWidth,32,p.road)
paving("roads",3,10,31,p.streetWidth,p.road)
local doors={}
local function house(name,x,z)
 paving(name.."_floor",x,z,p.width,p.depth,p.wall)
 local doorX=x+math.floor(p.width/2)
 paving("roads",doorX,10+p.streetWidth,1,z-(10+p.streetWidth),p.road)
 for dz=0,p.depth-1 do for dx=0,p.width-1 do if dx==0 or dx==p.width-1 or dz==0 or dz==p.depth-1 then
  for y=0,2 do if not(dx==math.floor(p.width/2) and dz==0 and y<2)then
   local id=p.wall;if y==1 and (dx==0 or dx==p.width-1)and dz==2 then id="GlassPane" end
   cell(name.."_walls",x+dx,y,z+dz,id)
  end end
 end end end
 -- Fill triangular end walls only below the stair carriers; no hollow gables.
 local span=p.roofAxis=="x" and p.width or p.depth
 for k=0,span-1 do local rise=math.min(k,span-1-k)
  for y=3,2+rise do
   if p.roofAxis=="x"then cell(name.."_gable",x+k,y,z,p.wall);cell(name.."_gable",x+k,y,z+p.depth-1,p.wall)
   else cell(name.."_gable",x,y,z+k,p.wall);cell(name.."_gable",x+p.width-1,y,z+k,p.wall)end
  end
 end
 doors[#doors+1]={name=name,position={doorX,0,z},clearance={{doorX,0,z},{doorX,1,z},{doorX,0,z-1},{doorX,1,z-1},{doorX,0,z+1},{doorX,1,z+1}},widthMeters=1,heightMeters=2}
end
house("west",3,p.houseZ);house("east",24,p.houseZ)
-- Bounded relief is separate from entrances and logic.
local reliefFootprint=0
for z=25,30 do for x=0,10 do local raw=p.hillHeight*math.max(0,1-((x-4)/6)^2-((z-28)/4)^2);local h=raw>0 and math.ceil(raw)or 0;if h>0 then reliefFootprint=reliefFootprint+1;cub("relief",x,0,z,1,h,1,p.ground=="Snow" and "Snow_Block" or p.ground)end end end
local function tree(name,x,z,h)
 cub(name,x,0,z,1,h-1,1,p.wood)
 for y=h-3,h-1 do local r=y==h-1 and 1 or 2
  for dz=-r,r do for dx=-r,r do if dx*dx+dz*dz<=r*r+1 and not(dx==0 and dz==0 and y<h-1)then cell(name,x+dx,y,z+dz,p.leaves)end end end
 end
end
tree("plant_short",4,4,p.treeHeights[1]);tree("plant_mid",32,4,p.treeHeights[2]);tree("plant_tall",35,25,p.treeHeights[3])
for _,q in ipairs({{10,4},{12,5},{29,8},{34,8}})do cell("plant_border",q[1],0,q[2],p.plant)end
if p.river then
 -- Fully enclosed finite channel. Existing bank cells plus explicit solid bed.
 for z=6,8 do for x=12,26 do cell("river_bed",x,-2,z,"StoneBrick");cell("river_water",x,-1,z,"Still_Water",0,true);waterLocal[#waterLocal+1]={x,-1,z};containmentLocal[#containmentLocal+1]={x,-2,z}end end
 for x=11,27 do containmentLocal[#containmentLocal+1]={x,-1,5};containmentLocal[#containmentLocal+1]={x,-1,9}end
 for z=6,8 do containmentLocal[#containmentLocal+1]={11,-1,z};containmentLocal[#containmentLocal+1]={27,-1,z}end
 for x=18,18+p.streetWidth-1 do for z=6,8 do cell("bridge",x,0,z,"Oak_Wood_Planks");bridgeLocal[#bridgeLocal+1]={x,0,z}end end
 -- Native lower slabs make 0.5m approaches to the one-block bridge deck.
end
local inputs,outputs,rows={},{},{}
local function put(x,y,z,id,data) rows[#rows+1]={x+8,y,z+33,id,data or 0}end
local function support(x,z)put(x,0,z,143)end
local function input(x,y,z,id,data)put(x,y,z,id,data);inputs[#inputs+1]={x+8,y,z+33}end
local function lamp(x,y,z)put(x,y,z,199);outputs[#outputs+1]={x+8,y,z+33}end
local function wire(x,y,z)put(x,y,z,189)end
local function repeater(x,y,z,dir,setting)put(x,y,z,197,dir+4*(setting-1))end
local kind=cfg.kind
if kind=="lamp"or kind=="button"or kind=="or"then
 for x=0,4 do support(x,2)end;lamp(0,1,2);for x=1,3 do wire(x,1,2)end
 if kind=="or"then wire(4,1,2);support(4,1);support(4,3);input(4,1,1,190,5);input(4,1,3,190,5)
 else input(4,1,2,kind=="button"and 105 or 190,5)end
elseif kind=="and"or kind=="mixed"then
 local dz=kind=="mixed"and 1 or 0
 for x=0,4 do support(x,1+dz)end;support(4,dz);support(4,2+dz)
 for _,q in ipairs({{4,1,0},{3,1,1},{4,1,1},{4,1,2}})do put(q[1],q[2],q[3]+dz,143)end
 lamp(0,1,1+dz);wire(1,1,1+dz);put(2,1,1+dz,191,1)
 put(4,2,dz,192,5);put(4,2,2+dz,192,5);wire(3,2,1+dz);wire(4,2,1+dz)
 if kind=="and"then input(5,1,0,190,3);input(5,1,2,190,3)
 else input(5,1,3,190,3);repeater(5,1,1,0,1);for x=6,9 do support(x,1)end;for x=6,8 do wire(x,1,1)end;input(9,1,1,190,5);support(8,0);input(8,1,0,190,5)end
elseif kind=="fanout"then
 for x=1,5 do for z=1,5 do support(x,z)end end;input(1,1,3,190,5);for x=2,5 do wire(x,1,3)end;for _,z in ipairs({1,2,4,5})do wire(5,1,z)end;support(5,0);support(5,6);lamp(5,1,0);lamp(5,1,6)
elseif kind=="long"then
 for x=0,24 do support(x,1)end;input(0,1,1,190,5);for x=1,11 do wire(x,1,1)end;repeater(12,1,1,1,1);for x=13,23 do wire(x,1,1)end;lamp(24,1,1)
elseif kind=="delay"then
 input(0,1,1,190,5);support(0,1);for _,x in ipairs({1,3,5,7})do lamp(x,0,1);wire(x,1,1)end;for _,x in ipairs({2,4,6})do support(x,1);repeater(x,1,1,1,4)end
else error("unknown logic")end
for _,r in ipairs(rows)do cell("logic",r[1],r[2],r[3],r[4],r[5])end
local ordered={};for _,v in pairs(cells)do ordered[#ordered+1]=v end
table.sort(ordered,function(a,b)if a.y~=b.y then return a.y<b.y elseif a.z~=b.z then return a.z<b.z else return a.x<b.x end end)
local helperCalls=0;local i=1
while i<=#ordered do
 local a=ordered[i];local length=1
 if cfg.strategy=="span"then while ordered[i+length]do local b=ordered[i+length];if b.g~=a.g or b.id~=a.id or b.data~=a.data or b.y~=a.y or b.z~=a.z or b.x~=a.x+length then break end;length=length+1 end end
 s:group(a.g);helperCalls=helperCalls+1
 if a.y==-1 then s:surface({position={a.x,0,a.z},dimensions={length,1,1},blockId=a.id,data=a.data})
 elseif a.y<0 then s:terrain({position={a.x,a.y,a.z},dimensions={length,1,1},blockId=a.id,data=a.data})
 else s:box({position={a.x,a.y,a.z},dimensions={length,1,1},blockId=a.id,data=a.data})end
 i=i+length
end
s:group("west_roof");s:halfBlocks({blockId="ColorBlock",color=p.roofColor,boxes=${lua(roofBoxes(c,3,p.houseZ))}})
s:group("east_roof");s:halfBlocks({blockId="ColorBlock",color=p.roofColor2,boxes=${lua(roofBoxes(c,24,p.houseZ))}})
s:group("benches");s:halfBlocks({blockId="Oak_Wood_Planks",boxes={{position={14,0,17},dimensions={1,0.5,3}},{position={14,0.5,17},dimensions={0.5,0.5,3}},{position={22,0,17},dimensions={1,0.5,3}},{position={22.5,0.5,17},dimensions={0.5,0.5,3}}}})
if p.river then s:group("bridge_approaches");s:halfBlocks({blockId="Oak_Wood_Planks",boxes={{position={18,0,5},dimensions={p.streetWidth,0.5,1}},{position={18,0,9},dimensions={p.streetWidth,0.5,1}}}})end
for _,d in ipairs(doors)do s:group(d.name.."_door");s:door({position=d.position,data=1,open=true})end
s:save()
${compact}
local function absolute(points)local a={};for _,q in ipairs(points)do a[#a+1]=s:position(q)end;return a end
local roadFinal={};local seenRoad={};for _,q in ipairs(roadLocal)do local k=key(q[1],q[2],q[3]);if not seenRoad[k]then seenRoad[k]=true;if p.river and q[3]>=6 and q[3]<=8 then q={q[1],0,q[3]}end;roadFinal[#roadFinal+1]=q end end
for _,d in ipairs(doors)do d.localPosition=d.position;d.position=s:position(d.position);d.clearance=absolute(d.clearance)end
return {name=cfg.name,sceneName=cfg.name,id=cfg.id,pairId=cfg.pairId,strategy=cfg.strategy,family=cfg.family,params=p,kind=kind,logic=kind=="mixed"and "E AND (A OR B)"or kind=="and"and "A AND B"or kind=="or"and "A OR B"or "A",groups=groups,total=total,origin=s.origin,nativeSnapshot=nativeSnapshot,staticStale=staticStale,reliefFootprint=reliefFootprint,water=absolute(waterLocal),containment=absolute(containmentLocal),bridge=absolute(bridgeLocal),ports={kind=kind,inputs=absolute(inputs),outputs=absolute(outputs)},inputs=absolute(inputs),outputs=absolute(outputs),doorways=doors,road=absolute(roadFinal),helperCalls=helperCalls+5+(p.river and 1 or 0),cameras={overview={eye=s:cameraPoint({48,34,-17}),lookat=s:cameraPoint({20,2,20})},entry={eye=s:cameraPoint({8,1.75,11}),lookat=s:cameraPoint({3+math.floor(p.width/2),1,p.houseZ+1})},logic={eye=s:cameraPoint({20,10,29}),lookat=s:cameraPoint({14,1,36})}},overview={eye=s:cameraPoint({48,34,-17}),lookat=s:cameraPoint({20,2,20})},entry={eye=s:cameraPoint({8,1.75,11}),lookat=s:cameraPoint({3+math.floor(p.width/2),1,p.houseZ+1})}}
`;
}
function inspectSource(name){return `local s=createScene({name=${lua(name)},resume=true})\n${compact}\nreturn {name=s.name,sceneName=s.name,origin=s.origin,groups=groups,total=total,nativeSnapshot=nativeSnapshot,staticStale=staticStale,artifacts=info.artifacts}`;}
function revisionSource(c,buildResult){
 const updated={...c,params:{...c.params,roofColor:'#aa594f'}};
 return `local s=createScene({name=${lua(c.name)},resume=true})
local info=s:inspect();local target=assert(info.groups.west_roof,"missing roof")
for _,m in ipairs(target.members)do assert(not m.stale,"stale roof")end
for name,g in pairs(info.groups)do if name~="logic"and name~="river_water"then for _,m in ipairs(g.members)do assert(not m.stale,"stale static group "..name)end end end
${compact}
local beforeNativeSnapshot=nativeSnapshot
s:remove("west_roof");s:group("west_roof")
s:halfBlocks({blockId="ColorBlock",color="#aa594f",boxes=${lua(roofBoxes(c,3,c.params.houseZ))}})
s:save(${bracket(buildSource(updated))})
${compact}
return {name=s.name,sceneName=s.name,origin=s.origin,groups=groups,total=total,nativeSnapshot=nativeSnapshot,beforeNativeSnapshot=beforeNativeSnapshot,afterNativeSnapshot=nativeSnapshot,staticStale=staticStale,changed="west_roof",color="#aa594f",artifacts=info.artifacts}`;
}
module.exports={catalog,buildSource,revisionSource,inspectSource,roofBoxes};
